/**
 * The map view's ground, drawn from the heightfield the rules actually use.
 *
 * The map screen used to be a flat dark rectangle with a grid on it, which is
 * honest but tells you nothing about the ground you are about to fight over.
 * This paints it as an aerial photograph instead: relief shading from the real
 * surface normals, farmland worked out from slope and elevation, and buildings
 * from the very cover volumes the server stops rounds with.
 *
 * Every pixel is derived. Nothing is imported, and that is not only a licensing
 * convenience: the terrain is a pure function of the seed, so a photograph laid
 * over it would disagree with it. You would take cover behind a ridge in the
 * picture while the server traced your rounds through the ridge that is really
 * there. `scene3d.ts` makes the same argument for the 3D view — a renderer that
 * invents its own scenery makes cover a lie.
 *
 * What the terrain claims to be is what is drawn: `terrain.ts` describes
 * "rolling farmland, not mountains", so this is fields, hedgerows and stands of
 * woodland, not alpine rock.
 */

import { createTerrain, type CoverVolume, type MapDefinition, type Terrain } from "@redoubt/core";

/**
 * Raster detail, in pixels per map metre.
 *
 * The whole 1 km map is baked once into an offscreen image and then blitted at
 * whatever zoom the camera is at, because it never changes: the terrain is
 * fixed for the match and so is the cover. Two per metre is soft at the very
 * tightest zoom, which is what aerial imagery looks like anyway when you push
 * past its resolution.
 */
export const RASTER_PX_PER_M = 2;

/**
 * Spacing of the samples every smooth layer is built from.
 *
 * The finest octave of the terrain has a 62 m wavelength and the 3D view is
 * happy with an 8 m mesh, so 4 m loses nothing — and it is the difference
 * between 63 thousand height lookups and four million.
 */
export const SAMPLE_STEP_M = 4;

/**
 * Direction to the sun, in map axes: x east, y north, z up.
 *
 * Out of the top-left of the screen, as on every shaded relief map since they
 * were drawn by hand. Screen y grows south, so "up-left on screen" is negative
 * in both x and y. Sitting high keeps the shading readable rather than
 * theatrical — this has to be a map you can read, not a landscape painting.
 */
const SUN = normalise(-0.5, -0.5, 0.72);

/**
 * Ambient floor and direct sun.
 *
 * Weighted toward the sun: a hillshade probe of this terrain showed the relief
 * signal was there all along (the surface normal swings through 45°) but was
 * being out-shouted by the step in brightness between one field and the next.
 * The relief is the part of this image that carries information.
 */
const AMBIENT = 0.42;
const SUN_STRENGTH = 1;

/**
 * Vertical exaggeration used for the shading, and only for the shading.
 *
 * This is rolling farmland — 18 m of relief over a kilometre — so the true
 * surface normal is within a couple of degrees of straight up almost
 * everywhere, and shading it honestly produced an image with no visible relief
 * at all: a flat quilt. Every shaded-relief map ever printed exaggerates the
 * vertical for exactly this reason. The heights themselves are untouched, so
 * nothing that matters is distorted; the slope the *landcover* reads is taken
 * from the same exaggerated surface, because a scale on which no ground is
 * steep would never show bare earth anywhere either.
 */
const RELIEF_EXAGGERATION = 6;

/**
 * Fields are laid out on one lattice and then merged into each other.
 *
 * The first attempt varied the lattice *spacing* from place to place, which put
 * a visible 320 m grid of seams across the whole map — a worse artifact than
 * the uniform fields it was meant to cure, because farmland has no such grid.
 *
 * Merging instead keeps one seamless lattice and lets a cell hand itself to its
 * western or northern neighbour, so fields come out one to three cells in size
 * and in L shapes as well as rectangles. It is also a genuine partition: two
 * cells are in the same field or they are not, which is what makes it possible
 * to suppress the hedge between them.
 */
const FIELD_SIZE_M = 62;
const MERGE_CHANCE = 0.42;
/** How far field boundaries wander, so the patchwork is not graph paper. */
const FIELD_WOBBLE_M = 26;
/** Width of the hedge or track along a field boundary. */
const HEDGE_WIDTH_M = 3;

/** Cultivation striping: the plough lines that say "worked land" from above. */
const TILL_SPACING_M = 7;
const TILL_STRENGTH = 0.055;

/** Above this slope the soil stops holding and bare ground shows through. */
const BARE_SLOPE = 0.3;
/**
 * Woodland covers the map where its layer sits above this.
 *
 * Tuned by looking: at 0.58 the woods took nearly forty per cent of the map and
 * ran together into one connected mass, which is not farmland — it is forest
 * with clearings in it. Discrete copses over roughly a tenth of the ground is
 * what the terrain is claiming to be.
 */
const WOODLAND_THRESHOLD = 0.68;
/** How abruptly a wood gives way to the field beside it. */
const WOODLAND_EDGE = 30;

/**
 * Palette, in the muted register aerial photography actually has.
 *
 * The first attempt used saturated greens and browns and the result read as
 * camouflage fabric rather than land. Photographed from above through a few
 * hundred metres of air, farmland is grey-green and khaki; the chroma is much
 * lower than the colours look from the ground.
 */
const FIELD_TINTS: ReadonlyArray<readonly [number, number, number]> = [
  [106, 114, 88], // pasture
  [122, 126, 96], // young crop
  [142, 140, 112], // ripening
  [96, 104, 82], // dark pasture
  [158, 150, 122], // stubble
  [132, 116, 92], // ploughed earth
  [134, 130, 104], // rough grazing
  // Green repeated, because grass is what most of the ground is most of the
  // time. Weighting the palette evenly gave every field a different colour from
  // its neighbour, and a field of every colour at once is a quilt.
  [112, 118, 92],
  [102, 112, 86],
  [118, 124, 94],
  [110, 116, 90],
];
const WOODLAND = [68, 78, 62] as const;
const HEDGE = [74, 82, 64] as const;
/** A dirt farm track along a boundary, rather than a hedge. */
const TRACK = [154, 146, 126] as const;
const BARE = [148, 138, 118] as const;

/** Distance haze. A few per cent of the sky mixed in kills the vividness. */
const HAZE = [150, 158, 166] as const;
const HAZE_STRENGTH = 0.1;

/** Cover, from directly overhead: roofs, and the shadows they throw. */
const ROOF: Record<CoverVolume["kind"], readonly [number, number, number]> = {
  building: [158, 150, 138],
  wall: [122, 118, 110],
  container: [96, 108, 84],
};
const SHADOW = [12, 16, 20] as const;
const SHADOW_ALPHA = 0.45;
/** Shadow length per metre of height. Matches the sun's elevation. */
const SHADOW_PER_M = 0.55;
/** The sunlit edge along a roof's north and west sides. */
const ROOF_HIGHLIGHT = [255, 248, 232] as const;
const ROOF_HIGHLIGHT_ALPHA = 0.3;

/**
 * The smooth layers, all sampled on one coarse grid.
 *
 * Held as one object because every one of them is read per pixel and they all
 * share the same lattice — bundling them means one set of bilinear weights
 * serves all five reads instead of five.
 */
export interface GroundLayers {
  /** Samples per side. */
  readonly cols: number;
  readonly stepM: number;
  readonly height: Float32Array;
  /** Surface normal, from the height grid rather than more terrain lookups. */
  readonly normalX: Float32Array;
  readonly normalY: Float32Array;
  readonly normalZ: Float32Array;
  /** Field-boundary wander, one per axis. */
  readonly wobbleX: Float32Array;
  readonly wobbleY: Float32Array;
  /** Where trees stand. */
  readonly woodland: Float32Array;
  readonly minHeight: number;
  readonly maxHeight: number;
}

/**
 * Sample the terrain and the decorative layers onto the coarse grid.
 *
 * Normals come from finite differences over the grid rather than from
 * `terrain.normalAt`, which would cost four more height lookups per sample.
 * Over a 4 m step on 62 m features the two agree to well under a degree.
 */
export function sampleGround(terrain: Terrain, sizeM: number, seed: number): GroundLayers {
  const stepM = SAMPLE_STEP_M;
  const cols = Math.round(sizeM / stepM) + 1;
  const count = cols * cols;

  const height = new Float32Array(count);
  const normalX = new Float32Array(count);
  const normalY = new Float32Array(count);
  const normalZ = new Float32Array(count);
  const wobbleX = new Float32Array(count);
  const wobbleY = new Float32Array(count);
  const woodland = new Float32Array(count);

  let minHeight = Infinity;
  let maxHeight = -Infinity;

  for (let row = 0; row < cols; row++) {
    const y = row * stepM;
    for (let col = 0; col < cols; col++) {
      const x = col * stepM;
      const i = row * cols + col;
      height[i] = terrain.heightAt(x, y);
      // Read back rather than tracking the double: the array is float32, so the
      // stored value is rounded, and a range taken from the unrounded numbers
      // does not actually bound what is in the array.
      const h = height[i]!;
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;

      wobbleX[i] = (valueNoise(x, y, 140, seed ^ 0x51ed) - 0.5) * 2 * FIELD_WOBBLE_M;
      wobbleY[i] = (valueNoise(x, y, 140, seed ^ 0x2f9a) - 0.5) * 2 * FIELD_WOBBLE_M;
      // Two octaves at the scale actual copses are. The first pass used 260 m
      // and 90 m, which produced continent-shaped blobs that read as camouflage
      // splotches rather than as woods.
      woodland[i] =
        valueNoise(x, y, 150, seed ^ 0x7c31) * 0.62 +
        valueNoise(x, y, 52, seed ^ 0x19bd) * 0.38;
    }
  }

  // Normals in a second pass, so every neighbour it reads is already filled.
  for (let row = 0; row < cols; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const west = height[row * cols + Math.max(0, col - 1)]!;
      const east = height[row * cols + Math.min(cols - 1, col + 1)]!;
      const south = height[Math.max(0, row - 1) * cols + col]!;
      const north = height[Math.min(cols - 1, row + 1) * cols + col]!;
      const spanX = (col === 0 || col === cols - 1 ? 1 : 2) * stepM;
      const spanY = (row === 0 || row === cols - 1 ? 1 : 2) * stepM;
      const dzdx = ((east - west) / spanX) * RELIEF_EXAGGERATION;
      const dzdy = ((north - south) / spanY) * RELIEF_EXAGGERATION;
      const length = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
      normalX[i] = -dzdx / length;
      normalY[i] = -dzdy / length;
      normalZ[i] = 1 / length;
    }
  }

  return {
    cols,
    stepM,
    height,
    normalX,
    normalY,
    normalZ,
    wobbleX,
    wobbleY,
    woodland,
    minHeight,
    maxHeight,
  };
}

/**
 * Paint the ground into an RGBA buffer.
 *
 * Separate from the canvas work, and returning bytes rather than an `ImageData`,
 * so the expensive half can be measured and tested without a DOM.
 */
export function paintGround(
  layers: GroundLayers,
  sizeM: number,
  seed: number,
  pxPerM: number = RASTER_PX_PER_M,
): { pixels: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  const width = Math.round(sizeM * pxPerM);
  // Backed by an explicit ArrayBuffer: `ImageData` will not accept a view that
  // might be over shared memory, and the default constructor's type allows it.
  const pixels = new Uint8ClampedArray(new ArrayBuffer(width * width * 4));
  const relief = Math.max(1e-3, layers.maxHeight - layers.minHeight);

  for (let py = 0; py < width; py++) {
    const y = py / pxPerM;
    for (let px = 0; px < width; px++) {
      const x = px / pxPerM;
      const at = bilinear(layers, x, y);

      // Which cell this pixel is in, which field that cell belongs to, and how
      // close it is to the cell's edge. The boundary is crisp because the wander
      // is smooth and the quantisation is not: `floor` of a smooth field gives a
      // clean edge.
      const fx = (x + at.wobbleX) / FIELD_SIZE_M;
      const fy = (y + at.wobbleY) / FIELD_SIZE_M;
      const cellX = Math.floor(fx);
      const cellY = Math.floor(fy);
      const withinX = fx - cellX;
      const withinY = fy - cellY;
      const fieldHash = fieldOf(cellX, cellY, seed);
      const tint = FIELD_TINTS[(fieldHash >>> 0) % FIELD_TINTS.length]!;
      let r = tint[0];
      let g = tint[1];
      let b = tint[2];

      // Cultivation. Every field is worked along its own axis, and those lines
      // are one of the strongest cues that a picture is of farmland rather than
      // of a painted texture. A triangle wave rather than a sine: four million
      // sines is real money and nobody can tell them apart at this amplitude.
      const angle = ((fieldHash >>> 8) & 0xff) / 0xff * Math.PI;
      const along = x * Math.cos(angle) + y * Math.sin(angle);
      const phase = along / TILL_SPACING_M;
      const till = (Math.abs(phase - Math.floor(phase) - 0.5) * 4 - 1) * TILL_STRENGTH;

      // Trees, then hedges over them: a boundary runs along the edge of a wood
      // as readily as along the edge of a field.
      let canopy = 0;
      if (at.woodland > WOODLAND_THRESHOLD) {
        // Sharper than a smooth ramp, so a wood has an edge rather than a blur,
        // and speckled, because a canopy from above is individual crowns.
        canopy = Math.min(1, (at.woodland - WOODLAND_THRESHOLD) * WOODLAND_EDGE);
        const crowns = valueNoise(x, y, 9, seed ^ 0x4ab3) - 0.5;
        r += (WOODLAND[0] * (1 + crowns * 0.5) - r) * canopy;
        g += (WOODLAND[1] * (1 + crowns * 0.5) - g) * canopy;
        b += (WOODLAND[2] * (1 + crowns * 0.42) - b) * canopy;
      }
      // A hedge only where the cell across the boundary is a *different* field.
      // Inside a merged field the internal edge has to vanish, or the merging
      // buys nothing and the lattice shows through anyway.
      const distX = distanceToEdge(withinX) * FIELD_SIZE_M;
      const distY = distanceToEdge(withinY) * FIELD_SIZE_M;
      const edge = Math.min(distX, distY);
      if (edge < HEDGE_WIDTH_M) {
        const acrossX = distX <= distY ? (withinX < 0.5 ? cellX - 1 : cellX + 1) : cellX;
        const acrossY = distY < distX ? (withinY < 0.5 ? cellY - 1 : cellY + 1) : cellY;
        const across = fieldOf(acrossX, acrossY, seed);
        if (across !== fieldHash) {
          // Not every boundary is a hedge. Some are a farm track, some are a
          // wire fence that does not exist from three hundred metres up. Giving
          // every one of them the same dark line drew a net over the whole map,
          // which is the one thing farmland never looks like from above. Keyed
          // off both fields so the two sides of a boundary agree about it.
          const kind = (hash2(fieldHash ^ across, 0, seed) >>> 0) % 5;
          const density = 1 - edge / HEDGE_WIDTH_M;
          const boundary = kind < 3 ? HEDGE : kind === 3 ? TRACK : null;
          if (boundary !== null) {
            r += (boundary[0] - r) * density;
            g += (boundary[1] - g) * density;
            b += (boundary[2] - b) * density;
          }
        }
      }

      // Steep ground sheds its soil, read off the same exaggerated surface the
      // shading uses — on the true scale nothing here is steep at all.
      const slope = 1 - at.normalZ;
      if (slope > BARE_SLOPE) {
        const exposure = Math.min(1, (slope - BARE_SLOPE) * 3);
        r += (BARE[0] - r) * exposure;
        g += (BARE[1] - g) * exposure;
        b += (BARE[2] - b) * exposure;
      }

      // Higher ground reads drier, which is most of what gives an aerial its
      // sense of height before the shading is applied at all.
      const elevation = (at.height - layers.minHeight) / relief;
      const dryness = 1 + (elevation - 0.5) * 0.1;

      // Texture, in two registers. Correlated noise at a few metres is what
      // photographs of ground actually look like; uncorrelated speckle on top
      // is the sensor. Only the first is visible as texture — white noise alone
      // reads as television static, which was the other half of what was wrong.
      const mottle = (valueNoise(x, y, 5.5, seed ^ 0x1d7f) - 0.5) * 0.11;
      const speckle = (hashUnit(px, py, seed) - 0.5) * 0.045;

      const light =
        AMBIENT +
        SUN_STRENGTH * Math.max(0, at.normalX * SUN.x + at.normalY * SUN.y + at.normalZ * SUN.z);
      // Tilling is ploughed soil, not shading, so it does not apply under trees.
      const shade = light * dryness * (1 + mottle + speckle + till * (1 - canopy));

      const o = (py * width + px) * 4;
      // Haze last: it is between the camera and everything else.
      pixels[o] = r * shade + (HAZE[0] - r * shade) * HAZE_STRENGTH;
      pixels[o + 1] = g * shade + (HAZE[1] - g * shade) * HAZE_STRENGTH;
      pixels[o + 2] = b * shade + (HAZE[2] - b * shade) * HAZE_STRENGTH;
      pixels[o + 3] = 255;
    }
  }

  return { pixels, width, height: width };
}

/**
 * Bake the whole map into an offscreen canvas: ground, then cover on top.
 *
 * Called once per match. The result is a plain image the render loop can blit,
 * which is what keeps a per-pixel terrain render off the frame budget.
 */
export function buildSatelliteRaster(map: MapDefinition, terrainSeed: number): HTMLCanvasElement {
  const terrain = createTerrain(terrainSeed, [map.mainBases[0], map.mainBases[1]], map.sizeM);
  const layers = sampleGround(terrain, map.sizeM, terrainSeed);
  const painted = paintGround(layers, map.sizeM, terrainSeed);
  compositeCover(painted.pixels, painted.width, map.cover, RASTER_PX_PER_M);

  const canvas = document.createElement("canvas");
  canvas.width = painted.width;
  canvas.height = painted.height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return canvas;

  ctx.putImageData(new ImageData(painted.pixels, painted.width, painted.height), 0, 0);
  return canvas;
}

/**
 * Buildings, walls and containers, seen from above.
 *
 * Drawn from the same volumes the server blocks rounds with, so a building on
 * the map is a building in the world. Each throws a shadow away from the sun,
 * scaled by its own height — which is the cue that tells you at a glance
 * whether that rectangle is a wall you can shoot over or a barn you cannot.
 *
 * Composited into the pixel buffer rather than stroked onto a canvas, so that
 * the finished image is the product of one code path that runs anywhere. The
 * alternative — canvas calls here, arithmetic in `paintGround` — means the only
 * way to look at the result is to open a browser, and a renderer you cannot
 * inspect offline is a renderer you end up guessing about.
 */
export function compositeCover(
  pixels: Uint8ClampedArray,
  width: number,
  cover: readonly CoverVolume[],
  pxPerM: number = RASTER_PX_PER_M,
): void {
  // Shadows first, all of them, so no roof is ever painted under a neighbour's.
  for (const volume of cover) {
    const drop = volume.height * SHADOW_PER_M * pxPerM;
    fillRect(
      pixels,
      width,
      (volume.x - volume.halfWidth) * pxPerM + drop,
      (volume.y - volume.halfDepth) * pxPerM + drop,
      volume.halfWidth * 2 * pxPerM,
      volume.halfDepth * 2 * pxPerM,
      SHADOW,
      SHADOW_ALPHA,
    );
  }

  for (const volume of cover) {
    const left = (volume.x - volume.halfWidth) * pxPerM;
    const top = (volume.y - volume.halfDepth) * pxPerM;
    const w = volume.halfWidth * 2 * pxPerM;
    const h = volume.halfDepth * 2 * pxPerM;
    fillRect(pixels, width, left, top, w, h, ROOF[volume.kind], 1);
    // A lit edge along the two sides the sun is on. Cheap, and it is what stops
    // the roofs reading as flat stickers pasted over the fields.
    fillRect(pixels, width, left, top, w, 1, ROOF_HIGHLIGHT, ROOF_HIGHLIGHT_ALPHA);
    fillRect(pixels, width, left, top, 1, h, ROOF_HIGHLIGHT, ROOF_HIGHLIGHT_ALPHA);
  }
}

/** Source-over fill of an axis-aligned rectangle, clipped to the raster. */
function fillRect(
  pixels: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  w: number,
  h: number,
  colour: readonly [number, number, number] | readonly number[],
  alpha: number,
): void {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(width, Math.round(x + w));
  const y1 = Math.min(width, Math.round(y + h));
  const [r, g, b] = colour as readonly [number, number, number];

  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const o = (py * width + px) * 4;
      if (alpha >= 1) {
        pixels[o] = r;
        pixels[o + 1] = g;
        pixels[o + 2] = b;
      } else {
        pixels[o] = pixels[o]! + (r - pixels[o]!) * alpha;
        pixels[o + 1] = pixels[o + 1]! + (g - pixels[o + 1]!) * alpha;
        pixels[o + 2] = pixels[o + 2]! + (b - pixels[o + 2]!) * alpha;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sampling helpers
// ---------------------------------------------------------------------------

interface Sample {
  height: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  wobbleX: number;
  wobbleY: number;
  woodland: number;
}

const sample: Sample = {
  height: 0,
  normalX: 0,
  normalY: 0,
  normalZ: 1,
  wobbleX: 0,
  wobbleY: 0,
  woodland: 0,
};

/**
 * Read every layer at one position, with one set of weights.
 *
 * Fills and returns a single shared object rather than allocating: this runs
 * four million times per match and a fresh object each time is the difference
 * between a bake you do not notice and one you do.
 */
function bilinear(layers: GroundLayers, x: number, y: number): Sample {
  const { cols, stepM } = layers;
  const gx = Math.min(cols - 1.001, Math.max(0, x / stepM));
  const gy = Math.min(cols - 1.001, Math.max(0, y / stepM));
  const col = Math.floor(gx);
  const row = Math.floor(gy);
  const tx = gx - col;
  const ty = gy - row;

  const i00 = row * cols + col;
  const i10 = i00 + 1;
  const i01 = i00 + cols;
  const i11 = i01 + 1;

  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;

  // Written out rather than folded into a helper taking the array. A closure
  // here is seven calls per pixel and twenty-eight million per bake, and it
  // measured at four times the cost of the whole rest of the loop.
  const h = layers.height;
  const nx = layers.normalX;
  const ny = layers.normalY;
  const nz = layers.normalZ;
  const wx = layers.wobbleX;
  const wy = layers.wobbleY;
  const wood = layers.woodland;

  sample.height = h[i00]! * w00 + h[i10]! * w10 + h[i01]! * w01 + h[i11]! * w11;
  sample.normalX = nx[i00]! * w00 + nx[i10]! * w10 + nx[i01]! * w01 + nx[i11]! * w11;
  sample.normalY = ny[i00]! * w00 + ny[i10]! * w10 + ny[i01]! * w01 + ny[i11]! * w11;
  sample.normalZ = nz[i00]! * w00 + nz[i10]! * w10 + nz[i01]! * w01 + nz[i11]! * w11;
  sample.wobbleX = wx[i00]! * w00 + wx[i10]! * w10 + wx[i01]! * w01 + wx[i11]! * w11;
  sample.wobbleY = wy[i00]! * w00 + wy[i10]! * w10 + wy[i01]! * w01 + wy[i11]! * w11;
  sample.woodland =
    wood[i00]! * w00 + wood[i10]! * w10 + wood[i01]! * w01 + wood[i11]! * w11;
  return sample;
}

/** Distance from a fractional coordinate to the nearer of its two edges. */
function distanceToEdge(fraction: number): number {
  return Math.min(fraction, 1 - fraction);
}

/**
 * Which field a lattice cell belongs to, as a hash of the field's identity.
 *
 * A cell either keeps itself or hands itself to its western or northern
 * neighbour, and the chain is followed a bounded number of times. Bounded
 * because this runs per pixel and because a walk of two already gives fields of
 * one to three cells, in L shapes as well as rectangles — any longer and the
 * fields stop looking worked and start looking like spilled ink.
 *
 * Two cells are in the same field exactly when this returns the same value, so
 * it doubles as the test for whether a boundary between them should be drawn.
 */
function fieldOf(cellX: number, cellY: number, seed: number): number {
  let x = cellX;
  let y = cellY;
  for (let step = 0; step < MERGE_STEPS; step++) {
    if (hashUnit(x, y, seed ^ 0x6d2b) < MERGE_CHANCE) {
      x -= 1;
      continue;
    }
    if (hashUnit(x, y, seed ^ 0x3f19) < MERGE_CHANCE) {
      y -= 1;
      continue;
    }
    break;
  }
  return hash2(x, y, seed);
}

const MERGE_STEPS = 2;

function normalise(x: number, y: number, z: number): { x: number; y: number; z: number } {
  const length = Math.sqrt(x * x + y * y + z * z);
  return { x: x / length, y: y / length, z: z / length };
}

// ---------------------------------------------------------------------------
// Noise
//
// Local to the renderer rather than borrowed from core: this is texture, not
// terrain, and nothing here may feed back into anything the rules read. The
// bit constants are algorithm definition, like the ones in core's rng.ts.
// ---------------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let h = (x | 0) * 0x1f1f1f1f ^ (y | 0) * 0x85ebca6b ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) | 0;
}

/** Hashed to the unit interval. */
function hashUnit(x: number, y: number, seed: number): number {
  return (hash2(x, y, seed) >>> 0) / 4294967296;
}

/** Smooth value noise on a lattice of `cellM` metres, in the unit interval. */
function valueNoise(x: number, y: number, cellM: number, seed: number): number {
  const gx = x / cellM;
  const gy = y / cellM;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = fade(gx - x0);
  const ty = fade(gy - y0);

  const a = hashUnit(x0, y0, seed);
  const b = hashUnit(x0 + 1, y0, seed);
  const c = hashUnit(x0, y0 + 1, seed);
  const d = hashUnit(x0 + 1, y0 + 1, seed);

  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** Smoothstep, so lattice boundaries do not show as creases. */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}
