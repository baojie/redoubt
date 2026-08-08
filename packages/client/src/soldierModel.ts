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
import { buildRifle } from "./rifle.js";

/** Legs hinge about their own x, which is across the body for this rig. */
const LEG_AXIS = new THREE.Vector3(1, 0, 0);

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

/** The joint below each shoulder, watched to work out which way "down" is. */
const ELBOWS: Partial<Record<keyof typeof BONES, string>> = {
  armL: "arm_joint_L_2",
  armR: "arm_joint_R_2",
};

/** Bones used only as measuring points for where gear goes. */
const ANCHOR_BONES = {
  neckTop: "neck_joint_2",
  hip: "leg_joint_L_1",
} as const;

/** How far the arms hang from the bind pose, which has them straight out. */
const ARM_REST_RAD = 1.25;
/** Stride and arm swing amplitudes. */
const LEG_SWING_RAD = 0.55;
const ARM_SWING_RAD = 0.35;

/**
 * Candidate hinge axes, tried in order when calibrating a shoulder.
 *
 * The two shoulders are mirrored in the bind pose, so one and the same axis
 * lowers the left arm and lifts the right one — which is exactly what happened:
 * the left arm hung correctly while the right stayed locked out sideways in a
 * half T-pose, in shipped code, for as long as the model has been in. Rather
 * than hard-coding the sign per side and hoping the next model matches, each
 * shoulder is calibrated: rotate it, see which way the elbow actually went,
 * keep the axis that put the elbow lowest.
 */
const AXIS_CANDIDATES: ReadonlyArray<THREE.Vector3> = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
];

export interface SoldierRig {
  root: THREE.Object3D;
  /** Facing correction, measured from the model rather than assumed. */
  facingOffset: number;
  /**
   * Bones we pose, with their bind rotations kept so poses stay relative and
   * the hinge axis that was measured for each one.
   */
  bones: Partial<
    Record<
      keyof typeof BONES,
      { bone: THREE.Object3D; rest: THREE.Quaternion; axis: THREE.Vector3 }
    >
  >;
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

  /**
   * Half the width of the head, measured off the mesh in metres.
   *
   * Derived from the shoulders at first, and a helmet sized that way ended up
   * entirely *inside* the skull — invisible, and indistinguishable from a
   * helmet that had failed to load. The head is the one part whose size the
   * skeleton says nothing about, so it gets measured from the geometry.
   */
  private headHalfWidth = 0.1;
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

      this.headHalfWidth = measureHeadHalfWidth(root) * this.scale;
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

    const bones: SoldierRig["bones"] = {};
    for (const [key, name] of Object.entries(BONES) as Array<
      [keyof typeof BONES, string]
    >) {
      const bone = model.getObjectByName(name);
      if (bone === undefined) continue;
      const rest = bone.quaternion.clone();
      const elbowName = ELBOWS[key];
      const elbow = elbowName === undefined ? undefined : model.getObjectByName(elbowName);
      const axis =
        elbow === undefined ? LEG_AXIS.clone() : lowestSwingAxis(root, bone, rest, elbow);
      bones[key] = { bone, rest, axis };
    }

    this.addGear(root, model, tinted);
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
    // Both arms swing about the axis measured for their own shoulder, so the
    // mirrored bind poses no longer send one arm down and the other outwards.
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
      .multiply(new THREE.Quaternion().setFromAxisAngle(entry.axis, angle));
  }


  /**
   * Hang gear on a bare mannequin.
   *
   * The base model is an unclothed figure, and at any real range the silhouette
   * is all a player gets — a shape with a helmet, a vest and a weapon reads as
   * a soldier; the same shape without them reads as scenery.
   *
   * Built from primitives rather than sourced: no CC0 modern-military character
   * turned out to be fetchable (the good CC0 packs are medieval fantasy, and
   * the humanoid ones sit behind interactive downloads), and gear is the cheap
   * 80% of the difference anyway.
   *
   * Every size and position is derived from the skeleton rather than written
   * down. The first attempt used figures for a real adult — a 0.34 m chest rig
   * on a model whose shoulders are 0.22 m apart — and produced a slab floating
   * off the front of the body. Measuring costs a few matrix multiplies once per
   * soldier and cannot drift away from the model.
   */
  private addGear(root: THREE.Group, model: THREE.Object3D, tinted: THREE.Mesh[]): void {
    root.updateMatrixWorld(true);
    const at = (name: string): THREE.Vector3 | null => {
      const bone = model.getObjectByName(name);
      if (bone === undefined) return null;
      return bone.getWorldPosition(new THREE.Vector3());
    };

    const shoulder = at(BONES.armL);
    const neckTop = at(ANCHOR_BONES.neckTop);
    const hip = at(ANCHOR_BONES.hip);
    // Without the skeleton there is nothing to hang gear off, and guessing is
    // what produced the floating slab. A bare figure is the better failure.
    if (shoulder === null || neckTop === null || hip === null) return;

    const halfWidth = Math.abs(shoulder.x);
    const headTop = rules.BODY_HALF_HEIGHT_M * 2 - rules.TORSO_HEIGHT_M;

    /**
     * Gear lives in its own frame so it can be placed nose-forward.
     *
     * `facingOffset` is added to the body's yaw by the renderer, so within the
     * rig the axes are not the soldier's own. Undoing it here lets the gear be
     * written in body terms.
     *
     * Which way that frame points was measured, not assumed. The width-versus-
     * depth test that produces `facingOffset` fixes the axis but says nothing
     * about the sign, and this model has no face to check it against — so it
     * had never been checked at all. Two independent readings agree that the
     * front is +z: the toe joints sit forward of the ankles along +z, and a
     * soldier rendered turned towards the camera showed the pack.
     */
    const gear = new THREE.Group();
    gear.rotation.y = -this.facingOffset;
    root.add(gear);

    const webbing = new THREE.MeshStandardMaterial({ color: 0x2f3238, roughness: 0.85 });
    // Team-coloured, so friend-or-foe survives at the range where the body is
    // only a few pixels.
    const kit = new THREE.MeshStandardMaterial({ roughness: 0.9 });

    const add = (
      geometry: THREE.BufferGeometry,
      x: number,
      y: number,
      z: number,
      material: THREE.Material,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      gear.add(mesh);
      if (material === kit) tinted.push(mesh);
      return mesh;
    };

    // Helmet: a dome and a brim, sized off the head that is actually there.
    const headHalf = this.headHalfWidth;
    const headMid = (neckTop.y + headTop) / 2;
    // Sat on the crown rather than around the middle of the head, so the dome
    // covers the skull instead of intersecting it.
    const helmetY = headMid + (headTop - headMid) * 0.35;
    add(
      new THREE.SphereGeometry(headHalf * 1.2, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      0,
      helmetY,
      0,
      kit,
    );
    add(
      new THREE.CylinderGeometry(headHalf * 1.35, headHalf * 1.35, 0.03, 14),
      0,
      helmetY,
      0,
      kit,
    );

    // Chest rig, from just under the shoulders to just above the waist.
    const chestTop = shoulder.y - 0.04;
    const chestBottom = (shoulder.y + hip.y) / 2 + 0.04;
    const chestHeight = Math.max(0.1, chestTop - chestBottom);
    const torsoDepth = halfWidth * 1.25;
    add(
      new THREE.BoxGeometry(halfWidth * 1.75, chestHeight, torsoDepth),
      0,
      (chestTop + chestBottom) / 2,
      0,
      kit,
    );

    // Pack on the back.
    add(
      new THREE.BoxGeometry(halfWidth * 1.4, chestHeight * 1.1, torsoDepth * 0.7),
      0,
      (chestTop + chestBottom) / 2 + 0.02,
      -torsoDepth * 0.75,
      webbing,
    );

    // Rifle, carried across the front on the right, pointing the way the
    // soldier faces. On a model with no face this is what tells a player which
    // way someone is looking.
    //
    // Same shape as the one in the player's own hands — see rifle.ts — but
    // built without the close-up detail: there can be two dozen soldiers on
    // screen and none of them is close enough for a trigger guard to matter.
    const rifle = buildRifle(halfWidth * 5, webbing, false);
    rifle.position.set(halfWidth * 0.9, (chestBottom + hip.y) / 2, halfWidth * 5 * 0.3);
    rifle.rotation.y = Math.PI;
    gear.add(rifle);
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

/**
 * Which hinge axis actually lowers this arm?
 *
 * Applies the rest rotation about each candidate and keeps whichever leaves the
 * elbow lowest. Measured rather than assumed for the same reason `facingOffset`
 * is: the alternative is a per-rig table of signs that is wrong the first time
 * anyone swaps the model, and silently wrong — a T-posed arm looks like a bad
 * animation, not like a bug.
 */
function lowestSwingAxis(
  root: THREE.Object3D,
  shoulder: THREE.Object3D,
  rest: THREE.Quaternion,
  elbow: THREE.Object3D,
): THREE.Vector3 {
  let best = AXIS_CANDIDATES[0]!;
  let lowest = Infinity;
  const probe = new THREE.Vector3();

  for (const axis of AXIS_CANDIDATES) {
    shoulder.quaternion
      .copy(rest)
      .multiply(new THREE.Quaternion().setFromAxisAngle(axis, ARM_REST_RAD));
    root.updateMatrixWorld(true);
    const y = elbow.getWorldPosition(probe).y;
    if (y < lowest) {
      lowest = y;
      best = axis;
    }
  }

  shoulder.quaternion.copy(rest);
  root.updateMatrixWorld(true);
  return best.clone();
}

/**
 * Half the width of the head, in the model's own units.
 *
 * Walks the vertices above the neck rather than trusting a ratio: heads are the
 * part of a figure artists stylise most, and a helmet that misses is worse than
 * no helmet at all. Runs once, on the template.
 */
function measureHeadHalfWidth(root: THREE.Object3D): number {
  const neck = root.getObjectByName(ANCHOR_BONES.neckTop);
  if (neck === undefined) return 0.1;

  root.updateMatrixWorld(true);
  const neckY = neck.getWorldPosition(new THREE.Vector3()).y;

  let widest = 0;
  const vertex = new THREE.Vector3();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const positions = mesh.geometry.getAttribute("position");
    if (positions === undefined) return;
    for (let i = 0; i < positions.count; i++) {
      vertex.fromBufferAttribute(positions as THREE.BufferAttribute, i);
      vertex.applyMatrix4(mesh.matrixWorld);
      if (vertex.y < neckY) continue;
      widest = Math.max(widest, Math.abs(vertex.x));
    }
  });

  return widest > 0 ? widest : 0.1;
}
