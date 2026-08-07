/**
 * The five invariants from CLAUDE.md, as property tests.
 *
 * These are the guard rails. A change that makes them fail is wrong even if
 * every example test still passes, and the fix is always the implementation —
 * never the invariant.
 *
 * They live in `sim` rather than `core` because auditing a *whole match*
 * needs something to play it, and `core` decides nothing — it only adjudicates.
 * Nothing here reaches into core's internals; it drives the same public
 * surface a server would.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Simulation,
  TEAM_IDS,
  World,
  canTeamContest,
  distance,
  rules,
  type GameState,
  type TeamId,
} from "@redoubt/core";
import { createDriverMemory, decide } from "@redoubt/bots";

/** A seed generator that keeps failures easy to reproduce by hand. */
const seeds = fc.integer({ min: 1, max: 1_000_000 });

interface Violation {
  tick: number;
  what: string;
}

/**
 * Run a match to completion, checking every invariant on every tick.
 * Returns the first violation, or null.
 */
function auditMatch(seed: number, maxTicks: number): Violation | null {
  const sim = Simulation.create({ seed });
  const memory = createDriverMemory(seed ^ 0x5bf03635);
  const state = sim.state;
  const view = new World(state);

  const previousTickets: Record<TeamId, number> = {
    0: state.teams[0].tickets,
    1: state.teams[1].tickets,
  };

  while (!sim.finished && state.tick < maxTicks) {
    const events = sim.step(decide(state, view, memory));

    // Invariant 1: tickets stay non-negative, and only rise on an explicit gain.
    const gains: Record<TeamId, number> = { 0: 0, 1: 0 };
    for (const event of events) {
      if (event.t === "ticketChange" && event.delta > 0) gains[event.team] += event.delta;
    }
    for (const team of TEAM_IDS) {
      const now = state.teams[team].tickets;
      if (now < 0) return { tick: state.tick, what: `team ${team} tickets ${now} < 0` };
      if (now > previousTickets[team] + gains[team]) {
        return {
          tick: state.tick,
          what: `team ${team} tickets rose from ${previousTickets[team]} to ${now} without a gain event`,
        };
      }
      previousTickets[team] = now;
    }

    const structural = auditState(state);
    if (structural !== null) return { tick: state.tick, what: structural };
  }

  return null;
}

/** Invariants 2, 3 and 4, checkable against a state on its own. */
function auditState(state: GameState): string | null {
  const live = state.fobs.filter((f) => !f.destroyed);

  // Invariant 2: FOB spacing.
  for (let i = 0; i < live.length; i++) {
    const a = live[i]!;
    for (const team of TEAM_IDS) {
      const d = distance(a.pos, state.teams[team].mainBase);
      if (d < rules.FOB_MIN_DISTANCE_FROM_MAIN_BASE_M) {
        return `fob ${a.id} is ${d.toFixed(1)} m from a main base`;
      }
    }
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j]!;
      if (a.team !== b.team) continue;
      const d = distance(a.pos, b.pos);
      if (d < rules.FOB_MIN_DISTANCE_FROM_FRIENDLY_FOB_M) {
        return `fobs ${a.id}/${b.id} are ${d.toFixed(1)} m apart`;
      }
    }

    // Invariant 3: supply pools stay in range.
    if (a.constructionPoints < 0 || a.constructionPoints > rules.FOB_MAX_CONSTRUCTION_POINTS) {
      return `fob ${a.id} construction points out of range: ${a.constructionPoints}`;
    }
    if (a.ammoPoints < 0 || a.ammoPoints > rules.FOB_MAX_AMMO_POINTS) {
      return `fob ${a.id} ammo points out of range: ${a.ammoPoints}`;
    }
  }

  // Invariant 4: lane topology. Ownership is always a prefix held by team 0, a
  // suffix held by team 1, and neutral ground in between — never a pocket
  // behind enemy lines, because the sequential rule makes one unreachable.
  const points = state.controlPoints;
  let index = 0;
  while (index < points.length && points[index]!.owner === 0) index++;
  const prefixEnd = index;
  while (index < points.length && points[index]!.owner === null) index++;
  const neutralEnd = index;
  while (index < points.length && points[index]!.owner === 1) index++;
  if (index !== points.length) {
    const owners = points.map((p) => (p.owner === null ? "-" : p.owner)).join("");
    return `lane ownership is not prefix/neutral/suffix: ${owners}`;
  }

  // The same rule, from the other direction: any contest in flight must be
  // one the contesting team is actually allowed to make.
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    if (point.contestingTeam === null) continue;
    if (!canTeamContest(points, i, point.contestingTeam)) {
      return `point ${point.id} is being contested by team ${point.contestingTeam} out of order`;
    }
  }
  void prefixEnd;
  void neutralEnd;

  // Ancillary: nothing should ever hold a negative amount of anything.
  for (const player of state.players) {
    if (player.ammo < 0) return `player ${player.id} has negative ammo`;
    if (player.health < 0 && player.status === "alive") {
      return `player ${player.id} is alive at ${player.health} health`;
    }
  }
  for (const vehicle of state.vehicles) {
    if (vehicle.cargoConstructionPoints < 0 || vehicle.cargoAmmoPoints < 0) {
      return `vehicle ${vehicle.id} has negative cargo`;
    }
  }

  return null;
}

// A full match is ~50k ticks. Auditing every tick of a handful of matches
// covers far more state combinations than any hand-written example can.
const AUDIT_TICK_LIMIT = rules.MATCH_MAX_TICKS;

describe("invariants hold across whole matches", () => {
  it("survives an audited match on arbitrary seeds", () => {
    fc.assert(
      fc.property(seeds, (seed) => {
        const violation = auditMatch(seed, AUDIT_TICK_LIMIT);
        if (violation !== null) {
          throw new Error(`seed ${seed} @ tick ${violation.tick}: ${violation.what}`);
        }
      }),
      { numRuns: 6, verbose: true },
    );
  });
});

describe("determinism", () => {
  it("produces identical per-tick hashes for the same seed", () => {
    fc.assert(
      fc.property(seeds, (seed) => {
        const a = hashRun(seed, 4000);
        const b = hashRun(seed, 4000);
        expect(a).toEqual(b);
      }),
      { numRuns: 8 },
    );
  });

  it("produces different histories for different seeds", () => {
    const a = hashRun(1, 4000);
    const b = hashRun(2, 4000);
    expect(a).not.toEqual(b);
  });

  it("resumes from a snapshot with an identical future", () => {
    const seed = 12345;
    const straightThrough = hashRun(seed, 3000);

    // Run half, serialise, restore, run the rest.
    const sim = Simulation.create({ seed });
    const memory = createDriverMemory(seed ^ 0x5bf03635);
    const view = new World(sim.state);
    for (let i = 0; i < 1500; i++) sim.step(decide(sim.state, view, memory));

    const snapshot: GameState = JSON.parse(JSON.stringify(sim.state));
    const resumed = Simulation.fromState(snapshot);
    const resumedView = new World(resumed.state);
    // The driver's own memory is not part of game state, so rebuild it the
    // way a fresh server process would: from the seed.
    const resumedMemory = createDriverMemory(seed ^ 0x5bf03635);
    for (const [id, plan] of memory.trucks) resumedMemory.trucks.set(id, { ...plan });
    for (const [id, cmd] of memory.sustained) resumedMemory.sustained.set(id, cmd);

    const tail: number[] = [];
    for (let i = 1500; i < 3000; i++) {
      resumed.step(decide(resumed.state, resumedView, resumedMemory));
      tail.push(resumed.hash());
    }

    expect(tail).toEqual(straightThrough.slice(1500));
  });
});

function hashRun(seed: number, ticks: number): number[] {
  const sim = Simulation.create({ seed });
  const memory = createDriverMemory(seed ^ 0x5bf03635);
  const view = new World(sim.state);
  const hashes: number[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.step(decide(sim.state, view, memory));
    hashes.push(sim.hash());
  }
  return hashes;
}
