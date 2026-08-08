/**
 * The weapon in your own hands.
 *
 * Until now first person showed a crosshair floating over an empty world. The
 * rifle was on every soldier's back except the one you were playing, which made
 * the view read as a camera rather than as a person — and it took away the only
 * continuous feedback the game has about the weapon's state. A magazine counter
 * tells you the number; the rifle dipping out of view tells you that you cannot
 * shoot for the next two seconds, without you having to read anything.
 *
 * It is a child of the camera, so it inherits the view transform for free and
 * nothing here has to know about world space.
 *
 * Two things it must not do:
 *
 *  1. **Cover the crosshair.** The weapon sits low and to the right, and when
 *     aiming it comes to just under centre. Rounds go where the crosshair is,
 *     not where the barrel is drawn, so a viewmodel that covers the aim point
 *     is actively lying about where you are shooting.
 *  2. **Clip through the near plane.** The camera's near plane is 0.1 m; the
 *     weapon lives well beyond it, and is scaled down rather than pulled
 *     closer when it needs to look bigger.
 */

import * as THREE from "three";
import { rules } from "@redoubt/core";
import { buildRifle, sightHeight } from "./rifle.js";

/**
 * Overall rifle length, and how far out it is held.
 *
 * These two are one decision, not two: what a player sees is the angle the
 * weapon subtends, so halving the distance is the same as doubling the rifle.
 * The first attempt put a 0.86 m rifle 0.42 m from the eye, which sounds like
 * arm's length and looked like carrying a wardrobe — the stock alone, being
 * nearest, took a quarter of the screen.
 *
 * Sized instead by the fraction of the view it should occupy: the receiver is
 * about a twentieth of the screen width, which reads as a held weapon without
 * competing with the world for attention.
 */
const RIFLE_LENGTH_M = 0.6;

/** How far in front of the eye the weapon sits. Comfortably past the near plane. */
const REST_Z = -0.7;

/** Hip carry: down and to the right, out of the way of the aim point. */
const HIP = new THREE.Vector3(0.3, -0.26, REST_Z);
/**
 * Canted across the body when not aiming, which is how a rifle is actually
 * carried — and, less romantically, the only way it reads as a rifle at all.
 * Pointed straight down the view axis it is a dark rectangle seen end-on, with
 * no length visible and nothing to tell it from a wall.
 */
const HIP_YAW_RAD = -0.34;
const HIP_PITCH_RAD = 0.07;
const HIP_ROLL_RAD = 0.12;

/**
 * Aiming: sights centred horizontally and dropped so the eye looks over them.
 *
 * The vertical figure is derived rather than dialled in — the weapon is lowered
 * by exactly the height of its own sights, which is what puts the sight line,
 * rather than the barrel, on the crosshair.
 */
const ADS_X = 0;
const ADS_Y = -sightHeight(RIFLE_LENGTH_M);
const ADS_Z = -0.58;

/** How fast the weapon moves between carry and aim. */
const ADS_EASE_PER_S = 14;

/** Recoil: straight back and slightly up, then a spring back to rest. */
const RECOIL_PER_SHOT_M = 0.035;
const RECOIL_MAX_M = 0.075;
const RECOIL_RECOVERY_PER_S = 0.42;
const RECOIL_RISE_RAD = 0.9;

/**
 * Walking sway, driven by distance rather than by time.
 *
 * Same reason the soldiers' legs are: a time-driven bob keeps bobbing when you
 * stand still, and stops matching your pace the moment anything changes speed.
 */
const METRES_PER_BOB = 1.9;
const BOB_X_M = 0.012;
const BOB_Y_M = 0.016;

/** How far the weapon drops out of view during a reload. */
const RELOAD_DROP_M = 0.22;
const RELOAD_ROLL_RAD = 0.5;

export class Viewmodel {
  private readonly root = new THREE.Group();
  private readonly rifle: THREE.Group;

  /** 0 at the hip, 1 fully aimed. Eased, so it lags the state change. */
  private aimBlend = 0;
  private recoilM = 0;
  private bobPhase = 0;
  /** 0 to 1 through the current reload, for the dip. */
  private reloadBlend = 0;

  constructor(camera: THREE.Camera) {
    // Light enough to hold an edge against dark ground. A near-black weapon
    // against a shadowed hillside is one flat silhouette with no shape in it.
    const material = new THREE.MeshStandardMaterial({ color: 0x3c4046, roughness: 0.6 });
    this.rifle = buildRifle(RIFLE_LENGTH_M, material, true);
    this.root.add(this.rifle);
    // Drawn after the world and never culled: it is always in front of the eye,
    // and a frustum test on an object parented to the camera is wasted work.
    this.root.frustumCulled = false;
    camera.add(this.root);
  }

  /**
   * Show the weapon, or not.
   *
   * Hidden when there is no soldier to hold it — dead, waiting to deploy, or
   * sitting in a vehicle, where the rifle is stowed and the view is a cab.
   */
  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  /** A round has left the barrel. Called on the server's confirmation. */
  noteShot(): void {
    this.recoilM = Math.min(RECOIL_MAX_M, this.recoilM + RECOIL_PER_SHOT_M);
  }

  /**
   * Advance the weapon one frame.
   *
   * `movedM` is how far the player actually moved, so the sway follows the
   * predicted position rather than a guess at their speed.
   */
  update(
    dt: number,
    aiming: boolean,
    movedM: number,
    reloadFraction: number,
  ): void {
    if (!this.root.visible) return;

    const ease = Math.min(1, dt * ADS_EASE_PER_S);
    this.aimBlend += ((aiming ? 1 : 0) - this.aimBlend) * ease;
    this.reloadBlend += (reloadFraction - this.reloadBlend) * ease;
    this.recoilM = Math.max(0, this.recoilM - RECOIL_RECOVERY_PER_S * dt);

    this.bobPhase += movedM / METRES_PER_BOB;
    // Sway settles as the weapon comes up: a rifle held against the shoulder
    // moves far less than one carried at the hip.
    const swayScale = 1 - this.aimBlend * 0.85;
    const sway = Math.sin(this.bobPhase * Math.PI * 2);

    const x = HIP.x + (ADS_X - HIP.x) * this.aimBlend + sway * BOB_X_M * swayScale;
    const y =
      HIP.y +
      (ADS_Y - HIP.y) * this.aimBlend +
      Math.abs(sway) * BOB_Y_M * swayScale -
      this.reloadBlend * RELOAD_DROP_M;
    const z = HIP.z + (ADS_Z - HIP.z) * this.aimBlend + this.recoilM;

    this.root.position.set(x, y, z);
    this.root.rotation.set(
      HIP_PITCH_RAD * (1 - this.aimBlend) - this.recoilM * RECOIL_RISE_RAD,
      HIP_YAW_RAD * (1 - this.aimBlend),
      HIP_ROLL_RAD * (1 - this.aimBlend) + this.reloadBlend * RELOAD_ROLL_RAD,
    );
  }
}

/**
 * How far through a reload the player is, from 0 (not reloading) to 1.
 *
 * Reads the authoritative finish tick rather than timing a local animation, so
 * the weapon comes back up exactly when the server says it can fire again. The
 * duration comes from the rules table for the same reason — a hard-coded
 * animation length would silently desynchronise the day the reload time is
 * retuned.
 */
export function reloadFraction(reloadingUntilTick: number, tick: number): number {
  const remaining = reloadingUntilTick - tick;
  if (remaining <= 0) return 0;
  const total = rules.RELOAD_TICKS;
  if (total <= 0) return 0;
  // Peaks in the middle of the reload and is back up by the end, so the weapon
  // is level again on the tick the player regains the ability to fire.
  return Math.sin(Math.min(1, remaining / total) * Math.PI);
}
