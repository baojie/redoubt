/**
 * The client's mirror of the world.
 *
 * Two distinct jobs, and keeping them apart is what makes the netcode legible:
 *
 *  - **Everyone else** is *interpolated*. Their positions are known only at
 *    snapshot instants, so the client renders one snapshot interval in the
 *    past and draws them between the two frames it has. Smooth, and honest
 *    about being slightly stale — PLAN §4.
 *  - **You** are *predicted*. Your own input is applied locally the instant you
 *    press a key, then reconciled against the server's version when it
 *    arrives. See prediction.ts.
 *
 * Nothing in here is authoritative. Every value is the server's most recent
 * word on the subject, or a guess clearly labelled as one.
 */

import type {
  ControlPointView,
  DeployableView,
  FobView,
  PlayerView,
  RallyView,
  SelfView,
  Snapshot,
  TeamView,
  VehicleView,
} from "@redoubt/protocol";

/** Two samples is all interpolation needs; more is memory for nothing. */
interface Track {
  previous: { tick: number; x: number; y: number } | null;
  latest: { tick: number; x: number; y: number };
}

export interface RemotePlayer extends PlayerView {
  track: Track;
}

export interface RemoteVehicle extends VehicleView {
  track: Track;
}

export class ClientWorld {
  readonly players = new Map<number, RemotePlayer>();
  readonly fobs = new Map<number, FobView>();
  readonly deployables = new Map<number, DeployableView>();
  readonly rallies = new Map<number, RallyView>();
  readonly vehicles = new Map<number, RemoteVehicle>();
  readonly controlPoints = new Map<number, ControlPointView>();
  readonly teams = new Map<number, TeamView>();

  self: SelfView | null = null;
  tick = 0;
  phase: Snapshot["phase"] = "staging";
  doubleNeutral = false;
  lastAckSeq = 0;

  apply(snapshot: Snapshot): void {
    this.tick = snapshot.tick;
    this.phase = snapshot.phase;
    this.doubleNeutral = snapshot.doubleNeutral;
    this.lastAckSeq = snapshot.ackSeq;
    this.self = snapshot.self;

    // A full snapshot is a resync: anything it does not mention no longer
    // exists as far as this client is concerned.
    if (snapshot.full) {
      this.players.clear();
      this.fobs.clear();
      this.deployables.clear();
      this.rallies.clear();
      this.vehicles.clear();
    }

    for (const view of snapshot.players) {
      const existing = this.players.get(view.id);
      this.players.set(view.id, {
        ...view,
        track: advance(existing?.track, snapshot.tick, view.x, view.y),
      });
    }
    for (const view of snapshot.vehicles) {
      const existing = this.vehicles.get(view.id);
      this.vehicles.set(view.id, {
        ...view,
        track: advance(existing?.track, snapshot.tick, view.x, view.y),
      });
    }
    for (const view of snapshot.fobs) this.fobs.set(view.id, view);
    for (const view of snapshot.deployables) this.deployables.set(view.id, view);
    for (const view of snapshot.rallies) this.rallies.set(view.id, view);
    for (const view of snapshot.controlPoints) this.controlPoints.set(view.id, view);
    for (const view of snapshot.teams) this.teams.set(view.id, view);

    // Absence from a delta means "unchanged", so departures must be explicit.
    for (const id of snapshot.removed.players) this.players.delete(id);
    for (const id of snapshot.removed.fobs) this.fobs.delete(id);
    for (const id of snapshot.removed.deployables) this.deployables.delete(id);
    for (const id of snapshot.removed.rallies) this.rallies.delete(id);
    for (const id of snapshot.removed.vehicles) this.vehicles.delete(id);
  }

  /**
   * Where to draw an entity at `renderTick`, which is deliberately behind the
   * latest snapshot. Extrapolation is refused: if the render time is past the
   * newest sample the entity simply stops, because guessing forward produces
   * rubber-banding that looks far worse than a moment of stillness.
   */
  interpolate(track: Track, renderTick: number): { x: number; y: number } {
    const { previous, latest } = track;
    if (previous === null || latest.tick <= previous.tick) {
      return { x: latest.x, y: latest.y };
    }
    if (renderTick >= latest.tick) return { x: latest.x, y: latest.y };
    if (renderTick <= previous.tick) return { x: previous.x, y: previous.y };

    const t = (renderTick - previous.tick) / (latest.tick - previous.tick);
    return {
      x: previous.x + (latest.x - previous.x) * t,
      y: previous.y + (latest.y - previous.y) * t,
    };
  }
}

function advance(
  existing: Track | undefined,
  tick: number,
  x: number,
  y: number,
): Track {
  if (existing === undefined) {
    return { previous: null, latest: { tick, x, y } };
  }
  // Same tick twice means a redundant update, not a new sample.
  if (existing.latest.tick === tick) {
    return { previous: existing.previous, latest: { tick, x, y } };
  }
  return { previous: existing.latest, latest: { tick, x, y } };
}
