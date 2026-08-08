/**
 * First-person input: mouse look, trigger, reload.
 *
 * Aim is predicted locally and applied to the camera immediately — waiting a
 * round trip to find out where you are looking is unusable at any ping. The
 * server still owns it: rounds leave along the aim *it* holds, and it
 * corrects the client on every snapshot. In practice they agree, because both
 * are just accumulating the same mouse deltas.
 *
 * Pointer lock is required for a first-person view, and browsers only grant it
 * from a user gesture, so entering the 3D view is an explicit click.
 */

import { rules } from "@redoubt/core";

/** Radians of aim per pixel of mouse movement, at the default sensitivity. */
const RADIANS_PER_PIXEL = 0.0022;

/** Nobody can look past straight up or straight down. Matches core. */
const MAX_PITCH = Math.PI / 2 - 0.01;

export class FirstPersonInput {
  /** Locally predicted aim. Reconciled against the server every snapshot. */
  yaw = 0;
  pitch = 0;

  sensitivity = 1;
  locked = false;

  /**
   * Optic magnification, driven by the wheel.
   *
   * Applied only while aiming down the sights, because that is the only time
   * you are looking through the optic — zooming with the naked eye is the
   * free-vision cheat this deliberately is not. The bound comes from
   * `rules.ts`: how far a player may magnify decides how much of the map they
   * can read at range, and that is a balance number, not a rendering one.
   */
  magnification = rules.OPTIC_MIN_MAGNIFICATION;

  private firing = false;
  private reloadQueued = false;
  /** Right mouse held. */
  aiming = false;

  /**
   * Recoil, as something you see and fight rather than a number that silently
   * widens a cone. Each round kicks the view up; it settles back between
   * shots. The kick is *added to* the aim rather than replacing it, so a
   * player who pulls down against it is genuinely countering the rise — which
   * is the skill the mechanic is for.
   */
  private kick = 0;

  constructor(canvas: HTMLCanvasElement) {

    canvas.addEventListener("mousedown", (event) => {
      if (!this.locked) {
        void canvas.requestPointerLock();
        return;
      }
      if (event.button === 0) this.firing = true;
      if (event.button === 2) this.aiming = true;
    });

    window.addEventListener("mouseup", (event) => {
      if (event.button === 0) this.firing = false;
      if (event.button === 2) this.aiming = false;
    });

    // Right mouse is the aim button, so the context menu has to go.
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      // Releasing the mouse should never leave the trigger or sights held.
      if (!this.locked) {
        this.firing = false;
        this.aiming = false;
      }
    });

    document.addEventListener("mousemove", (event) => {
      if (!this.locked) return;
      const scale = RADIANS_PER_PIXEL * this.sensitivity;
      // Guarded because a single non-finite delta would poison the aim
      // permanently, and the symptom is bizarre: movement is camera-relative,
      // so a NaN yaw makes every steer intent fail validation at the server
      // and the player simply stops walking while everything else looks fine.
      const dx = Number.isFinite(event.movementX) ? event.movementX : 0;
      const dy = Number.isFinite(event.movementY) ? event.movementY : 0;
      // Screen x grows right; rules yaw grows counter-clockwise, hence the
      // sign. Screen y grows down; looking up is positive pitch.
      this.yaw -= dx * scale;
      this.pitch -= dy * scale;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
    });

    window.addEventListener("keydown", (event) => {
      if (event.code === "KeyR" && !event.repeat) this.reloadQueued = true;
    });
  }

  /** Turn the optic's zoom ring by one notch of the wheel. */
  adjustOptic(deltaY: number): void {
    this.magnification = stepMagnification(this.magnification, deltaY);
  }

  /** Snap to the server's aim. Used on spawn, when we have no better guess. */
  adopt(yaw: number, pitch: number): void {
    if (Number.isFinite(yaw)) this.yaw = yaw;
    if (Number.isFinite(pitch)) this.pitch = pitch;
  }

  /** Is the trigger held? Rate of fire is enforced by the server, not here. */
  get triggerHeld(): boolean {
    return this.locked && this.firing;
  }

  /** Take the queued reload, if any. */
  takeReload(): boolean {
    const queued = this.reloadQueued;
    this.reloadQueued = false;
    return queued;
  }

  release(): void {
    if (this.locked) document.exitPointerLock();
    this.firing = false;
    this.aiming = false;
  }

  /** Called when a round leaves the barrel, to add the kick. */
  noteShot(): void {
    this.kick = Math.min(MAX_KICK_RAD, this.kick + KICK_PER_SHOT_RAD);
  }

  /** Settle the kick. `dt` is seconds since the last frame. */
  settle(dt: number): void {
    this.kick = Math.max(0, this.kick - KICK_RECOVERY_RAD_PER_S * dt);
  }

  /** Pitch to render at: where the player is looking, plus the muzzle rise. */
  get viewPitch(): number {
    return Math.min(MAX_PITCH, this.pitch + this.kick);
  }
}

/**
 * One notch of the wheel on the zoom ring.
 *
 * Pure and exported for the same reason `applyZoom` is: constructing a
 * `FirstPersonInput` needs a DOM, while the clamp is exactly the part worth
 * a test. Wheel up magnifies, matching the map view where wheel up zooms in.
 */
export function stepMagnification(current: number, deltaY: number): number {
  if (deltaY === 0) return current;
  const factor =
    deltaY > 0 ? 1 / rules.OPTIC_MAGNIFICATION_STEP : rules.OPTIC_MAGNIFICATION_STEP;
  return Math.min(
    rules.OPTIC_MAX_MAGNIFICATION,
    Math.max(rules.OPTIC_MIN_MAGNIFICATION, current * factor),
  );
}

/** How far the muzzle climbs per round, and how fast it comes back down. */
const KICK_PER_SHOT_RAD = 0.012;
const MAX_KICK_RAD = 0.075;
const KICK_RECOVERY_RAD_PER_S = 0.16;

/**
 * Turn a WASD vector into a steer direction in world axes, given where the
 * player is facing.
 *
 * In the 2D view the keys are compass directions; in first person they are
 * relative to the camera, which is the only thing that makes sense when you
 * can turn. Same `steer` intent either way — the rules engine neither knows
 * nor cares which view produced it.
 */
export function steerFromCamera(
  input: { x: number; y: number },
  yaw: number,
): { x: number; y: number } | null {
  if (input.x === 0 && input.y === 0) return null;

  // Screen forward is -y in the input convention; map it onto the aim.
  const forward = { x: Math.cos(yaw), y: Math.sin(yaw) };
  // Forward turned a quarter *clockwise*. Yaw runs anticlockwise from east
  // toward north, so the right hand is the negative rotation: (x, y) → (y, -x).
  //
  // This was the other way round, which is the left-hand direction, and A and D
  // were inverted for it. It survived because the mistake is symmetric — the two
  // keys still did opposite things and still felt like strafing, so nothing
  // looked broken until someone checked which way they went. Facing north
  // (yaw = π/2) forward is (0, 1) and the right hand must be east, (1, 0); the
  // old expression gave (-1, 0), which is west.
  const right = { x: forward.y, y: -forward.x };
  const dir = {
    x: forward.x * -input.y + right.x * input.x,
    y: forward.y * -input.y + right.y * input.x,
  };
  const length = Math.hypot(dir.x, dir.y);
  if (length <= 0) return null;
  return { x: dir.x / length, y: dir.y / length };
}

/** Seconds of reload remaining, for the HUD. */
export function reloadRemaining(reloadingUntilTick: number, tick: number): number {
  if (reloadingUntilTick <= tick) return 0;
  return rules.ticksToSeconds(reloadingUntilTick - tick);
}
