/**
 * The real rifle model, in one place.
 *
 * The primitive rifle in `rifle.ts` was built when the project refused every
 * sourced asset. The soldier and the vehicles already broke that rule — both
 * are Quaternius models — and a rifle made of boxes, at the bottom of the
 * player's own screen, was the last placeholder left. So this is the same
 * deal the other two models are on: a Quaternius assault rifle, CC0, loaded
 * once and cloned wherever a rifle is needed.
 *
 * Like `rifle.ts`, this file is the one place that knows the weapon's shape —
 * and, more importantly, the geometry facts the rest of the client depends on:
 * where the muzzle is (the flash has to come out of it), where the grip is
 * (the firing hand closes on it), where the barrel sits (the support hand
 * rides it) and how high the optic axis is (that is what the eye drops to
 * when aiming). The asset's own numbers are measured once, below, and every
 * caller gets them back scaled to the length *it* wants.
 *
 * The asset lies along its own +x with the muzzle at the +x end and the
 * pistol grip hanging below x ≈ -0.25. Everything else is read off that.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const MODEL_URL = "/models/AssaultRifle.glb";

/** The whole rifle, butt to muzzle, in the asset's own units. */
const RAW_LENGTH = 5.169;
/** The pistol grip: the point every holder positions the rifle by. */
const RAW_GRIP = { x: -0.25, y: 0 };
/** The muzzle tip, where the flash and the player's own tracer leave. */
const RAW_MUZZLE = { x: 3.609, y: 0.65 };
/**
 * The barrel axis above the grip line.
 *
 * The support hand rides the handguard, and the handguard and barrel share an
 * axis — so this is the height both the support hand and the muzzle flash
 * sit at, measured rather than guessed so the hand lands on the handguard and
 * the flash on the barrel.
 */
const RAW_BARREL_Y = 0.65;
/**
 * The optic axis above the grip line.
 *
 * Not the receiver's top but the scope's axis, set high enough to clear the
 * model's own front sight tower (which reaches 1.07). Aiming drops the weapon
 * so the eye is level with this, exactly as `opticHeight` does in `rifle.ts`.
 */
const RAW_OPTIC_Y = 1.15;
/** The middle of the handguard, where the support hand wraps around. */
const RAW_HANDGUARD_X = 1.8;

export class RifleModels {
  private template: THREE.Object3D | null = null;
  /** Null until a load has been attempted; false if it failed. */
  loaded: boolean | null = null;

  /** Load the model once. Resolves false if it is missing or blocked. */
  async load(): Promise<boolean> {
    try {
      const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
      this.template = gltf.scene;
      this.loaded = true;
      return true;
    } catch {
      // Missing, blocked, or offline. Callers fall back to the primitive rifle.
      this.loaded = false;
      return false;
    }
  }

  /**
   * A rifle of the given length: muzzle along the weapon's own -z, origin at
   * the pistol grip. Null until the model has loaded.
   *
   * Same origin convention as `buildRifle` in `rifle.ts`, so both callers
   * position it by where it is held and neither has to learn a new frame.
   */
  instantiate(lengthM: number): THREE.Object3D | null {
    if (this.template === null) return null;

    const rifle = this.template.clone(true);
    const scale = lengthM / RAW_LENGTH;
    rifle.scale.setScalar(scale);
    // The asset's muzzle runs along +x; everything in this project expects it
    // along -z, which a quarter turn about +y does.
    rifle.rotation.y = Math.PI / 2;
    // Bring the grip to the origin. After the rotation, model x feeds rifle -z,
    // so the grip at x = RAW_GRIP.x lands at z = +0.25·scale and has to be
    // pulled back to zero.
    rifle.position.z = RAW_GRIP.x * scale;
    return rifle;
  }

  /** How far in front of the grip the muzzle is, along the rifle's own -z. */
  static muzzleOffset(lengthM: number): number {
    return -(RAW_MUZZLE.x - RAW_GRIP.x) * (lengthM / RAW_LENGTH);
  }

  /** The optic axis above the grip — where the eye goes when aiming. */
  static opticHeight(lengthM: number): number {
    return RAW_OPTIC_Y * (lengthM / RAW_LENGTH);
  }

  /** The barrel axis above the grip — the height of the support hand. */
  static barrelHeight(lengthM: number): number {
    return RAW_BARREL_Y * (lengthM / RAW_LENGTH);
  }

  /** How far in front of the grip the handguard is, along the rifle's -z. */
  static handguardOffset(lengthM: number): number {
    return -(RAW_HANDGUARD_X - RAW_GRIP.x) * (lengthM / RAW_LENGTH);
  }
}
