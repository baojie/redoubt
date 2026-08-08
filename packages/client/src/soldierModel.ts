/**
 * The soldier model.
 *
 * One rigged glTF, loaded once and cloned per body. This is the only art asset
 * in the project — everything else, including the terrain, is generated — so it
 * carries the project's only attribution obligation. See ATTRIBUTION.md.
 *
 * Two constraints shape how it is used:
 *
 *  1. **It must not lie about the hitbox.** The server tests rounds against a
 *     cylinder of `BODY_RADIUS_M` by `BODY_HALF_HEIGHT_M * 2`. The model is
 *     scaled to that height and checked to fit that radius, because a figure
 *     wider than its own hitbox teaches players to aim at edges that never
 *     register.
 *  2. **It must be optional.** If the file is missing, blocked, or the network
 *     is down, the client falls back to a figure built from primitives rather
 *     than showing nothing. A missing art asset should cost fidelity, not the
 *     ability to see the enemy.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { rules } from "@redoubt/core";

/** Joints bend about their own x, which is across the body for this rig. */
const SWING_AXIS = new THREE.Vector3(1, 0, 0);

const MODEL_URL = "/models/RiggedFigure.glb";

/** Target height, matched to the cylinder the server actually tests against. */
const TARGET_HEIGHT_M = rules.BODY_HALF_HEIGHT_M * 2;

/**
 * Metres walked per full stride cycle.
 *
 * The walk is driven by distance travelled rather than by wall time, so a
 * soldier standing still stands still and one crossing a gap moves their legs
 * at the speed the interpolation implies. A time-driven cycle skates.
 */
const METRES_PER_CYCLE = 1.9;

/**
 * The bones we pose, by name.
 *
 * The model ships with an animation, but it is two keyframes over 1.25 s — a
 * loader test, not a walk. So the skeleton is driven directly. The names come
 * from the asset and are stable; anything missing is skipped, so a different
 * model degrades to a stiff figure rather than throwing.
 */
const BONES = {
  armL: "arm_joint_L_1",
  armR: "arm_joint_R_1",
  legL: "leg_joint_L_1",
  legR: "leg_joint_R_1",
} as const;

/** How far the arms hang from the bind pose, which has them straight out. */
const ARM_REST_RAD = 1.25;
/** Stride and arm swing amplitudes. */
const LEG_SWING_RAD = 0.55;
const ARM_SWING_RAD = 0.35;

export interface SoldierRig {
  root: THREE.Object3D;
  /** Facing correction, measured from the model rather than assumed. */
  facingOffset: number;
  /** Bones we pose, with their bind rotations kept so poses stay relative. */
  bones: Partial<Record<keyof typeof BONES, { bone: THREE.Object3D; rest: THREE.Quaternion }>>;
  /** Parts whose colour marks the team. */
  tinted: THREE.Mesh[];
}

/**
 * Loads the model once and hands out clones.
 *
 * `SkeletonUtils.clone` rather than `Object3D.clone`, because a skinned mesh
 * shares its skeleton with the original otherwise and every soldier on the map
 * ends up in the same pose as the last one drawn.
 */
export class SoldierModel {
  private template: THREE.Object3D | null = null;
  private scale = 1;
  /**
   * How far the model has to be turned so it faces the way the rules mean.
   *
   * glTF authors point characters whichever way suits them, and guessing is
   * how you end up with a squad that walks backwards. Measured from the mesh:
   * a human is wider across the shoulders than front-to-back, so the narrower
   * horizontal axis is the facing axis.
   */
  private facingOffset = 0;
  /** Null until a load has been attempted; false if it failed. */
  loaded: boolean | null = null;

  async load(): Promise<boolean> {
    try {
      const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
      const root = gltf.scene;

      // Scale to the hitbox, whatever units the artist used.
      const bounds = new THREE.Box3().setFromObject(root);
      const height = bounds.max.y - bounds.min.y;
      this.scale = height > 0 ? TARGET_HEIGHT_M / height : 1;

      const width = bounds.max.x - bounds.min.x;
      const depth = bounds.max.z - bounds.min.z;
      // Shoulders across x means the model already faces along z, which is what
      // the scene expects; shoulders across z means it needs a quarter turn.
      this.facingOffset = width >= depth ? 0 : Math.PI / 2;

      this.template = root;
      // The bundled clip is ignored: two keyframes over 1.25 s is a loader
      // test, not a walk. The skeleton is posed directly instead.
      this.loaded = true;
      return true;
    } catch {
      // Missing, blocked, or offline. The caller falls back to primitives.
      this.loaded = false;
      return false;
    }
  }

  /** A fresh, independently posed soldier, or null if the model is unavailable. */
  instantiate(): SoldierRig | null {
    if (this.template === null) return null;

    const model = cloneSkinned(this.template);
    model.scale.setScalar(this.scale);
    // Stand the model on the ground: the caller positions bodies by their
    // torso, which is where the server puts the centre of the hit cylinder.
    model.position.y = -rules.TORSO_HEIGHT_M;

    const tinted: THREE.Mesh[] = [];
    model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Materials are cloned per instance so one soldier's team colour does
      // not repaint every other soldier sharing the template's material.
      const source = mesh.material as THREE.Material;
      mesh.material = Array.isArray(source)
        ? source.map((m) => m.clone())
        : source.clone();
      tinted.push(mesh);
    });

    const root = new THREE.Group();
    root.add(model);

    // A rifle held across the chest. The model is a bare mannequin, and at any
    // real range the silhouette is all you get — a shape with a weapon reads
    // as a soldier, a shape without one reads as scenery.
    const rifle = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.07, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.8 }),
    );
    rifle.position.set(0.16, rules.TORSO_HEIGHT_M * 0.25, -0.26);
    rifle.name = "rifle";
    root.add(rifle);

    const bones: SoldierRig["bones"] = {};
    for (const [key, name] of Object.entries(BONES) as Array<
      [keyof typeof BONES, string]
    >) {
      const bone = model.getObjectByName(name);
      if (bone === undefined) continue;
      bones[key] = { bone, rest: bone.quaternion.clone() };
    }

    const rig: SoldierRig = { root, tinted, facingOffset: this.facingOffset, bones };
    // Drop the arms out of the bind pose immediately, so a soldier who never
    // moves is not standing there like a scarecrow.
    this.poseWalk(rig, 0, 0);
    return rig;
  }

  /**
   * Advance the walk by a distance rather than a duration, and pose the bones.
   * Returns the new phase, which the caller stores per soldier.
   */
  poseWalk(rig: SoldierRig, phase: number, movedM: number): number {
    const next = phase + movedM / METRES_PER_CYCLE;
    const swing = Math.sin(next * Math.PI * 2);
    // Arms swing opposite the leg on the same side, as they do.
    this.poseBone(rig, "legL", swing * LEG_SWING_RAD);
    this.poseBone(rig, "legR", -swing * LEG_SWING_RAD);
    this.poseBone(rig, "armL", ARM_REST_RAD - swing * ARM_SWING_RAD);
    this.poseBone(rig, "armR", ARM_REST_RAD + swing * ARM_SWING_RAD);
    return next;
  }

  /** Lay a rotation on top of a bone's bind pose. */
  private poseBone(rig: SoldierRig, key: keyof typeof BONES, angle: number): void {
    const entry = rig.bones[key];
    if (entry === undefined) return;
    // Applied relative to the bind rotation, so we bend the joint rather than
    // replacing whatever orientation the rigger gave it.
    entry.bone.quaternion
      .copy(entry.rest)
      .multiply(new THREE.Quaternion().setFromAxisAngle(SWING_AXIS, angle));
  }

  /** Paint a soldier. Emissive carries friend-or-foe at a glance. */
  tint(rig: SoldierRig, colour: number, emissive: number): void {
    for (const mesh of rig.tinted) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const standard = material as THREE.MeshStandardMaterial;
        standard.color?.setHex(colour);
        standard.emissive?.setHex(emissive);
      }
    }
  }
}
