/**
 * Vehicle models.
 *
 * Vehicles were two white boxes: one for the hull, one for the cab. At any
 * distance that reads as scenery, and up close it is impossible to tell a
 * supply truck from an armoured car — which matters, because one is worth five
 * tickets and the other ten, and you are meant to choose which to shoot.
 *
 * Two constraints, the same ones the soldier model is under:
 *
 *  1. **The hull must not lie.** The server stops rounds at a box of
 *     `halfLengthM × halfWidthM × heightM` from the rules table. The model is
 *     fitted to exactly that box, per axis, rather than scaled uniformly and
 *     left to fall short. A visibly narrow truck whose rounds stop in mid-air
 *     teaches players to distrust what they see; ten per cent of stretch on a
 *     vehicle is invisible by comparison.
 *  2. **It must be optional.** If a model is missing or blocked, the caller
 *     falls back to the boxes. Losing an asset should cost fidelity, not the
 *     ability to see a truck bearing down on you.
 */

import * as THREE from "three";
import { rules, type VehicleType } from "@redoubt/core";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

const MODEL_URLS: Record<VehicleType, string> = {
  logistics: "/models/LogisticsTruck.glb",
  armoured: "/models/ArmouredPickup.glb",
};

/**
 * Wheel nodes, by the names the assets happen to use.
 *
 * Anything missing is skipped, so a different model degrades to a vehicle whose
 * wheels do not turn rather than throwing.
 */
const WHEEL_NODES = ["FrontWheel_L", "FrontWheel_R", "BackWheels"];

/**
 * Metres travelled per full wheel revolution.
 *
 * Driven by distance, not by time, for the same reason the soldiers' legs are:
 * a time-driven spin keeps turning while the truck is parked, and stops
 * matching the moment anything changes speed.
 */
const METRES_PER_REVOLUTION = 2.6;

/** How far the team colour is mixed in over the model's own texture. */
const TEAM_TINT_STRENGTH = 0.45;

export interface VehicleRig {
  root: THREE.Object3D;
  /** Meshes that carry the team colour. */
  tinted: THREE.Mesh[];
  /** Wheels, spun by distance travelled. */
  wheels: THREE.Object3D[];
}

export class VehicleModels {
  private readonly templates = new Map<VehicleType, THREE.Object3D>();
  /** Null until a load has been attempted; false if every load failed. */
  loaded: boolean | null = null;

  /**
   * Load every vehicle model.
   *
   * Resolves true if at least one arrived: a game with a real truck and a boxy
   * armoured car is worse than one with both, and much better than neither.
   */
  async load(): Promise<boolean> {
    const loader = new GLTFLoader();
    const kinds = Object.keys(MODEL_URLS) as VehicleType[];

    await Promise.all(
      kinds.map(async (kind) => {
        const url = MODEL_URLS[kind];
        if (url === undefined) return;
        try {
          const gltf = await loader.loadAsync(url);
          this.fit(gltf.scene, kind);
          this.templates.set(kind, gltf.scene);
        } catch {
          // Missing, blocked or offline. The caller falls back to boxes.
        }
      }),
    );

    this.loaded = this.templates.size > 0;
    return this.loaded;
  }

  /**
   * Scale and centre a model onto the box the server adjudicates against.
   *
   * Uniformly, and sized so the whole model fits *inside* the box. Fitting each
   * axis separately sounds better — the silhouette would then match exactly
   * where rounds stop — but these assets are not proportioned like the rules
   * table, and stretching each axis independently produced two flattened
   * pancakes with their wheels squashed into the bodywork. A vehicle that is
   * slightly smaller than its hitbox is a much smaller lie than a vehicle that
   * is the wrong shape.
   *
   * The consequence is worth stating: a round can stop just off the visible
   * edge of a hull. The alternative was a truck that did not look like a truck.
   */
  private fit(model: THREE.Object3D, kind: VehicleType): void {
    const spec = rules.VEHICLE_SPECS[kind];

    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());

    // Which way the asset is laid out is measured, not assumed: the length runs
    // along whichever horizontal axis is longer, and a truck turned ninety
    // degrees is a memorable kind of wrong.
    const lengthAlongX = size.x >= size.z;
    const alongLength = lengthAlongX ? size.x : size.z;
    const alongWidth = lengthAlongX ? size.z : size.x;

    const scale = Math.min(
      (spec.halfLengthM * 2) / Math.max(alongLength, 1e-6),
      (spec.halfWidthM * 2) / Math.max(alongWidth, 1e-6),
      spec.heightM / Math.max(size.y, 1e-6),
    );
    model.scale.setScalar(scale);
    // Turn it so the length runs along x, which is what the caller's yaw means.
    if (!lengthAlongX) model.rotation.y = Math.PI / 2;

    // Re-measure with the scale and rotation applied, then centre it
    // horizontally and stand it on the ground. The caller positions vehicles by
    // the centre of the hull, which is half a hull height above the terrain.
    model.updateMatrixWorld(true);
    const placed = new THREE.Box3().setFromObject(model);
    const centre = placed.getCenter(new THREE.Vector3());
    model.position.set(-centre.x, -placed.min.y - spec.heightM / 2, -centre.z);
  }

  /** A fresh vehicle of this kind, or null if its model is unavailable. */
  instantiate(kind: VehicleType): VehicleRig | null {
    const template = this.templates.get(kind);
    if (template === undefined) return null;

    const model = cloneSkinned(template);
    const tinted: THREE.Mesh[] = [];
    const wheels: THREE.Object3D[] = [];

    model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Cloned per instance, so tinting one vehicle does not repaint the fleet.
      const source = mesh.material as THREE.Material;
      mesh.material = Array.isArray(source)
        ? source.map((m) => m.clone())
        : source.clone();
      tinted.push(mesh);
    });

    for (const name of WHEEL_NODES) {
      const wheel = model.getObjectByName(name);
      if (wheel !== undefined) wheels.push(wheel);
    }

    const root = new THREE.Group();
    root.add(model);
    return { root, tinted, wheels };
  }

  /**
   * Turn the wheels by how far the vehicle has moved.
   * Returns the new angle, which the caller stores per vehicle.
   */
  static spinWheels(rig: VehicleRig, angle: number, movedM: number): number {
    const next = angle + (movedM / METRES_PER_REVOLUTION) * Math.PI * 2;
    for (const wheel of rig.wheels) wheel.rotation.x = next;
    return next;
  }

  /**
   * Paint a vehicle: enough team colour to identify it, not enough to erase it.
   *
   * `color` multiplies the texture, so setting it to a saturated team colour
   * turns a detailed truck into a flat blue or red brick — which is what the
   * boxes already did, and the reason for fitting real models in the first
   * place. So the colour is mixed part-way from white instead: the livery is
   * unmistakable at range while the panel lines, glass and cargo body survive
   * up close.
   *
   * Wear darkens on top, so a truck about to die still looks like one.
   */
  static tint(rig: VehicleRig, colour: number, wear: number): void {
    const team = new THREE.Color(colour);
    const painted = new THREE.Color(1, 1, 1).lerp(team, TEAM_TINT_STRENGTH);
    for (const mesh of rig.tinted) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const standard = material as THREE.MeshStandardMaterial;
        if (standard.color === undefined) continue;
        standard.color.copy(painted).multiplyScalar(wear);
      }
    }
  }
}
