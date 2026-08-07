/**
 * Headless match runner.
 *
 * Drives a whole match to completion with no rendering, no network and no
 * wall clock. Everything it produces is a pure function of the seed, which is
 * what makes `--matches 1000` a balance instrument rather than a lava lamp.
 */

import { Simulation, flagCounts, rules, World, type TeamId } from "@redoubt/core";
import { createDriverMemory, decide } from "@redoubt/bots";
import {
  accumulate,
  emptyTeamStats,
  type MatchStats,
} from "./report.js";

export interface RunOptions {
  seed: number;
  /** Stop early regardless of the rules' own match cap. Testing aid. */
  maxTicks?: number;
  laneName?: string;
  playersPerTeam?: number;
  /** Record a per-tick state hash. Off by default: it costs real time. */
  recordHashes?: boolean;
}

export interface RunResult {
  stats: MatchStats;
  hashes: number[];
}

const TICKS_PER_MINUTE = rules.secondsToTicks(rules.SECONDS_PER_MINUTE);

export function runMatch(options: RunOptions): RunResult {
  const sim = Simulation.create({
    seed: options.seed,
    laneName: options.laneName,
    playersPerTeam: options.playersPerTeam,
  });
  // The driver gets its own RNG stream so its choices never perturb the
  // simulation's stream — the two must stay independently reproducible.
  const memory = createDriverMemory(options.seed ^ DRIVER_SEED_SALT);

  const state = sim.state;
  const stats: MatchStats = {
    seed: options.seed,
    map: state.map.name,
    lane: state.lane.name,
    pointNames: new Map(state.controlPoints.map((c) => [c.id, c.name])),
    durationTicks: 0,
    winner: null,
    endReason: "unfinished",
    ticketTimeline: [],
    flagEvents: [],
    habitatBuilds: [],
    teams: [emptyTeamStats(), emptyTeamStats()],
    doubleNeutralTicks: 0,
    mercyBleedTicks: 0,
    rejections: new Map(),
    finalHash: 0,
  };

  const hashes: number[] = [];
  const limit = options.maxTicks ?? rules.MATCH_MAX_TICKS;
  // flagCounts needs a World; building one per sample would churn, so reuse.
  const view = new World(state);

  while (!sim.finished && state.tick < limit) {
    if (state.tick % TICKS_PER_MINUTE === 0) {
      const counts = flagCounts(view);
      stats.ticketTimeline.push({
        minute: Math.floor(state.tick / TICKS_PER_MINUTE),
        tickets: [state.teams[0].tickets, state.teams[1].tickets],
        flags: [counts[0], counts[1]],
      });
    }
    if (state.doubleNeutral) stats.doubleNeutralTicks++;
    for (const team of [0, 1] as const) {
      if (state.teams[team].mercyBleedStartedAtTick !== null) stats.mercyBleedTicks++;
    }

    const commands = decide(state, view, memory);
    const events = sim.step(commands);
    accumulate(stats, events);
    if (options.recordHashes === true) hashes.push(sim.hash());
  }

  stats.durationTicks = state.tick;
  for (const team of [0, 1] as const) {
    stats.teams[team].finalTickets = state.teams[team].tickets;
  }
  if (stats.endReason === "unfinished") {
    stats.winner = pickLeader(state.teams[0].tickets, state.teams[1].tickets);
    stats.endReason = "tick limit reached";
  }
  stats.finalHash = sim.hash();

  return { stats, hashes };
}

function pickLeader(a: number, b: number): TeamId | null {
  if (a === b) return null;
  return a > b ? 0 : 1;
}

/**
 * Keeps the driver's RNG stream from colliding with the simulation's when both
 * are seeded from the same match seed.
 */
const DRIVER_SEED_SALT = 0x9e3779b9;
