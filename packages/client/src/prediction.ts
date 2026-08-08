/**
 * Client-side prediction and server reconciliation.
 *
 * The loop, straight out of PLAN §4:
 *
 *  1. The client applies its own input immediately, so movement feels instant
 *     regardless of ping.
 *  2. Every input frame carries a sequence number and goes to the server.
 *  3. Snapshots echo the last sequence the server consumed. The client resets
 *     its predicted position to the authoritative one and *replays* every
 *     frame the server has not yet acknowledged.
 *
 * Step 3 is why this works at all. The server's word is always accepted, but
 * accepting it does not throw away the input the player has issued since — so
 * the correction lands behind the player rather than yanking them backwards.
 *
 * Movement is simulated here using `core`'s own constant, deliberately. Any
 * divergence between this and the server's movement system shows up as
 * prediction error on the HUD, which is the number to watch when something
 * feels wrong.
 */

import { rules } from "@redoubt/core";
import type { Intent } from "@redoubt/protocol";

export interface PendingFrame {
  seq: number;
  /** The steering direction in force during this frame, already normalised. */
  steer: { x: number; y: number } | null;
}

export interface Vec {
  x: number;
  y: number;
}

export class Predictor {
  /** Where we believe we are, right now, including unconfirmed input. */
  position: Vec = { x: 0, y: 0 };

  /** Frames sent but not yet acknowledged, oldest first. */
  private pending: PendingFrame[] = [];

  /** Distance the last reconciliation moved us. The HUD's honesty check. */
  lastErrorM = 0;

  /** True once the server has told us where we actually are. */
  private initialised = false;

  /**
   * Our own copy of the run-up counter.
   *
   * Prediction has to model speed, and speed now depends on how long we have
   * been moving — so the counter is part of the predicted state and is replayed
   * from the server's value exactly like position is.
   */
  private runTicks = 0;

  reset(position: Vec, runTicks: number): void {
    this.position = { ...position };
    this.pending = [];
    this.lastErrorM = 0;
    this.runTicks = Number.isFinite(runTicks) ? runTicks : 0;
    this.initialised = true;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Apply one frame of local input and remember it for replay.
   * Called once per input frame, which runs at the server's tick rate so that
   * one pending frame is worth exactly one tick of movement.
   */
  predict(frame: PendingFrame): void {
    if (!this.initialised) return;
    this.pending.push(frame);
    this.runTicks = frame.steer === null ? 0 : this.runTicks + 1;
    this.position = step(this.position, frame.steer, this.runTicks);
  }

  /**
   * Accept the server's position and replay whatever it had not seen yet.
   *
   * `authoritative` is the position at the tick the server had consumed input
   * `ackSeq`, so every frame after that sequence still needs applying.
   */
  /**
   * `runTicks` is the server's run-up counter at `ackSeq`, and is required
   * rather than defaulted. Defaulting it to zero replays the pending frames at
   * a standing start while the server was at a run, which shows up as a
   * permanent non-zero correction on every snapshot — caught by the test that
   * asserts zero error while the two agree.
   */
  reconcile(authoritative: Vec, ackSeq: number, runTicks: number): void {
    if (!this.initialised) {
      this.reset(authoritative, runTicks);
      return;
    }

    const before = this.position;
    this.pending = this.pending.filter((frame) => frame.seq > ackSeq);

    let replayed: Vec = { ...authoritative };
    let replayedRunTicks = Number.isFinite(runTicks) ? runTicks : 0;
    for (const frame of this.pending) {
      replayedRunTicks = frame.steer === null ? 0 : replayedRunTicks + 1;
      replayed = step(replayed, frame.steer, replayedRunTicks);
    }
    this.runTicks = replayedRunTicks;

    this.lastErrorM = Math.hypot(replayed.x - before.x, replayed.y - before.y);
    this.position = replayed;
  }

  /**
   * Abandon prediction and snap to the server — used when the player is not in
   * control of their own position at all: dead, or riding in someone's truck.
   */
  snapTo(position: Vec): void {
    this.position = { ...position };
    this.pending = [];
    this.lastErrorM = 0;
    // Whatever run-up we had is gone: this is called when we are dead or a
    // passenger, neither of which is running anywhere.
    this.runTicks = 0;
    this.initialised = true;
  }
}

/**
 * One tick of movement. This must stay in lockstep with core's movement
 * system; it reads the same speed constant so a balance change cannot silently
 * desynchronise the two.
 */
function step(
  from: Vec,
  steer: { x: number; y: number } | null,
  runTicks: number,
): Vec {
  if (steer === null) return from;
  const speed = rules.PLAYER_SPEED_M_PER_TICK * rules.runSpeedMultiplier(runTicks);
  const next = {
    x: from.x + steer.x * speed,
    y: from.y + steer.y * speed,
  };
  // A single non-finite value here is unrecoverable: it poisons the position,
  // then the camera, and the client draws an empty world with no indication of
  // why. Refusing to move is a far better failure than moving to NaN.
  if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return from;
  return next;
}

/** Normalise a raw input direction the same way the server will. */
export function normaliseSteer(dir: Vec): Vec | null {
  const length = Math.hypot(dir.x, dir.y);
  if (!Number.isFinite(length) || length <= 0) return null;
  return { x: dir.x / length, y: dir.y / length };
}

/** Build the intent list for one input frame. */
export function frameIntents(steer: Vec | null, extra: readonly Intent[]): Intent[] {
  const intents: Intent[] = [];
  intents.push({ t: "steer", dir: steer ?? { x: 0, y: 0 } });
  for (const intent of extra) intents.push(intent);
  return intents;
}
