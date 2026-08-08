/**
 * Grass that stands up.
 *
 * A texture on the terrain fixes the ground at a distance and does nothing at
 * all for the two metres in front of the player's boots, where the surface is
 * seen almost edge-on and a painted mat is unmistakably paint. Real depth there
 * needs geometry, and geometry over a square kilometre is not affordable.
 *
 * So the field follows the camera. A few thousand clumps are kept within about
 * thirty metres and re-laid whenever the player walks far enough for the set to
 * be worth changing. Everything past that is the terrain texture's problem,
 * which at that range is what the eye reads anyway.
 *
 * Two properties make the seam invisible, and both matter:
 *
 *  - **Placement is a pure function of the cell it lands in**, not of when the
 *    field was last rebuilt. A clump therefore stays exactly where it was
 *    through every re-lay; only the outermost ring changes membership. Rolling
 *    fresh positions each time would make the whole field crawl underfoot.
 *  - **Clumps scale to nothing at the edge**, so a cell entering the set grows
 *    in from zero instead of popping into existence a metre from your face.
 *
 * Nothing here is authoritative and nothing here blocks anything: grass is not
 * cover, does not stop a round, and does not exist on the server at all.
 */

import * as THREE from "three";
import type { Terrain } from "@redoubt/core";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { worldToScene } from "./axes.js";
import { grassClumpTexture, groundTint } from "./groundTexture.js";

/** How tall a clump stands. Ankle height, matching the mat it grows out of. */
const CLUMP_HEIGHT_M = 0.38;
const CLUMP_WIDTH_M = 0.46;

/** Metres of ground per cell of the placement grid. */
const CELL_M = 2;

/** Clumps per cell. Density, in the end: six to a 2 m square. */
const CLUMPS_PER_CELL = 6;

/**
 * How far out clumps are placed, and where they start shrinking.
 *
 * Kept deliberately short. Past thirty metres a clump is a couple of pixels and
 * costs exactly as much as one underfoot, and the texture already covers that
 * range convincingly.
 */
const FIELD_RADIUS_M = 30;
const FADE_START_M = 21;

/**
 * How far the player must move before the field is re-laid.
 *
 * Re-laying is a few thousand height samples — cheap, but not free, and pinned
 * to the frame rate for no reason if it ran every frame. Two metres is under
 * half a second at a run, and because the outermost ring is faded to nothing
 * anyway, nothing visible changes when it happens.
 */
const RELAY_STEP_M = 2;

/** Blades do not grow on a cliff. Same threshold the ground tint goes bare at. */
const MAX_SLOPE_Z = 0.86;

/** Wind, in the only two numbers it needs: how fast, and how far. */
const WIND_SPEED = 1.7;
const WIND_SWAY_M = 0.07;
/** Metres per wave crest, so a gust crosses the field instead of pulsing. */
const WIND_WAVELENGTH_M = 9;

export class GrassField {
  readonly mesh: THREE.InstancedMesh;

  private readonly terrain: Terrain;
  private readonly seed: number;
  private readonly capacity: number;
  private readonly time = { value: 0 };

  /** Where the field was last laid out, or null if it never has been. */
  private laidAt: { x: number; y: number } | null = null;

  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly scale = new THREE.Vector3();
  private readonly colour = new THREE.Color();

  constructor(terrain: Terrain, seed: number) {
    this.terrain = terrain;
    this.seed = seed | 0;

    const across = Math.ceil(FIELD_RADIUS_M / CELL_M) * 2 + 1;
    this.capacity = across * across * CLUMPS_PER_CELL;

    const material = new THREE.MeshLambertMaterial({
      map: grassClumpTexture(),
      // Cut out, not blended: transparency here would need the whole field
      // sorted back to front every frame, and would still be wrong wherever two
      // clumps overlap.
      alphaTest: 0.45,
      side: THREE.DoubleSide,
    });
    this.shade(material);

    this.mesh = new THREE.InstancedMesh(clumpGeometry(), material, this.capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    // The field is centred on the camera by construction, so testing it against
    // the frustum every frame can only ever say yes — and the bounding sphere
    // it would test is the stale one from the last re-lay.
    this.mesh.frustumCulled = false;
  }

  /**
   * Keep the field under the player, and blow the wind along.
   *
   * `x`/`y` are in map metres — the camera's own position, not the scene's.
   */
  update(x: number, y: number, dt: number): void {
    this.time.value += dt;
    const moved =
      this.laidAt === null ? Infinity : Math.hypot(x - this.laidAt.x, y - this.laidAt.y);
    if (moved < RELAY_STEP_M) return;
    this.lay(x, y);
    this.laidAt = { x, y };
  }

  /**
   * Lay clumps over every cell within reach of a point.
   *
   * Slope and tint are sampled once per *cell*, not once per clump. That is not
   * a shortcut worth apologising for — grass either grows on a two-metre square
   * or it does not, and the tint it is asking about varies over forty-five
   * metres. It is, however, most of the cost: a surface normal is four height
   * samples, so per-clump sampling made a re-lay a 3 ms hitch every couple of
   * metres walked. Per cell it is well under one.
   */
  private lay(centreX: number, centreY: number): void {
    const cellX = Math.floor(centreX / CELL_M);
    const cellY = Math.floor(centreY / CELL_M);
    const reach = Math.ceil(FIELD_RADIUS_M / CELL_M);
    // Half a cell's diagonal: how far a clump can sit from its cell's centre.
    const corner = CELL_M * Math.SQRT1_2;
    let used = 0;

    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        // Reject the whole cell before touching the terrain, whenever even its
        // nearest corner is past the fade. That is the fifth of the square grid
        // that lies outside the circle, for four comparisons.
        const cellCentreX = (cellX + dx + 0.5) * CELL_M;
        const cellCentreY = (cellY + dy + 0.5) * CELL_M;
        const cellDistance = Math.hypot(cellCentreX - centreX, cellCentreY - centreY);
        if (cellDistance - corner >= FIELD_RADIUS_M) continue;

        const normal = this.terrain.normalAt(cellCentreX, cellCentreY);
        if (normal.z < MAX_SLOPE_Z) continue;
        const tint = groundTint(cellCentreX, cellCentreY, normal.z, this.seed);

        for (let k = 0; k < CLUMPS_PER_CELL; k++) {
          if (used >= this.capacity) break;
          const clump = clumpAt(cellX + dx, cellY + dy, k, this.seed);
          const distance = Math.hypot(clump.x - centreX, clump.y - centreY);
          const fade = fadeScale(distance);
          if (fade <= 0) continue;

          const z = this.terrain.heightAt(clump.x, clump.y);
          this.quaternion.setFromAxisAngle(this.up, clump.yaw);
          // The width goes on x *and* z: the clump is two quads crossed, and
          // the second one lies along z. Leaving that axis at one metre made
          // every tuft an eighteen-inch fan seen from one side and a blade of
          // grass from the other.
          const width = CLUMP_WIDTH_M * clump.size * fade;
          this.scale.set(width, CLUMP_HEIGHT_M * clump.size * fade, width);
          this.matrix.compose(
            worldToScene(clump.x, clump.y, z),
            this.quaternion,
            this.scale,
          );
          this.mesh.setMatrixAt(used, this.matrix);

          // Tinted like the ground it grows out of, and never quite uniformly:
          // a field of identically coloured clumps reads as plastic.
          this.colour.setRGB(tint.r * clump.shade, tint.g * clump.shade, tint.b * clump.shade);
          this.mesh.setColorAt(used, this.colour);
          used++;
        }
      }
    }

    this.mesh.count = used;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Two shader patches: how the blades move, and how they take the light.
   *
   * **Motion.** Displacement is proportional to height up the blade and phased
   * by where the clump stands, so a gust travels across the field rather than
   * every blade on the map twitching in unison. Cheap enough to be free, and it
   * is most of what makes the ground look alive rather than modelled.
   *
   * **Light.** The fragment normal is forced straight up, overriding both the
   * quad's own facing and the flip a double-sided surface does for back faces.
   * Without it half the field is pitch black: a clump is two crossed quads, one
   * of which always faces away from the sun, and the sun is low. Grass takes
   * the light the ground under it takes — that is the only reading that is
   * right from every angle you can walk around a tuft.
   */
  private shade(material: THREE.Material): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.time;
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <normal_fragment_begin>",
        `vec3 normal = vec3( 0.0, 1.0, 0.0 );
         vec3 nonPerturbedNormal = normal;`,
      );
      shader.vertexShader = shader.vertexShader
        .replace(
          "void main() {",
          `uniform float uTime;
           void main() {`,
        )
        .replace(
          "#include <begin_vertex>",
          // The clump geometry is a unit cube's worth — one metre every way,
          // scaled to size by the instance. So `transformed.y` is already the
          // fraction of the way up the blade, and the sway has to be divided by
          // the same width the instance is about to multiply it by, or tall
          // clumps would lean further than short ones for no reason.
          `#include <begin_vertex>
           {
             float up = clamp( transformed.y, 0.0, 1.0 );
             vec2 root = vec2( instanceMatrix[3][0], instanceMatrix[3][2] );
             float phase = ( root.x + root.y ) * ${(1 / WIND_WAVELENGTH_M).toFixed(4)}
                         + uTime * ${WIND_SPEED.toFixed(3)};
             float sway = up * up / ${CLUMP_WIDTH_M.toFixed(3)};
             transformed.x += sin( phase ) * sway * ${WIND_SWAY_M.toFixed(3)};
             transformed.z += cos( phase * 0.7 ) * sway * ${(WIND_SWAY_M * 0.6).toFixed(3)};
           }`,
        );
    };
    material.customProgramCacheKey = () => "grass-sway";
  }
}

/**
 * Where one clump of a cell stands, and how it is turned.
 *
 * A pure function of the cell, the index within it and the match seed — which
 * is the property the whole scheme rests on. Exported because that property is
 * worth a test: get it wrong and grass crawls under the player's feet.
 */
export function clumpAt(
  cellX: number,
  cellY: number,
  index: number,
  seed: number,
): { x: number; y: number; yaw: number; size: number; shade: number } {
  const a = hash3(cellX, cellY, index * 3 + 1 + seed);
  const b = hash3(cellX, cellY, index * 3 + 2 + seed);
  const c = hash3(cellX, cellY, index * 3 + 3 + seed);
  return {
    x: (cellX + a) * CELL_M,
    y: (cellY + b) * CELL_M,
    yaw: c * Math.PI * 2,
    // Two rolls reused: one generator per clump would be tidier and four times
    // the hashing, on the one function that runs a few thousand times a re-lay.
    size: 0.7 + b * 0.6,
    shade: 0.82 + a * 0.36,
  };
}

/**
 * How much of its full size a clump is drawn at, given its distance.
 *
 * One at the centre, nothing at the field's edge. The taper is what lets the
 * field be re-laid without anything appearing out of thin air.
 */
export function fadeScale(distanceM: number): number {
  if (distanceM <= FADE_START_M) return 1;
  if (distanceM >= FIELD_RADIUS_M) return 0;
  return (FIELD_RADIUS_M - distanceM) / (FIELD_RADIUS_M - FADE_START_M);
}

/**
 * Two quads crossed at right angles, rooted at the origin and one metre tall.
 *
 * Crossed so a clump has some thickness from every angle: a single quad turns
 * edge-on and vanishes as you walk around it. Normals are forced straight up
 * rather than out of the quad, so grass takes the light the ground under it
 * takes — shading blades by their own facing makes half of every clump black.
 */
function clumpGeometry(): THREE.BufferGeometry {
  const quad = new THREE.PlaneGeometry(1, 1);
  quad.translate(0, 0.5, 0);
  const crossed = quad.clone();
  crossed.rotateY(Math.PI / 2);

  const merged = mergeGeometries([quad, crossed]);
  const normal = merged.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < normal.count; i++) normal.setXYZ(i, 0, 1, 0);
  normal.needsUpdate = true;
  return merged;
}

/** Integer mixing, the same family the terrain noise uses. */
function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 0x27d4eb2d) + Math.imul(y, 0x165667b1) + Math.imul(z, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 1 | h);
  h = (h ^ (h + Math.imul(h ^ (h >>> 7), 61 | h))) >>> 0;
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}
