/**
 * The first-person view.
 *
 * Three.js over the same protocol the 2D client proved out — prediction,
 * interpolation and reconciliation are unchanged and untouched. What is new is
 * only how the world is drawn and how the mouse is read.
 *
 * The terrain mesh is built from `@redoubt/core`'s heightfield, from the seed
 * the server sent. Nothing about the ground crosses the wire, and because both
 * sides compute it from the same pure function, the hill the player takes cover
 * behind is the same hill the server blocks rounds with. A renderer that
 * invented its own scenery would silently make cover a lie.
 *
 * Axes: the rules engine uses x/y on the ground with z up; Three.js is
 * y-up. The conversion happens here and only here — `worldToScene`.
 */

import * as THREE from "three";
import { Terrain, createTerrain, rules, type CoverVolume, type TeamId } from "@redoubt/core";
import { worldToScene, sceneYaw } from "./axes.js";
import { flashTexture, streakTexture } from "./flash.js";
import { GrassField } from "./grassField.js";
import { applyMacroVariation, buildGroundSurface, groundTint } from "./groundTexture.js";
import { buildCoverSurfaces, fitBoxUvs, type Surface } from "./buildingTextures.js";
import { SoldierModel, type SoldierRig } from "./soldierModel.js";
import { ScopeView } from "./scopeView.js";
import { VehicleModels, type VehicleRig } from "./vehicleModel.js";
import { Viewmodel } from "./viewmodel.js";
import type { ClientWorld } from "./world.js";

/** Metres per terrain mesh quad. Finer than the noise, coarser than a body. */
const MESH_RESOLUTION_M = 8;

/** How far the camera can see. The map is a kilometre across. */
const VIEW_DISTANCE_M = 1200;

const SKY = 0x8ea6bd;
/**
 * Fog has to start well beyond the range people actually fight at.
 *
 * The first values started it at 260 m, which is barely past the 200 m
 * engagement range — so every contact you were meant to be shooting at was
 * already half dissolved into the sky. Haze belongs at the far edge of the
 * map, not in the middle of a firefight.
 */
const FOG_NEAR = 700;
const FOG_FAR = 1600;

const TEAM_COLOUR: Record<TeamId, number> = { 0: 0x4da3ff, 1: 0xff6b57 };
const DOWNED_COLOUR = 0xc9a227;

/**
 * Friendly markers, and only friendly.
 *
 * At 300 m a soldier is three pixels; without a marker a teammate is
 * indistinguishable from a shrub, and you cannot tell whether the shape on the
 * ridge is your squad or theirs. Every game in this genre puts a nameplate on
 * friendlies for exactly that reason.
 *
 * Enemies deliberately get nothing. Spotting them is the skill the whole
 * engagement rests on, and drawing a marker over them would be a wallhack
 * shipped as a feature.
 */
const MARKER_HEIGHT_M = 2.3;
/**
 * Sprites scale in world units, so a marker that should look the same size on
 * screen has to grow *with* distance. The first version put a floor under that
 * — which inverted the intent: up close the floor won and the marker became a
 * billboard the size of a door hanging over your squadmate's head.
 */
const MARKER_SCREEN_SIZE = 0.014;
/** Close enough to see them properly: the marker is clutter at this range. */
const MARKER_HIDE_WITHIN_M = 25;

/** A tracer lives this long on screen after its round lands. */
const TRACER_LINGER_S = 0.12;

/**
 * Muzzle flashes out in the world.
 *
 * Short and small: this is a spotting cue, not a firework. Longer and it turns
 * into a lamp marking every shooter continuously, which would give away more
 * than actually watching for them does.
 */
const WORLD_FLASH_SECONDS = 0.06;
const WORLD_FLASH_SIZE_M = 0.55;
const WORLD_FLASH_POOL = 48;

/** A grenade is about the size of a fist; the fireball is not. */
const GRENADE_RADIUS_M = 0.07;
const BLAST_SECONDS = 0.55;
const BLAST_SIZE_M = 9;
const BLAST_POOL = 12;

interface WorldFlash {
  sprite: THREE.Sprite;
  left: number;
}

export interface Tracer {
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Seconds since the round was fired. */
  age: number;
  flightSeconds: number;
  friendly: boolean;
  /**
   * Fired by the player themselves.
   *
   * Drawn differently rather than just tagged: your own fire is the one thing
   * on screen you need constant feedback from, and at a hundred metres a
   * one-pixel line against bright ground is not feedback. WebGL cannot widen a
   * line — `linewidth` is ignored on every desktop driver — so "brighter and
   * thicker" has to come from somewhere other than the line.
   */
  own: boolean;
}

// The axis conversion lives in `axes.ts` so the grass field can use it without
// importing the renderer that draws it. Re-exported: everything that needs it
// has always reached for it here.
export { worldToScene, sceneYaw } from "./axes.js";

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly terrain: Terrain;
  /** Standing grass, kept under wherever the camera currently is. */
  private readonly grass: GrassField;

  private readonly bodies = new Map<number, THREE.Object3D>();
  /** Rigs for bodies drawn with the glTF model, keyed the same way. */
  private readonly rigs = new Map<number, SoldierRig>();
  private readonly walkPhase = new Map<number, number>();
  readonly soldiers = new SoldierModel();
  /** The player's own weapon. Parented to the camera, so it rides the view. */
  readonly viewmodel: Viewmodel;
  /** The magnified image inside the optic. Only drawn while aiming. */
  private readonly scope = new ScopeView();
  private scopeMagnification = 0;
  /** Last drawn position per player, so the walk cycle follows real motion. */
  private readonly lastSeen = new Map<number, { x: number; y: number }>();
  private readonly markers = new Map<number, THREE.Sprite>();
  private readonly structures = new Map<string, THREE.Object3D>();
  private readonly hulls = new Map<number, THREE.Group>();
  /** Rigs for hulls drawn with a real model, keyed the same way. */
  private readonly vehicleRigs = new Map<number, VehicleRig>();
  /** Wheel angle and last position per vehicle, so wheels turn with movement. */
  private readonly wheelAngle = new Map<number, number>();
  private readonly lastVehiclePos = new Map<number, { x: number; y: number }>();
  readonly vehicles = new VehicleModels();
  private readonly tracers: Tracer[] = [];
  private readonly tracerLines: THREE.LineSegments;
  private readonly enemyTracerLines: THREE.LineSegments;
  private readonly friendlyGeometry = new THREE.BufferGeometry();
  private readonly enemyGeometry = new THREE.BufferGeometry();
  /** Quads, not lines: see streakTexture. Pooled like everything else here. */
  private readonly ownStreaks: THREE.Mesh[] = [];
  /** Glowing heads for the player's own rounds, pooled like the flashes. */
  private readonly ownHeads: THREE.Sprite[] = [];
  private readonly maxTracers = 256;
  /** Grenades in the air, and the fireballs they leave. */
  private readonly grenadeMeshes = new Map<number, THREE.Mesh>();
  private readonly blasts: Array<{ sprite: THREE.Sprite; left: number }> = [];
  private nextBlast = 0;

  /** Muzzle flashes out in the world, one per shot anybody else fires. */
  private readonly flashes = new THREE.Group();
  private readonly worldFlashes: WorldFlash[] = [];
  private nextFlash = 0;

  constructor(canvas: HTMLCanvasElement, terrainSeed: number, mainBases: Array<{ x: number; y: number }>, mapSizeM: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, FOG_NEAR, FOG_FAR);

    this.camera = new THREE.PerspectiveCamera(HIP_FOV_DEG, 1, 0.1, VIEW_DISTANCE_M);
    this.viewmodel = new Viewmodel(this.camera);
    // The camera is not in the scene graph by default, and a child of an
    // unattached camera never gets its world matrix updated — so the weapon
    // would sit at the origin, a kilometre away, and never be seen.
    this.scene.add(this.camera);

    // The same terrain the server is adjudicating against, rebuilt from seed.
    this.terrain = createTerrain(terrainSeed, mainBases, mapSizeM);

    this.scene.add(this.buildTerrainMesh(mapSizeM, terrainSeed));
    // Standing blades for the near ground, where a painted mat is obviously
    // painted. Seeded off the terrain, so two clients that agree about the hill
    // agree about the grass on it as well.
    this.grass = new GrassField(this.terrain, terrainSeed);
    this.scene.add(this.grass.mesh);
    this.addLighting();

    // Two sets of lines rather than one, because a tracer's most useful
    // property is whose it is. The colour was already being decided — every
    // shot arrives tagged friendly or not — and then thrown away into a single
    // material, so outgoing and incoming fire looked identical. Being shot at
    // is the single most important thing the renderer can tell a player.
    this.tracerLines = this.buildTracerLines(this.friendlyGeometry, 0xffd27f);
    this.enemyTracerLines = this.buildTracerLines(this.enemyGeometry, 0xff6b4a);
    this.scene.add(this.tracerLines);
    this.scene.add(this.enemyTracerLines);
    this.buildOwnStreaks();
    this.buildOwnHeads();
    this.buildWorldFlashes();
    this.buildBlasts();
    this.scene.add(this.flashes);
  }

  /**
   * Narrow the field of view while aiming.
   *
   * Eased rather than snapped: an instant FOV change reads as a teleport, and
   * the ease is also what sells the weight of bringing a rifle up.
   */
  setAiming(aiming: boolean, dt: number, magnification = 1): void {
    // Magnification no longer squeezes the main camera. It drives the scope
    // image instead — see scopeView.ts. Zooming the whole view magnified the
    // weapon and the ground with it and left the player no peripheral vision
    // at all; a scope shows one magnified circle and leaves the rest alone.
    this.scopeMagnification = aiming ? magnification : 0;
    const target = aiming ? ADS_FOV_DEG : HIP_FOV_DEG;
    const rate = Math.min(1, dt * ADS_EASE_PER_S);
    this.camera.fov += (target - this.camera.fov) * rate;
    this.camera.updateProjectionMatrix();
  }

  /** How many grass clumps are standing around the camera. Debug aid. */
  get grassCount(): number {
    return this.grass.mesh.count;
  }

  /** How many player bodies are currently in the scene. Debug aid. */
  get bodyCount(): number {
    return this.bodies.size;
  }

  /** Where each body actually ended up in scene space. Debug aid. */
  debugBodies(): Array<{ id: number; pos: number[]; visible: boolean; inScene: boolean }> {
    return [...this.bodies].map(([id, object]) => ({
      id,
      pos: object.position.toArray().map((n) => Math.round(n * 10) / 10),
      visible: object.visible,
      inScene: object.parent === this.scene,
    }));
  }

  // -------------------------------------------------------------------------
  // Static scenery
  // -------------------------------------------------------------------------

  private buildTerrainMesh(mapSizeM: number, terrainSeed: number): THREE.Mesh {
    const segments = Math.round(mapSizeM / MESH_RESOLUTION_M);
    const geometry = new THREE.PlaneGeometry(mapSizeM, mapSizeM, segments, segments);
    // PlaneGeometry lies in the xy plane; stand it up and sample heights.
    geometry.rotateX(-Math.PI / 2);

    const surface = buildGroundSurface();
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const uv = geometry.attributes.uv as THREE.BufferAttribute;
    const tint = new Float32Array(position.count * 3);

    for (let i = 0; i < position.count; i++) {
      // Plane is centred on the origin; shift into map coordinates.
      const sceneX = position.getX(i) + mapSizeM / 2;
      const sceneZ = position.getZ(i) + mapSizeM / 2;
      const worldY = mapSizeM - sceneZ;
      position.setY(i, this.terrain.heightAt(sceneX, worldY));

      // The plane's own UVs span 0..1 over a kilometre, which would stretch one
      // tile of grass across the whole map. Rescaled here so a tile is a fixed
      // number of *metres*, the same way cover fits its textures.
      uv.setXY(i, (uv.getX(i) * mapSizeM) / surface.tileM, (uv.getY(i) * mapSizeM) / surface.tileM);

      // Patch colour, baked per vertex: one field drier than the next, and bare
      // earth on anything too steep to hold grass. Eight metres a vertex is far
      // coarser than the texture and far finer than the map, which is exactly
      // the scale the texture cannot vary at.
      const colour = groundTint(sceneX, worldY, this.terrain.normalAt(sceneX, worldY).z, terrainSeed);
      tint[i * 3] = colour.r;
      tint[i * 3 + 1] = colour.g;
      tint[i * 3 + 2] = colour.b;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(tint, 3));
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      map: surface.map,
      normalMap: surface.normalMap,
      // Ground is matt and never metal; a specular sheen on grass reads as wet
      // tarmac from any angle where the sun is behind you.
      roughness: 1,
      metalness: 0,
      vertexColors: true,
    });
    // Sharply oblique underfoot, so without anisotropy the mat smears into a
    // grey band from about ten metres out — the exact ground the player is
    // looking at most of the time.
    const anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    surface.map.anisotropy = anisotropy;
    surface.normalMap.anisotropy = anisotropy;
    applyMacroVariation(material, surface);

    const mesh = new THREE.Mesh(geometry, material);
    // Move the centred plane so its corner sits at the map origin.
    mesh.position.set(mapSizeM / 2, 0, -mapSizeM / 2);
    mesh.receiveShadow = false;
    return mesh;
  }

  /**
   * Buildings, walls and containers, drawn from the same volumes the server
   * blocks rounds with. Built once — none of it moves.
   */
  buildCover(cover: readonly CoverVolume[]): void {
    const surfaces = buildCoverSurfaces();
    const material = (surface: Surface): THREE.Material =>
      new THREE.MeshStandardMaterial({
        map: surface.map,
        normalMap: surface.normalMap,
        roughness: surface.roughness,
        metalness: surface.metalness,
      });

    // One material per surface, shared by every volume. The fitting to each
    // volume's real size happens in that volume's UVs — see `fitBoxUvs` — so
    // forty buildings still cost four textures.
    const walls: Record<CoverVolume["kind"], THREE.Material> = {
      building: material(surfaces.building),
      wall: material(surfaces.wall),
      container: material(surfaces.container),
    };
    const roofs: Record<CoverVolume["kind"], THREE.Material> = {
      // A building has a roof of its own; a wall's top is more wall, and a
      // container's lid is the same steel as its sides.
      building: material(surfaces.buildingRoof),
      wall: walls.wall,
      container: walls.container,
    };
    const tiles: Record<CoverVolume["kind"], number> = {
      building: surfaces.building.tileM,
      wall: surfaces.wall.tileM,
      container: surfaces.container.tileM,
    };

    for (const volume of cover) {
      const groundZ = this.terrain.heightAt(volume.x, volume.y);
      const width = volume.halfWidth * 2;
      const depth = volume.halfDepth * 2;
      const geometry = new THREE.BoxGeometry(width, volume.height, depth);
      fitBoxUvs(geometry, width, volume.height, depth, tiles[volume.kind]);

      // BoxGeometry's material slots run +x, -x, +y, -y, +z, -z. Only the +y
      // face is the roof; -y is on the ground and never seen.
      const skin = walls[volume.kind];
      const mesh = new THREE.Mesh(geometry, [
        skin,
        skin,
        roofs[volume.kind],
        skin,
        skin,
        skin,
      ]);
      mesh.position.copy(worldToScene(volume.x, volume.y, groundZ + volume.height / 2));
      this.scene.add(mesh);
    }
  }

  private addLighting(): void {
    // Low sun, so the relief actually reads as relief.
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.1);
    sun.position.set(-0.4, 0.8, 0.45).normalize();
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(SKY, 0x3a4030, 1.1));
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.scope.resize(width, height);
  }

  /**
   * Put the camera behind the player's eyes, looking where they are looking.
   *
   * `eyeHeightM` lets a mounted player sit higher — a truck cab is well above
   * where the same soldier's head would be on foot, and getting that wrong
   * makes driving feel like crawling.
   */
  placeCamera(
    pos: { x: number; y: number },
    yaw: number,
    pitch: number,
    eyeHeightM: number = rules.EYE_HEIGHT_M,
  ): void {
    const groundZ = this.terrain.heightAt(pos.x, pos.y);
    this.camera.position.copy(worldToScene(pos.x, pos.y, groundZ + eyeHeightM));

    // Yaw, then pitch about the *new* local axis, so no roll creeps in.
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(sceneYaw(yaw));
    this.camera.rotateX(pitch);
  }

  /** Sync the visible bodies with what the client believes is out there. */
  syncPlayers(
    world: ClientWorld,
    renderTick: number,
    selfId: number,
    team: TeamId,
    dt = 0,
  ): void {
    const seen = new Set<number>();

    for (const player of world.players.values()) {
      if (player.id === selfId) continue;
      if (player.status === "deploying") continue;
      // Riding in a vehicle: the body would be drawn at the vehicle's own
      // position, i.e. inside it. The vehicle is the thing to look at.
      if (player.mounted) continue;
      seen.add(player.id);

      let body = this.bodies.get(player.id);
      if (body === undefined) {
        // Prefer the model; fall back to primitives if it never loaded.
        const rig = this.soldiers.instantiate();
        if (rig !== null) {
          this.rigs.set(player.id, rig);
          body = rig.root;
        } else {
          body = this.makeBody();
        }
        this.bodies.set(player.id, body);
        this.scene.add(body);
      }

      const friendly = player.team === team;
      let marker = this.markers.get(player.id);
      if (friendly && marker === undefined) {
        marker = new THREE.Sprite(
          new THREE.SpriteMaterial({
            color: TEAM_COLOUR[player.team],
            depthTest: false,
            transparent: true,
            opacity: 0.9,
          }),
        );
        marker.renderOrder = 10;
        this.markers.set(player.id, marker);
        this.scene.add(marker);
      }

      const at = world.interpolate(player.track, renderTick);
      const groundZ = this.terrain.heightAt(at.x, at.y);
      const down = player.status === "downed";

      const previous = this.lastSeen.get(player.id);
      const moved = previous === undefined ? 0 : Math.hypot(at.x - previous.x, at.y - previous.y);
      this.lastSeen.set(player.id, { x: at.x, y: at.y });

      const rig0 = this.rigs.get(player.id);
      // A rigged soldier is put on the ground by its own death clip, so it
      // keeps its standing offset and is never tipped over by hand. The
      // primitive fallback has no such clip and is laid down the old way.
      const lieDown = down && rig0 === undefined;
      body.position.copy(
        worldToScene(at.x, at.y, groundZ + (lieDown ? DOWN_TORSO_HEIGHT_M : rules.TORSO_HEIGHT_M)),
      );
      body.rotation.set(0, sceneYaw(player.yaw) + (rig0?.facingOffset ?? 0), 0);

      // Soldiers do not collide with each other — they can and do stand in the
      // same spot — so anyone close enough to be *inside* the camera is hidden.
      // Otherwise a teammate who walks onto you fills the screen with the
      // inside of their own head.
      const fromCamera = body.position.distanceTo(this.camera.position);
      body.visible = fromCamera > BODY_HIDE_WITHIN_M;
      if (lieDown) {
        // Face down on the ground rather than a shrunken standing figure: a
        // casualty has to be findable, and its pose is the only cue.
        body.rotation.x = -Math.PI / 2;
      }

      const colour = down ? DOWNED_COLOUR : TEAM_COLOUR[player.team];
      const emissive = friendly ? 0x101820 : 0x200000;

      const rig = rig0;
      if (rig !== undefined) {
        // Standing, walking, running or dead — chosen from what the body
        // actually did this frame, not from a flag we set somewhere else.
        this.soldiers.advance(rig, dt, moved, !down);
        this.soldiers.tint(rig, colour, emissive);
      } else {
        if (!down) this.animate(body as THREE.Group, moved);
        for (const part of (body as THREE.Group).children) {
          if (part.name === "rifle") continue;
          const material = (part as THREE.Mesh).material as THREE.MeshLambertMaterial;
          material.color.setHex(colour);
          // Friend or foe is the most important thing to read instantly.
          material.emissive.setHex(emissive);
        }
      }

      if (marker !== undefined) {
        marker.position.copy(worldToScene(at.x, at.y, groundZ + MARKER_HEIGHT_M));
        const range = marker.position.distanceTo(this.camera.position);
        // Constant apparent size, and gone entirely once they are close enough
        // to simply look at.
        marker.visible = range > MARKER_HIDE_WITHIN_M;
        const size = range * MARKER_SCREEN_SIZE;
        marker.scale.set(size, size, 1);
        (marker.material as THREE.SpriteMaterial).color.setHex(
          down ? DOWNED_COLOUR : TEAM_COLOUR[player.team],
        );
      }
    }

    for (const [id, object] of this.bodies) {
      if (seen.has(id)) continue;
      this.scene.remove(object);
      this.bodies.delete(id);
      this.rigs.delete(id);
      this.walkPhase.delete(id);
    }
    for (const [id, marker] of this.markers) {
      if (seen.has(id)) continue;
      this.scene.remove(marker);
      this.markers.delete(id);
    }
  }

  /**
   * A soldier, built from primitives.
   *
   * A capsule was the honest shape — it is exactly what the server tests
   * rounds against — but at a glance it reads as a pill, not a person, and
   * "is that a man or a bush" is a question the player has to answer in about
   * a third of a second. Silhouette is information.
   *
   * The figure is deliberately kept *inside* the hit cylinder: shoulders at the
   * cylinder radius, nothing sticking out past it. A model wider than its own
   * hitbox teaches players to aim at edges that do not register.
   */
  private makeBody(): THREE.Group {
    const group = new THREE.Group();
    const skin = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const r = rules.BODY_RADIUS_M;

    const add = (
      geometry: THREE.BufferGeometry,
      x: number,
      y: number,
      z: number,
      name: string,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, skin);
      mesh.position.set(x, y, z);
      mesh.name = name;
      group.add(mesh);
      return mesh;
    };

    // Measured from the torso centre, which is what the server positions.
    add(new THREE.BoxGeometry(r * 1.7, 0.62, r * 1.0), 0, 0.16, 0, "torso");
    add(new THREE.SphereGeometry(0.115, 10, 8), 0, 0.58, 0, "head");
    // A helmet brim gives the head a front, so facing reads at distance.
    add(new THREE.CylinderGeometry(0.135, 0.135, 0.05, 10), 0, 0.63, -0.02, "helmet");

    add(new THREE.BoxGeometry(0.1, 0.5, 0.1), -r * 0.85, 0.14, 0, "armL");
    add(new THREE.BoxGeometry(0.1, 0.5, 0.1), r * 0.85, 0.14, 0, "armR");
    add(new THREE.BoxGeometry(0.13, 0.62, 0.13), -0.1, -0.46, 0, "legL");
    add(new THREE.BoxGeometry(0.13, 0.62, 0.13), 0.1, -0.46, 0, "legR");

    // Something rifle-shaped held across the chest — at range this is most of
    // what distinguishes a soldier from a civilian silhouette.
    const rifle = add(new THREE.BoxGeometry(0.07, 0.07, 0.62), 0.12, 0.2, -0.22, "rifle");
    (rifle.material as THREE.Material) = new THREE.MeshLambertMaterial({ color: 0x2b2b2b });

    group.userData.phase = 0;
    return group;
  }

  /**
   * A walk cycle, driven by how far the figure has actually moved.
   *
   * Tying the swing to distance rather than to a timer means legs never skate:
   * a soldier standing still stands still, and one being interpolated across a
   * gap walks at the speed the interpolation implies.
   */
  private animate(group: THREE.Group, movedM: number): void {
    const phase = ((group.userData.phase as number) ?? 0) + movedM * WALK_CYCLES_PER_M;
    group.userData.phase = phase;

    const swing = Math.sin(phase * Math.PI * 2) * 0.5;
    const legL = group.getObjectByName("legL");
    const legR = group.getObjectByName("legR");
    const armL = group.getObjectByName("armL");
    const armR = group.getObjectByName("armR");
    if (legL !== undefined) legL.rotation.x = swing;
    if (legR !== undefined) legR.rotation.x = -swing;
    if (armL !== undefined) armL.rotation.x = -swing * 0.6;
    if (armR !== undefined) armR.rotation.x = swing * 0.6;
  }

  /** Radios, habitats and rally points as simple blocks. */
  syncStructures(world: ClientWorld, team: TeamId, ridingIn: number | null = null): void {
    const seen = new Set<string>();

    const place = (
      key: string,
      x: number,
      y: number,
      height: number,
      size: number,
      colour: number,
    ): void => {
      seen.add(key);
      let object = this.structures.get(key);
      if (object === undefined) {
        object = new THREE.Mesh(
          new THREE.BoxGeometry(size, height, size),
          new THREE.MeshLambertMaterial({ color: colour }),
        );
        this.structures.set(key, object);
        this.scene.add(object);
      }
      const groundZ = this.terrain.heightAt(x, y);
      object.position.copy(worldToScene(x, y, groundZ + height / 2));
      ((object as THREE.Mesh).material as THREE.MeshLambertMaterial).color.setHex(colour);
    };

    for (const fob of world.fobs.values()) {
      place(`fob:${fob.id}`, fob.x, fob.y, 4, 1.2, TEAM_COLOUR[fob.team]);
    }
    for (const d of world.deployables.values()) {
      const height = d.kind === "habitat" ? 3 : 1.2;
      const size = d.kind === "habitat" ? 6 : 1.6;
      const colour = d.built ? TEAM_COLOUR[d.team] : 0x6b7785;
      place(`dep:${d.id}`, d.x, d.y, height, size, colour);
    }
    for (const r of world.rallies.values()) {
      place(`rally:${r.id}`, r.x, r.y, 1.4, 0.8, r.live ? 0x8fd0ff : 0x6b7785);
    }

    void team;

    this.syncVehicles(world, ridingIn);

    for (const [key, object] of this.structures) {
      if (seen.has(key)) continue;
      this.scene.remove(object);
      this.structures.delete(key);
    }
  }

  /**
   * Vehicles, as oriented hulls.
   *
   * Given their own path rather than the generic block helper because they are
   * the only structures that move and turn — and because a truck you can tell
   * the front of is a truck you can tell is driving at you.
   */
  private syncVehicles(world: ClientWorld, ridingIn: number | null): void {
    const seen = new Set<number>();

    for (const vehicle of world.vehicles.values()) {
      seen.add(vehicle.id);
      const spec = rules.VEHICLE_SPECS[vehicle.kind];

      let hull = this.hulls.get(vehicle.id);
      if (hull === undefined) {
        hull = new THREE.Group();
        const rig = this.vehicles.instantiate(vehicle.kind);
        if (rig !== null) {
          hull.add(rig.root);
          this.vehicleRigs.set(vehicle.id, rig);
        } else {
          // No model: the boxes it always had. A vehicle you cannot see is far
          // worse than a plain one.
          const body = new THREE.Mesh(
            new THREE.BoxGeometry(spec.halfLengthM * 2, spec.heightM * 0.7, spec.halfWidthM * 2),
            new THREE.MeshLambertMaterial({ color: 0xffffff }),
          );
          body.name = "body";
          body.position.y = spec.heightM * 0.35;
          hull.add(body);

          // A cab at one end, so the hull has a nose.
          const cab = new THREE.Mesh(
            new THREE.BoxGeometry(spec.halfLengthM * 0.7, spec.heightM * 0.5, spec.halfWidthM * 1.8),
            new THREE.MeshLambertMaterial({ color: 0x3a4048 }),
          );
          cab.name = "cab";
          cab.position.set(spec.halfLengthM * 0.6, spec.heightM * 0.78, 0);
          hull.add(cab);
        }

        this.hulls.set(vehicle.id, hull);
        this.scene.add(hull);
      }

      // The one you are sitting in is hidden, for the same reason your own
      // body is: the camera is inside it, and all you would see is the inside
      // of the cab. A real interior is modelling work M4 has not done.
      hull.visible = vehicle.id !== ridingIn;

      const groundZ = this.terrain.heightAt(vehicle.x, vehicle.y);
      hull.position.copy(worldToScene(vehicle.x, vehicle.y, groundZ));
      hull.rotation.y = sceneYaw(vehicle.heading);

      // Darkens as it takes damage, so a truck about to die looks like one.
      const wear = Math.max(0.25, vehicle.health);
      const rig = this.vehicleRigs.get(vehicle.id);
      if (rig !== undefined) {
        VehicleModels.tint(rig, TEAM_COLOUR[vehicle.team], wear);

        // Wheels turn by how far the hull actually moved, which is the same
        // reason the soldiers' legs do: a time-driven spin keeps going while
        // the truck is parked.
        const previous = this.lastVehiclePos.get(vehicle.id);
        const moved =
          previous === undefined
            ? 0
            : Math.hypot(vehicle.x - previous.x, vehicle.y - previous.y);
        this.lastVehiclePos.set(vehicle.id, { x: vehicle.x, y: vehicle.y });
        this.wheelAngle.set(
          vehicle.id,
          VehicleModels.spinWheels(rig, this.wheelAngle.get(vehicle.id) ?? 0, moved),
        );
      } else {
        const body = hull.getObjectByName("body") as THREE.Mesh | undefined;
        if (body !== undefined) {
          const material = body.material as THREE.MeshLambertMaterial;
          material.color.setHex(TEAM_COLOUR[vehicle.team]).multiplyScalar(wear);
        }
      }
    }

    for (const [id, hull] of this.hulls) {
      if (seen.has(id)) continue;
      this.scene.remove(hull);
      this.hulls.delete(id);
      this.vehicleRigs.delete(id);
      this.wheelAngle.delete(id);
      this.lastVehiclePos.delete(id);
    }
  }

  /** Queue a tracer for a round that was just fired. */
  addTracer(
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    flightSeconds: number,
    friendly: boolean,
  ): void {
    if (this.tracers.length >= this.maxTracers) this.tracers.shift();
    this.tracers.push({
      from: worldToScene(from.x, from.y, from.z),
      to: worldToScene(to.x, to.y, to.z),
      age: 0,
      flightSeconds: Math.max(flightSeconds, 1e-3),
      friendly,
      own: false,
    });
  }

  /**
   * Advance and draw tracers.
   *
   * Each is drawn as a short streak travelling along its own path at the speed
   * the round actually had — which is why the server bothers to send time of
   * flight. A tracer that teleported to its impact point would give away
   * nothing about range or lead.
   */
  private updateTracers(dt: number): void {
    const friendly = this.friendlyGeometry.attributes.position as THREE.BufferAttribute;
    const enemy = this.enemyGeometry.attributes.position as THREE.BufferAttribute;
    let friendlyVertex = 0;
    let enemyVertex = 0;
    let heads = 0;

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tracer = this.tracers[i]!;
      tracer.age += dt;
      if (tracer.age > tracer.flightSeconds + TRACER_LINGER_S) {
        this.tracers.splice(i, 1);
        continue;
      }
      const head = Math.min(1, tracer.age / tracer.flightSeconds);
      const streak = tracer.own ? OWN_STREAK_FRACTION : STREAK_FRACTION;
      const tail = Math.max(0, head - streak);

      const a = tracer.from.clone().lerp(tracer.to, tail);
      const b = tracer.from.clone().lerp(tracer.to, head);

      if (!tracer.own) {
        const buffer = tracer.friendly ? friendly : enemy;
        const vertex = tracer.friendly ? friendlyVertex : enemyVertex;
        if (vertex + 2 > this.maxTracers * 2) continue;
        buffer.setXYZ(vertex, a.x, a.y, a.z);
        buffer.setXYZ(vertex + 1, b.x, b.y, b.z);
        if (tracer.friendly) friendlyVertex += 2;
        else enemyVertex += 2;
        continue;
      }

      const quad = this.ownStreaks[heads];
      if (quad !== undefined) {
        orientStreak(quad, a, b, this.camera.position, OWN_STREAK_WIDTH_M);
        quad.visible = true;
      }
      // The round itself, riding the head of the beam. A travelling point of
      // light is what reads as a shot leaving the barrel; the streak behind it
      // only says where it has been.
      const sprite = this.ownHeads[heads];
      if (sprite !== undefined && head < 1) {
        sprite.position.copy(b);
        sprite.visible = true;
      }
      heads++;
    }

    for (let i = heads; i < this.ownHeads.length; i++) {
      const sprite = this.ownHeads[i];
      if (sprite !== undefined) sprite.visible = false;
      const quad = this.ownStreaks[i];
      if (quad !== undefined) quad.visible = false;
    }

    // Collapse the unused vertices onto a point so they draw nothing.
    for (let i = friendlyVertex; i < this.maxTracers * 2; i++) friendly.setXYZ(i, 0, -1000, 0);
    for (let i = enemyVertex; i < this.maxTracers * 2; i++) enemy.setXYZ(i, 0, -1000, 0);
    friendly.needsUpdate = true;
    enemy.needsUpdate = true;
    this.friendlyGeometry.setDrawRange(0, this.maxTracers * 2);
    this.enemyGeometry.setDrawRange(0, this.maxTracers * 2);
  }

  /**
   * Draw the grenades that are in the air.
   *
   * Small and dark, and deliberately unmarked: a grenade you can see is a
   * warning you earned by looking, not one the HUD handed you.
   */
  syncGrenades(world: ClientWorld): void {
    for (const [id, at] of world.grenades) {
      let mesh = this.grenadeMeshes.get(id);
      if (mesh === undefined) {
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(GRENADE_RADIUS_M, 8, 6),
          new THREE.MeshStandardMaterial({ color: 0x2f3a2a, roughness: 0.8 }),
        );
        this.grenadeMeshes.set(id, mesh);
        this.scene.add(mesh);
      }
      mesh.position.copy(worldToScene(at.x, at.y, at.z));
    }

    for (const [id, mesh] of this.grenadeMeshes) {
      if (world.grenades.has(id)) continue;
      this.scene.remove(mesh);
      this.grenadeMeshes.delete(id);
    }
  }

  /** A fireball where a grenade went off. */
  addBlast(at: { x: number; y: number; z: number }): void {
    const blast = this.blasts[this.nextBlast % this.blasts.length];
    if (blast === undefined) return;
    this.nextBlast++;
    blast.sprite.position.copy(worldToScene(at.x, at.y, at.z + 1));
    blast.sprite.visible = true;
    blast.left = BLAST_SECONDS;
  }

  private buildBlasts(): void {
    for (let i = 0; i < BLAST_POOL; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: flashTexture(),
          color: 0xffb257,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      sprite.visible = false;
      this.blasts.push({ sprite, left: 0 });
      this.scene.add(sprite);
    }
  }

  /**
   * Fade the fireballs, growing them as they go.
   *
   * Expanding while fading is what makes it read as an explosion rather than
   * as a lamp being switched off.
   */
  private updateBlasts(dt: number): void {
    for (const blast of this.blasts) {
      if (blast.left <= 0) continue;
      blast.left -= dt;
      const life = Math.max(0, blast.left / BLAST_SECONDS);
      blast.sprite.visible = life > 0;
      blast.sprite.scale.setScalar(BLAST_SIZE_M * (1.6 - life));
      (blast.sprite.material as THREE.SpriteMaterial).opacity = life;
    }
  }

  /**
   * Fade the muzzle flashes standing out in the world.
   *
   * These are how you find out where fire is coming from. Culling means you
   * only ever see flashes from shooters the server already told you about, so
   * this reveals nothing a player could not already have seen.
   */
  private updateWorldFlashes(dt: number): void {
    for (const flash of this.worldFlashes) {
      if (flash.left <= 0) continue;
      flash.left -= dt;
      const strength = Math.max(0, flash.left / WORLD_FLASH_SECONDS);
      flash.sprite.visible = strength > 0;
      (flash.sprite.material as THREE.SpriteMaterial).opacity = strength;
    }
  }

  /**
   * Mark a shot at its source.
   *
   * Pooled and reused round-robin: at two dozen soldiers firing there is no
   * point allocating a sprite per round, and the oldest flash is always the one
   * that has already faded.
   */
  addMuzzleFlash(at: { x: number; y: number; z: number }): void {
    const flash = this.worldFlashes[this.nextFlash % this.worldFlashes.length];
    if (flash === undefined) return;
    this.nextFlash++;
    flash.sprite.position.copy(worldToScene(at.x, at.y, at.z));
    flash.sprite.visible = true;
    flash.left = WORLD_FLASH_SECONDS;
    (flash.sprite.material as THREE.SpriteMaterial).opacity = 1;
  }

  /**
   * A tracer that leaves the player's own muzzle rather than their eye.
   *
   * The server reports every shot as coming from the shooter's eye, which is
   * right for everyone else and wrong for you: your eye is the camera, so the
   * streak would begin inside your own head while you watch a rifle that never
   * appears to fire anything.
   */
  addOwnTracer(
    to: { x: number; y: number; z: number },
    flightSeconds: number,
  ): void {
    if (this.tracers.length >= this.maxTracers) this.tracers.shift();
    this.tracers.push({
      from: this.viewmodel.muzzleScenePosition(new THREE.Vector3()),
      to: worldToScene(to.x, to.y, to.z),
      age: 0,
      flightSeconds: Math.max(flightSeconds, 1e-3),
      friendly: true,
      own: true,
    });
  }

  /**
   * Build the pool of beams for the player's own rounds.
   *
   * A plane whose local +y runs along the round's path, turned edge-on to face
   * the camera each frame. That is what lets it be thick: a line cannot be, and
   * a sprite cannot be pointed along a direction in world space.
   */
  private buildOwnStreaks(): void {
    for (let i = 0; i < OWN_HEAD_POOL; i++) {
      const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: streakTexture(),
          color: 0xffffff,
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      quad.visible = false;
      quad.frustumCulled = false;
      this.ownStreaks.push(quad);
      this.scene.add(quad);
    }
  }

  /** Build the pool of glowing heads for the player's own rounds. */
  private buildOwnHeads(): void {
    for (let i = 0; i < OWN_HEAD_POOL; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: flashTexture(),
          color: 0xfff0c0,
          transparent: true,
          opacity: 1,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      sprite.scale.setScalar(OWN_HEAD_SIZE_M);
      sprite.visible = false;
      this.ownHeads.push(sprite);
      this.scene.add(sprite);
    }
  }

  /** One pooled set of lines, so both sides share the draw path. */
  private buildTracerLines(
    geometry: THREE.BufferGeometry,
    colour: number,
    additive = false,
  ): THREE.LineSegments {
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(this.maxTracers * 2 * 3), 3),
    );
    const lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: colour,
        transparent: true,
        opacity: 0.9,
        ...(additive ? { blending: THREE.AdditiveBlending, depthWrite: false } : {}),
      }),
    );
    lines.frustumCulled = false;
    return lines;
  }

  /** Build the pool of world-space muzzle flashes. */
  private buildWorldFlashes(): void {
    for (let i = 0; i < WORLD_FLASH_POOL; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: flashTexture(),
          color: 0xffc766,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      sprite.scale.setScalar(WORLD_FLASH_SIZE_M);
      sprite.visible = false;
      this.flashes.add(sprite);
      this.worldFlashes.push({ sprite, left: 0 });
    }
  }

  render(dt: number): void {
    // Driven off the camera rather than off the player, because they are not
    // always the same thing — a spectator or a photograph moves the camera
    // directly, and grass that stayed behind at the player's feet would be a
    // bald circle in the middle of the shot.
    this.grass.update(this.camera.position.x, -this.camera.position.z, dt);
    this.updateTracers(dt);
    this.updateWorldFlashes(dt);
    this.updateBlasts(dt);
    this.renderer.render(this.scene, this.camera);

    // Only worth a second pass over the scene when there is actually
    // magnification to show. At 1x the scope would just be a smaller copy of
    // the view already on screen.
    if (this.scopeMagnification <= 1) return;
    // The weapon and the hands are children of the camera, so they are in the
    // scene the scope camera draws — without this they appear floating in the
    // middle of the magnified image, which is not what you see down a scope.
    this.viewmodel.setHiddenForScope(true);
    this.scope.render(this.renderer, this.scene, this.camera, this.scopeMagnification);
    this.viewmodel.setHiddenForScope(false);
  }
}

/** How much of its flight a tracer streak spans. */
const STREAK_FRACTION = 0.12;
/** The player's own rounds draw a longer streak, so they are legible in flight. */
const OWN_STREAK_FRACTION = 0.3;
/** The glowing round itself, drawn at the head of the player's own tracer. */
const OWN_HEAD_SIZE_M = 0.5;
/** How thick the player's own streak is drawn. A line would be one pixel. */
const OWN_STREAK_WIDTH_M = 0.16;
const OWN_HEAD_POOL = 24;

/** Field of view from the hip, and down the sights. */
const HIP_FOV_DEG = 75;
const ADS_FOV_DEG = 42;
const ADS_EASE_PER_S = 12;

/** Full leg swings per metre walked. */
const WALK_CYCLES_PER_M = 0.55;
/** Torso height of a body lying on the ground. */
const DOWN_TORSO_HEIGHT_M = 0.25;
/** Closer than this and a body is inside the camera, not in front of it. */
const BODY_HIDE_WITHIN_M = 1.1;

/**
 * Point a quad along a path and turn it edge-on to the camera.
 *
 * Local +y is laid along the round's direction of travel and the face is turned
 * to whichever side the camera is on, so the beam keeps its thickness from
 * every angle instead of vanishing when seen edge-on.
 */
function orientStreak(
  quad: THREE.Mesh,
  from: THREE.Vector3,
  to: THREE.Vector3,
  cameraPosition: THREE.Vector3,
  widthM: number,
): void {
  const along = to.clone().sub(from);
  const length = along.length();
  if (length < 1e-6) {
    quad.visible = false;
    return;
  }
  along.divideScalar(length);

  const mid = from.clone().add(to).multiplyScalar(0.5);
  const toCamera = cameraPosition.clone().sub(mid).normalize();
  // Degenerate when looking straight down the round's path; any perpendicular
  // will do there, because the quad is a dot on screen either way.
  let side = along.clone().cross(toCamera);
  if (side.lengthSq() < 1e-8) side = new THREE.Vector3(0, 1, 0).cross(along);
  side.normalize();
  const facing = side.clone().cross(along).normalize();

  quad.quaternion.setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(side, along, facing),
  );
  quad.position.copy(mid);
  quad.scale.set(widthM, length, 1);
}
