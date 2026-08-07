/**
 * Applying snapshots, and interpolating between them.
 *
 * The delta protocol has one sharp edge — absence means "unchanged", not
 * "gone" — and getting it wrong produces ghosts that linger on the map. Most
 * of these tests exist to keep that edge from cutting.
 */

import { describe, expect, it } from "vitest";
import type { PlayerView, Snapshot } from "@redoubt/protocol";
import { ClientWorld } from "../src/world.js";

function player(id: number, x: number, y: number): PlayerView {
  return { id, team: 0, squad: 0, role: "rifleman", status: "alive", x, y, yaw: 0, mounted: false };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    tick: 0,
    ackSeq: 0,
    full: false,
    self: null,
    players: [],
    controlPoints: [],
    fobs: [],
    deployables: [],
    rallies: [],
    vehicles: [],
    teams: [],
    removed: { players: [], fobs: [], deployables: [], rallies: [], vehicles: [] },
    doubleNeutral: false,
    phase: "active",
    ...overrides,
  };
}

describe("applying snapshots", () => {
  it("keeps entities a delta does not mention", () => {
    const world = new ClientWorld();
    world.apply(snapshot({ tick: 10, full: true, players: [player(1, 5, 5)] }));
    world.apply(snapshot({ tick: 12, players: [] }));

    expect(world.players.get(1)?.x).toBe(5);
  });

  it("removes only what the server says is gone", () => {
    const world = new ClientWorld();
    world.apply(
      snapshot({ tick: 10, full: true, players: [player(1, 5, 5), player(2, 9, 9)] }),
    );
    world.apply(
      snapshot({
        tick: 12,
        removed: { players: [2], fobs: [], deployables: [], rallies: [], vehicles: [] },
      }),
    );

    expect(world.players.has(1)).toBe(true);
    expect(world.players.has(2)).toBe(false);
  });

  it("treats a full snapshot as a resync, dropping stale entities", () => {
    const world = new ClientWorld();
    world.apply(snapshot({ tick: 10, full: true, players: [player(1, 5, 5)] }));
    // A full frame that no longer mentions player 1: they are gone, even
    // though nothing named them in `removed`.
    world.apply(snapshot({ tick: 20, full: true, players: [player(2, 1, 1)] }));

    expect(world.players.has(1)).toBe(false);
    expect(world.players.has(2)).toBe(true);
  });
});

describe("interpolation", () => {
  it("draws between the last two samples", () => {
    const world = new ClientWorld();
    world.apply(snapshot({ tick: 10, full: true, players: [player(1, 0, 0)] }));
    world.apply(snapshot({ tick: 12, players: [player(1, 10, 0)] }));

    const track = world.players.get(1)!.track;
    expect(world.interpolate(track, 11).x).toBeCloseTo(5, 6);
    expect(world.interpolate(track, 10).x).toBeCloseTo(0, 6);
    expect(world.interpolate(track, 12).x).toBeCloseTo(10, 6);
  });

  it("refuses to extrapolate past the newest sample", () => {
    const world = new ClientWorld();
    world.apply(snapshot({ tick: 10, full: true, players: [player(1, 0, 0)] }));
    world.apply(snapshot({ tick: 12, players: [player(1, 10, 0)] }));

    const track = world.players.get(1)!.track;
    // Guessing forward looks worse than standing still, so it holds position.
    expect(world.interpolate(track, 30).x).toBeCloseTo(10, 6);
  });

  it("holds still when there is only one sample", () => {
    const world = new ClientWorld();
    world.apply(snapshot({ tick: 10, full: true, players: [player(1, 7, 7)] }));

    const track = world.players.get(1)!.track;
    expect(world.interpolate(track, 5)).toEqual({ x: 7, y: 7 });
    expect(world.interpolate(track, 50)).toEqual({ x: 7, y: 7 });
  });

  it("does not treat a repeated tick as a new sample", () => {
    const world = new ClientWorld();
    world.apply(snapshot({ tick: 10, full: true, players: [player(1, 0, 0)] }));
    world.apply(snapshot({ tick: 12, players: [player(1, 10, 0)] }));
    // Same tick again — a correction, not another step forward in time.
    world.apply(snapshot({ tick: 12, players: [player(1, 12, 0)] }));

    const track = world.players.get(1)!.track;
    expect(track.previous?.tick).toBe(10);
    expect(track.latest).toEqual({ tick: 12, x: 12, y: 0 });
  });
});
