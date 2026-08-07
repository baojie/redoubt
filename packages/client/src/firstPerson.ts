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

  private firing = false;
  private reloadQueued = false;

  constructor(canvas: HTMLCanvasElement) {

    canvas.addEventListener("mousedown", (event) => {
      if (!this.locked) {
        void canvas.requestPointerLock();
        return;
      }
      if (event.button === 0) this.firing = true;
    });

    window.addEventListener("mouseup", (event) => {
      if (event.button === 0) this.firing = false;
    });

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      // Releasing the mouse should never leave the trigger held down.
      if (!this.locked) this.firing = false;
    });

    document.addEventListener("mousemove", (event) => {
      if (!this.locked) return;
      const scale = RADIANS_PER_PIXEL * this.sensitivity;
      // Screen x grows right; rules yaw grows counter-clockwise, hence the
      // sign. Screen y grows down; looking up is positive pitch.
      this.yaw -= event.movementX * scale;
      this.pitch -= event.movementY * scale;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
    });

    window.addEventListener("keydown", (event) => {
      if (event.code === "KeyR" && !event.repeat) this.reloadQueued = true;
    });
  }

  /** Snap to the server's aim. Used on spawn, when we have no better guess. */
  adopt(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = pitch;
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
  }
}

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
  const right = { x: -forward.y, y: forward.x };
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
