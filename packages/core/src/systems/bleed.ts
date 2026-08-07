/**
 * Ticket bleed and the match end condition.
 *
 * Three pressures, in strict precedence:
 *   1. Double neutral pauses everything — PLAN §2.1.
 *   2. Mercy bleed, when one team owns every point on the lane: a flat
 *      60 tickets drained over 60 seconds.
 *   3. Otherwise positional bleed, scaled by how many flags a team is behind.
 */

import {
  BLEED_EVAL_INTERVAL_TICKS,
  BLEED_TICKETS_PER_FLAG_LEAD_PER_MINUTE,
  MATCH_MAX_TICKS,
  MERCY_BLEED_DURATION_S,
  MERCY_BLEED_TOTAL_TICKETS,
  SECONDS_PER_MINUTE,
  ticksToSeconds,
} from "../rules.js";
import { TEAM_IDS } from "../state.js";
import type { TeamId } from "../types.js";
import { enemyOf } from "../types.js";
import type { World } from "../world.js";
import { flagCounts } from "./capture.js";
import { applyFractionalBleed } from "./tickets.js";

const MERCY_TICKETS_PER_SECOND = MERCY_BLEED_TOTAL_TICKETS / MERCY_BLEED_DURATION_S;

export function updateBleed(world: World): void {
  const state = world.state;
  if (state.phase !== "active") return;
  if (state.tick % BLEED_EVAL_INTERVAL_TICKS !== 0) return;

  const elapsedSeconds = ticksToSeconds(BLEED_EVAL_INTERVAL_TICKS);
  const counts = flagCounts(world);
  const totalPoints = state.controlPoints.length;

  // Precedence 1: a double neutral freezes every bleed source.
  if (state.doubleNeutral) {
    for (const team of TEAM_IDS) clearMercy(world, team);
    return;
  }

  // Precedence 2: mercy bleed.
  let mercyApplied = false;
  for (const team of TEAM_IDS) {
    const owner = counts[team];
    if (totalPoints > 0 && owner === totalPoints) {
      const victim = enemyOf(team);
      startMercy(world, victim);
      applyFractionalBleed(
        world,
        victim,
        MERCY_TICKETS_PER_SECOND * elapsedSeconds,
        "mercyBleed",
      );
      clearMercy(world, team);
      mercyApplied = true;
    }
  }
  if (mercyApplied) return;

  for (const team of TEAM_IDS) clearMercy(world, team);

  // Precedence 3: positional bleed for whoever is behind on flags.
  const lead = counts[0] - counts[1];
  if (lead === 0) return;
  const behind: TeamId = lead > 0 ? 1 : 0;
  const magnitude = Math.abs(lead);
  const perSecond =
    (BLEED_TICKETS_PER_FLAG_LEAD_PER_MINUTE * magnitude) / SECONDS_PER_MINUTE;
  applyFractionalBleed(world, behind, perSecond * elapsedSeconds, "positionalBleed");
}

function startMercy(world: World, team: TeamId): void {
  const t = world.state.teams[team];
  if (t.mercyBleedStartedAtTick !== null) return;
  t.mercyBleedStartedAtTick = world.state.tick;
  world.emit({ t: "mercyBleedStarted", tick: world.state.tick, bleeding: team });
}

function clearMercy(world: World, team: TeamId): void {
  const t = world.state.teams[team];
  if (t.mercyBleedStartedAtTick === null) return;
  t.mercyBleedStartedAtTick = null;
  world.emit({ t: "mercyBleedEnded", tick: world.state.tick, bleeding: team });
}

/** Terminal conditions: a team out of tickets, or the clock running out. */
export function updateMatchEnd(world: World): void {
  const state = world.state;
  if (state.phase === "finished") return;

  for (const team of TEAM_IDS) {
    if (state.teams[team].tickets > 0) continue;
    const winner = enemyOf(team);
    state.phase = "finished";
    state.outcome = { kind: "ticketsExhausted", winner, loser: team };
    world.emit({
      t: "matchEnded",
      tick: state.tick,
      winner,
      reason: "tickets exhausted",
    });
    return;
  }

  if (state.tick >= MATCH_MAX_TICKS) {
    const t0 = state.teams[0].tickets;
    const t1 = state.teams[1].tickets;
    const winner: TeamId | null = t0 === t1 ? null : t0 > t1 ? 0 : 1;
    state.phase = "finished";
    state.outcome = { kind: "timeLimit", winner };
    world.emit({ t: "matchEnded", tick: state.tick, winner, reason: "time limit" });
  }
}
