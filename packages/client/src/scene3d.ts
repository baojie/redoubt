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
import { SoldierModel, type SoldierRig } from "./soldierModel.js";
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
  /** Rigs for bodies drawn with the glTF model, keyed the same way. */
  private readonly rigs = new Map<number, SoldierRig>();
  private readonly walkPhase = new Map<number, number>();
  readonly soldiers = new SoldierModel();
  /** The player's own weapon. Parented to the camera, so it rides the view. */
  readonly viewmodel: Viewmodel;
  /** Last drawn position per player, so the walk cycle follows real motion. */
  private readonly lastSeen = new Map<number, { x: number; y: number }>();
  private readonly markers = new Map<number, THREE.Sprite>();
  private readonly structures = new Map<string, THREE.Object3D>();
  private readonly hulls = new Map<number, THREE.Group>();
  private readonly tracers: Tracer[] = [];
  private readonly tracerLines: THREE.LineSegments;
  private readonly tracerGeometry = new THREE.BufferGeometry();
  private readonly maxTracers = 256;

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

  /**
   * Narrow the field of view while aiming.
   *
   * Eased rather than snapped: an instant FOV change reads as a teleport, and
   * the ease is also what sells the weight of bringing a rifle up.
   */
  setAiming(aiming: boolean, dt: number): void {
    const target = aiming ? ADS_FOV_DEG : HIP_FOV_DEG;
    const rate = Math.min(1, dt * ADS_EASE_PER_S);
    this.camera.fov += (target - this.camera.fov) * rate;
    this.camera.updateProjectionMatrix();
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
  syncPlayers(world: ClientWorld, renderTick: number, selfId: number, team: TeamId): void {
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

      body.position.copy(
        worldToScene(at.x, at.y, groundZ + (down ? DOWN_TORSO_HEIGHT_M : rules.TORSO_HEIGHT_M)),
      );
      const rig0 = this.rigs.get(player.id);
      body.rotation.set(0, sceneYaw(player.yaw) + (rig0?.facingOffset ?? 0), 0);

      // Soldiers do not collide with each other — they can and do stand in the
      // same spot — so anyone close enough to be *inside* the camera is hidden.
      // Otherwise a teammate who walks onto you fills the screen with the
      // inside of their own head.
      const fromCamera = body.position.distanceTo(this.camera.position);
      body.visible = fromCamera > BODY_HIDE_WITHIN_M;
      if (down) {
        // Face down on the ground rather than a shrunken standing figure: a
        // casualty has to be findable, and its pose is the only cue.
        body.rotation.x = -Math.PI / 2;
      }

      const colour = down ? DOWNED_COLOUR : TEAM_COLOUR[player.team];
      const emissive = friendly ? 0x101820 : 0x200000;

      const rig = rig0;
      if (rig !== undefined) {
        if (!down) {
          const phase = this.walkPhase.get(player.id) ?? 0;
          this.walkPhase.set(player.id, this.soldiers.poseWalk(rig, phase, moved));
        }
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

      const body = hull.getObjectByName("body") as THREE.Mesh | undefined;
      if (body !== undefined) {
        const material = body.material as THREE.MeshLambertMaterial;
        // Darkens as it takes damage, so a truck about to die looks like one.
        const wear = Math.max(0.25, vehicle.health);
        material.color.setHex(TEAM_COLOUR[vehicle.team]).multiplyScalar(wear);
      }
    }

    for (const [id, hull] of this.hulls) {
      if (seen.has(id)) continue;
      this.scene.remove(hull);
      this.hulls.delete(id);
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
