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
const MARKER_HEIGHT_M = 2.4;
const MARKER_MIN_SCREEN_SIZE = 0.9;

/** A tracer lives this long on screen after its round lands. */
const TRACER_LINGER_S = 0.12;

export interface Tracer {
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Seconds since the round was fired. */
  age: number;
  flightSeconds: number;
  friendly: boolean;
}

/** Rules-space (x east, y north, z up) to Three.js space (y up, -z north). */
export function worldToScene(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, z, -y);
}

/**
 * Rules yaw to a Three.js rotation about the up axis.
 *
 * Rules yaw is measured from +x (east) toward +y (north). A Three.js object
 * with no rotation faces -z, which under `worldToScene` is north — that is,
 * yaw = π/2. So the scene rotation is the world yaw less a quarter turn.
 *
 * Worth deriving rather than guessing: the first version of this had the sign
 * inverted, which put the camera exactly backwards and made the whole world
 * look like it was behind you.
 */
export function sceneYaw(worldYaw: number): number {
  return worldYaw - Math.PI / 2;
}

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly terrain: Terrain;

  private readonly bodies = new Map<number, THREE.Object3D>();
  /** Last drawn position per player, so the walk cycle follows real motion. */
  private readonly lastSeen = new Map<number, { x: number; y: number }>();
  private readonly markers = new Map<number, THREE.Sprite>();
  private readonly structures = new Map<string, THREE.Object3D>();
  private readonly tracers: Tracer[] = [];
  private readonly tracerLines: THREE.LineSegments;
  private readonly tracerGeometry = new THREE.BufferGeometry();
  private readonly maxTracers = 256;

  constructor(canvas: HTMLCanvasElement, terrainSeed: number, mainBases: Array<{ x: number; y: number }>, mapSizeM: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, FOG_NEAR, FOG_FAR);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, VIEW_DISTANCE_M);

    // The same terrain the server is adjudicating against, rebuilt from seed.
    this.terrain = createTerrain(terrainSeed, mainBases, mapSizeM);

    this.scene.add(this.buildTerrainMesh(mapSizeM));
    this.addLighting();

    const positions = new Float32Array(this.maxTracers * 2 * 3);
    this.tracerGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.tracerLines = new THREE.LineSegments(
      this.tracerGeometry,
      new THREE.LineBasicMaterial({ color: 0xffd27f, transparent: true, opacity: 0.9 }),
    );
    this.tracerLines.frustumCulled = false;
    this.scene.add(this.tracerLines);
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

  private buildTerrainMesh(mapSizeM: number): THREE.Mesh {
    const segments = Math.round(mapSizeM / MESH_RESOLUTION_M);
    const geometry = new THREE.PlaneGeometry(mapSizeM, mapSizeM, segments, segments);
    // PlaneGeometry lies in the xy plane; stand it up and sample heights.
    geometry.rotateX(-Math.PI / 2);

    const position = geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      // Plane is centred on the origin; shift into map coordinates.
      const sceneX = position.getX(i) + mapSizeM / 2;
      const sceneZ = position.getZ(i) + mapSizeM / 2;
      const worldY = mapSizeM - sceneZ;
      position.setY(i, this.terrain.heightAt(sceneX, worldY));
    }
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ color: 0x5c6b4a }),
    );
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
    const materials: Record<CoverVolume["kind"], THREE.Material> = {
      building: new THREE.MeshLambertMaterial({ color: 0x9a9384 }),
      wall: new THREE.MeshLambertMaterial({ color: 0x8a8578 }),
      container: new THREE.MeshLambertMaterial({ color: 0x6f7a5c }),
    };

    for (const volume of cover) {
      const groundZ = this.terrain.heightAt(volume.x, volume.y);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(volume.halfWidth * 2, volume.height, volume.halfDepth * 2),
        materials[volume.kind],
      );
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
  }

  /** Put the camera behind the player's eyes, looking where they are looking. */
  placeCamera(pos: { x: number; y: number }, yaw: number, pitch: number): void {
    const groundZ = this.terrain.heightAt(pos.x, pos.y);
    this.camera.position.copy(worldToScene(pos.x, pos.y, groundZ + rules.EYE_HEIGHT_M));

    // Yaw, then pitch about the *new* local axis, so no roll creeps in.
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(sceneYaw(yaw));
    this.camera.rotateX(pitch);
  }

  /** Sync the visible bodies with what the client believes is out there. */
  syncPlayers(world: ClientWorld, renderTick: number, selfId: number, team: TeamId): void {
    const seen = new Set<number>();

    for (const player of world.players.values()) {
      if (player.id === selfId) continue;
      if (player.status === "deploying") continue;
      seen.add(player.id);

      let body = this.bodies.get(player.id);
      if (body === undefined) {
        body = this.makeBody();
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

      body.position.copy(
        worldToScene(at.x, at.y, groundZ + (down ? DOWN_TORSO_HEIGHT_M : rules.TORSO_HEIGHT_M)),
      );
      body.rotation.set(0, sceneYaw(player.yaw), 0);
      if (down) {
        // Face down on the ground rather than a shrunken standing figure: a
        // casualty has to be findable, and its pose is the only cue.
        body.rotation.x = -Math.PI / 2;
      } else {
        this.animate(body as THREE.Group, moved);
      }

      const colour = down ? DOWNED_COLOUR : TEAM_COLOUR[player.team];
      for (const part of (body as THREE.Group).children) {
        if (part.name === "rifle") continue;
        const material = ((part as THREE.Mesh).material as THREE.MeshLambertMaterial);
        material.color.setHex(colour);
        // Friend or foe is the single most important thing to read instantly.
        material.emissive.setHex(friendly ? 0x101820 : 0x200000);
      }

      if (marker !== undefined) {
        marker.position.copy(
          worldToScene(at.x, at.y, groundZ + MARKER_HEIGHT_M),
        );
        // Scale with distance so the marker stays the same size on screen —
        // it is a label, and a label that shrinks to nothing is not one.
        const range = marker.position.distanceTo(this.camera.position);
        const size = Math.max(MARKER_MIN_SCREEN_SIZE, range * 0.012);
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
  syncStructures(world: ClientWorld, team: TeamId): void {
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
    for (const v of world.vehicles.values()) {
      // Deliberately smaller than it was: a 3 m cube at the vehicle spawn
      // swallowed every teammate standing beside it, which read as "there is
      // nobody here".
      place(`veh:${v.id}`, v.x, v.y, 2.2, 2.2, TEAM_COLOUR[v.team]);
    }
    void team;

    for (const [key, object] of this.structures) {
      if (seen.has(key)) continue;
      this.scene.remove(object);
      this.structures.delete(key);
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
    const position = this.tracerGeometry.attributes.position as THREE.BufferAttribute;
    let vertex = 0;

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tracer = this.tracers[i]!;
      tracer.age += dt;
      if (tracer.age > tracer.flightSeconds + TRACER_LINGER_S) {
        this.tracers.splice(i, 1);
        continue;
      }
      const head = Math.min(1, tracer.age / tracer.flightSeconds);
      const tail = Math.max(0, head - STREAK_FRACTION);

      const a = tracer.from.clone().lerp(tracer.to, tail);
      const b = tracer.from.clone().lerp(tracer.to, head);
      if (vertex + 2 > this.maxTracers * 2) break;
      position.setXYZ(vertex++, a.x, a.y, a.z);
      position.setXYZ(vertex++, b.x, b.y, b.z);
    }

    // Collapse the unused vertices onto a point so they draw nothing.
    for (let i = vertex; i < this.maxTracers * 2; i++) position.setXYZ(i, 0, -1000, 0);
    position.needsUpdate = true;
    this.tracerGeometry.setDrawRange(0, this.maxTracers * 2);
  }

  render(dt: number): void {
    this.updateTracers(dt);
    this.renderer.render(this.scene, this.camera);
  }
}

/** How much of its flight a tracer streak spans. */
const STREAK_FRACTION = 0.12;

/** Full leg swings per metre walked. */
const WALK_CYCLES_PER_M = 0.55;
/** Torso height of a body lying on the ground. */
const DOWN_TORSO_HEIGHT_M = 0.25;
