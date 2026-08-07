/**
 * What the bots remember between decisions.
 *
 * None of this is game state. It is the bots' own working notes — truck
 * itineraries, standing orders, and crucially what each side has *seen*.
 *
 * That last one matters more than it looks. Bots run server-side with the
 * whole authoritative state in hand, so it would be trivial to have a raiding
 * party walk straight to an enemy radio the instant it is planted. Doing that
 * would make every FOB-lifetime number the balance harness produces a
 * fiction. So knowledge is tracked explicitly: a structure is a valid target
 * only once somebody has actually been near enough to see it.
 */

import { Rng, type Command, type PlayerId, type TeamId } from "@redoubt/core";

export type DriverPhase = "toTruck" | "loading" | "outbound" | "unloading" | "returning";

export interface TruckPlan {
  phase: DriverPhase;
  vehicle: number | null;
}

/** A structure one team has laid eyes on, and when. */
export interface Sighting {
  id: number;
  x: number;
  y: number;
  atTick: number;
}

export interface DriverMemory {
  trucks: Map<PlayerId, TruckPlan>;
  /**
   * Continuous actions, re-issued every tick between decisions.
   *
   * Digging, reviving and moving supply are all *rates*: core accrues progress
   * per tick from whoever is working that tick. A planner that only speaks at
   * 2 Hz would build and revive at a tenth speed.
   */
  sustained: Map<PlayerId, Command>;

  /**
   * Enemy radios each team has discovered, keyed by the *observing* team.
   * Insertion-ordered, so iteration is deterministic.
   */
  knownEnemyFobs: Record<TeamId, Map<number, Sighting>>;
  /** Enemy rally points each team has stumbled onto. Short-lived by nature. */
  knownEnemyRallies: Record<TeamId, Map<number, Sighting>>;

  /** Which raider is currently assigned to which target radio. */
  raidTargets: Map<PlayerId, number>;

  rng: Rng;
}

export function createDriverMemory(seed: number): DriverMemory {
  return {
    trucks: new Map(),
    sustained: new Map(),
    knownEnemyFobs: { 0: new Map(), 1: new Map() },
    knownEnemyRallies: { 0: new Map(), 1: new Map() },
    raidTargets: new Map(),
    rng: new Rng(seed),
  };
}

/** Forget everything about a player — they are under someone else's control. */
export function forgetPlayer(memory: DriverMemory, playerId: PlayerId): void {
  memory.trucks.delete(playerId);
  memory.sustained.delete(playerId);
  memory.raidTargets.delete(playerId);
}
