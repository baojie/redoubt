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
import { Terrain, createTerrain, rules, type TeamId } from "@redoubt/core";
import type { ClientWorld } from "./world.js";

/** Metres per terrain mesh quad. Finer than the noise, coarser than a body. */
const MESH_RESOLUTION_M = 8;

/** How far the camera can see. The map is a kilometre across. */
const VIEW_DISTANCE_M = 1200;

const SKY = 0x8ea6bd;
const FOG_NEAR = 260;
const FOG_FAR = 950;

const TEAM_COLOUR: Record<TeamId, number> = { 0: 0x4da3ff, 1: 0xff6b57 };
const DOWNED_COLOUR = 0xc9a227;

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

      const at = world.interpolate(player.track, renderTick);
      const groundZ = this.terrain.heightAt(at.x, at.y);
      const down = player.status === "downed";
      body.position.copy(worldToScene(at.x, at.y, groundZ + (down ? 0.3 : 0.9)));
      body.rotation.y = sceneYaw(player.yaw);
      body.scale.set(1, down ? 0.35 : 1, 1);

      const material = ((body as THREE.Mesh).material as THREE.MeshLambertMaterial);
      material.color.setHex(down ? DOWNED_COLOUR : TEAM_COLOUR[player.team]);
      // Friend or foe is the single most important thing to read instantly.
      material.emissive.setHex(player.team === team ? 0x101820 : 0x200000);
    }

    for (const [id, object] of this.bodies) {
      if (seen.has(id)) continue;
      this.scene.remove(object);
      this.bodies.delete(id);
    }
  }

  private makeBody(): THREE.Mesh {
    // A capsule is a stand-in for a soldier, and an honest one: it is exactly
    // the shape the server tests rounds against.
    const geometry = new THREE.CapsuleGeometry(
      rules.BODY_RADIUS_M,
      rules.BODY_HALF_HEIGHT_M * 2 - rules.BODY_RADIUS_M * 2,
      4,
      8,
    );
    return new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: 0xffffff }));
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
      place(`veh:${v.id}`, v.x, v.y, 2.4, 3, TEAM_COLOUR[v.team]);
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
