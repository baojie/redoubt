/**
 * Prediction and reconciliation.
 *
 * The whole point of this machinery is that the server always wins *without*
 * the player feeling it. These tests pin both halves: the authoritative
 * position is always adopted, and input issued since that position was
 * computed is never lost.
 */

import { describe, expect, it } from "vitest";
import { rules } from "@redoubt/core";
import { Predictor, normaliseSteer } from "../src/prediction.js";

const EAST = { x: 1, y: 0 };
const STEP = rules.PLAYER_SPEED_M_PER_TICK;

describe("local prediction", () => {
  it("moves immediately, without waiting for the server", () => {
    const predictor = new Predictor();
    predictor.reset({ x: 100, y: 100 });

    predictor.predict({ seq: 1, steer: EAST });

    expect(predictor.position.x).toBeCloseTo(100 + STEP, 9);
  });

  it("does nothing until the server has said where we are", () => {
    const predictor = new Predictor();
    predictor.predict({ seq: 1, steer: EAST });
    expect(predictor.position).toEqual({ x: 0, y: 0 });
  });

  it("moves at exactly the speed core uses", () => {
    const predictor = new Predictor();
    predictor.reset({ x: 0, y: 0 });
    const ticks = rules.secondsToTicks(3);
    for (let i = 1; i <= ticks; i++) predictor.predict({ seq: i, steer: EAST });

    expect(predictor.position.x).toBeCloseTo(rules.PLAYER_SPEED_MPS * 3, 6);
  });
});

describe("reconciliation", () => {
  it("keeps unacknowledged input when the server's position arrives", () => {
    const predictor = new Predictor();
    predictor.reset({ x: 0, y: 0 });

    // Five frames sent; the server has only seen the first two.
    for (let i = 1; i <= 5; i++) predictor.predict({ seq: i, steer: EAST });
    const serverPositionAfterTwo = { x: STEP * 2, y: 0 };
    predictor.reconcile(serverPositionAfterTwo, 2);

    // Frames 3, 4 and 5 are replayed on top: we end up where we already were.
    expect(predictor.position.x).toBeCloseTo(STEP * 5, 9);
    expect(predictor.lastErrorM).toBeCloseTo(0, 9);
    expect(predictor.pendingCount).toBe(3);
  });

  it("accepts a correction the client did not see coming", () => {
    const predictor = new Predictor();
    predictor.reset({ x: 0, y: 0 });
    for (let i = 1; i <= 3; i++) predictor.predict({ seq: i, steer: EAST });

    // The server says we were blocked and never moved at all.
    predictor.reconcile({ x: 0, y: 0 }, 3);

    expect(predictor.position).toEqual({ x: 0, y: 0 });
    expect(predictor.lastErrorM).toBeCloseTo(STEP * 3, 9);
    expect(predictor.pendingCount).toBe(0);
  });

  it("reports zero error while client and server agree", () => {
    const predictor = new Predictor();
    predictor.reset({ x: 50, y: 50 });

    let serverX = 50;
    for (let seq = 1; seq <= 40; seq++) {
      predictor.predict({ seq, steer: EAST });
      // Server is three frames behind, as it would be at ~150ms ping.
      if (seq > 3) {
        serverX += STEP;
        predictor.reconcile({ x: serverX, y: 50 }, seq - 3);
        expect(predictor.lastErrorM).toBeLessThan(1e-9);
      }
    }
  });

  it("drops acknowledged frames so the queue does not grow forever", () => {
    const predictor = new Predictor();
    predictor.reset({ x: 0, y: 0 });
    for (let i = 1; i <= 100; i++) predictor.predict({ seq: i, steer: EAST });
    expect(predictor.pendingCount).toBe(100);

    predictor.reconcile({ x: STEP * 98, y: 0 }, 98);
    expect(predictor.pendingCount).toBe(2);
  });

  it("snaps outright when we are not the ones moving", () => {
    const predictor = new Predictor();
    predictor.reset({ x: 0, y: 0 });
    for (let i = 1; i <= 5; i++) predictor.predict({ seq: i, steer: EAST });

    // Riding in a truck: replaying our own footsteps would be nonsense.
    predictor.snapTo({ x: 400, y: 400 });

    expect(predictor.position).toEqual({ x: 400, y: 400 });
    expect(predictor.pendingCount).toBe(0);
    expect(predictor.lastErrorM).toBe(0);
  });

  it("initialises from the first snapshot rather than guessing", () => {
    const predictor = new Predictor();
    predictor.reconcile({ x: 123, y: 456 }, 0);
    expect(predictor.position).toEqual({ x: 123, y: 456 });
  });
});

describe("steer normalisation", () => {
  it("matches the server, so diagonals are not faster", () => {
    const diagonal = normaliseSteer({ x: 1, y: 1 })!;
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1, 9);
  });

  it("treats no input as no direction", () => {
    expect(normaliseSteer({ x: 0, y: 0 })).toBeNull();
  });
});
