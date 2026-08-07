/**
 * Control point contest resolution and the RAAS lane ordering constraint.
 *
 * `state.controlPoints` holds only the points on the lane RAAS drew, already
 * in lane order: index 0 sits nearest team 0's main, the last index nearest
 * team 1's. That ordering is the topology, so the sequential-attack rule is a
 * prefix/suffix check rather than a graph walk.
 */

import { withinRange } from "../math.js";
import {
  CAPTURE_DECAY_MULTIPLIER,
  CAPTURE_EVAL_INTERVAL_TICKS,
  CAPTURE_RADIUS_M,
  CAPTURE_TICKS,
  DOUBLE_NEUTRAL_MIN_NEUTRAL_POINTS,
  NEUTRALISE_TICKS,
  TICKET_GAIN_FIRST_CAPTURE,
  captureSpeedMultiplier,
} from "../rules.js";
import type { ControlPoint, TeamId } from "../types.js";
import { enemyOf } from "../types.js";
import type { World } from "../world.js";
import { adjustTickets } from "./tickets.js";

/**
 * Can `team` legally change the ownership of the point at `index`?
 *
 * Team 0 attacks up the lane and must hold every point behind it; team 1
 * attacks down the lane and must hold every point behind it. This is the
 * whole of CLAUDE.md invariant #4.
 */
export function canTeamContest(
  points: readonly ControlPoint[],
  index: number,
  team: TeamId,
): boolean {
  if (team === 0) {
    for (let j = 0; j < index; j++) {
      if (points[j]?.owner !== 0) return false;
    }
    return true;
  }
  for (let j = index + 1; j < points.length; j++) {
    if (points[j]?.owner !== 1) return false;
  }
  return true;
}

/** Count of alive, on-foot-or-mounted players of each team inside the radius. */
function presenceAt(world: World, point: ControlPoint): [number, number] {
  let team0 = 0;
  let team1 = 0;
  for (const player of world.state.players) {
    if (player.status !== "alive") continue;
    if (!withinRange(player.pos, point.pos, CAPTURE_RADIUS_M)) continue;
    if (player.team === 0) team0++;
    else team1++;
  }
  return [team0, team1];
}

export function updateControlPoints(world: World): void {
  const state = world.state;
  if (state.phase !== "active") return;
  if (state.tick % CAPTURE_EVAL_INTERVAL_TICKS !== 0) return;

  const points = state.controlPoints;

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point === undefined) continue;

    // A team only exerts pressure where the lane lets it act and where there
    // is something to gain — you cannot "capture" a flag you already own.
    const eligible0 = canTeamContest(points, i, 0) && point.owner !== 0;
    const eligible1 = canTeamContest(points, i, 1) && point.owner !== 1;

    const [count0, count1] = presenceAt(world, point);

    // Defenders always count, whether or not the lane lets them attack.
    const advantage0 = count0 - count1;
    const attacker: TeamId | null =
      advantage0 > 0 && eligible0 ? 0 : advantage0 < 0 && eligible1 ? 1 : null;

    const phaseTicks = point.owner === null ? CAPTURE_TICKS : NEUTRALISE_TICKS;
    const perEval = CAPTURE_EVAL_INTERVAL_TICKS / phaseTicks;

    if (attacker !== null && (point.contestingTeam === null || point.contestingTeam === attacker)) {
      point.contestingTeam = attacker;
      const speed = captureSpeedMultiplier(Math.abs(advantage0));
      point.progress += perEval * speed;
      if (point.progress >= 1) {
        resolveContest(world, point, attacker);
      }
      continue;
    }

    if (point.contestingTeam !== null) {
      // Either the defenders have the numbers, or nobody does. Progress unwinds.
      const defender = enemyOf(point.contestingTeam);
      const defenderAdvantage = defender === 0 ? advantage0 : -advantage0;
      const speed =
        defenderAdvantage > 0
          ? captureSpeedMultiplier(defenderAdvantage)
          : CAPTURE_DECAY_MULTIPLIER;
      point.progress -= perEval * speed;
      if (point.progress <= 0) {
        point.progress = 0;
        point.contestingTeam = null;
      }
    }
  }

  updateNeutralStatus(world);
}

/**
 * Cancel any contest that the current ownership no longer permits.
 *
 * Losing a point behind you locks the one in front *immediately*, and any
 * progress banked on it is gone rather than slowly decaying — otherwise a
 * squad keeps ticking over a flag the lane has already taken away from them.
 *
 * Run this the moment ownership changes, not on the next evaluation tick, so
 * the state is never transiently inconsistent (CLAUDE.md invariant #4).
 */
function cancelIllegalContests(points: readonly ControlPoint[]): void {
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point === undefined || point.contestingTeam === null) continue;
    const team = point.contestingTeam;
    if (canTeamContest(points, i, team) && point.owner !== team) continue;
    point.contestingTeam = null;
    point.progress = 0;
  }
}

function resolveContest(world: World, point: ControlPoint, attacker: TeamId): void {
  point.progress = 0;
  point.contestingTeam = null;

  if (point.owner !== null) {
    // Phase one: the point drops to neutral. Taking it needs a second pass.
    const formerOwner = point.owner;
    point.owner = null;
    cancelIllegalContests(world.state.controlPoints);
    world.emit({
      t: "controlPointNeutralised",
      tick: world.state.tick,
      point: point.id,
      by: attacker,
      formerOwner,
    });
    return;
  }

  const firstEver = point.everOwnedBy.length === 0;
  point.owner = attacker;
  if (!point.everOwnedBy.includes(attacker)) point.everOwnedBy.push(attacker);
  cancelIllegalContests(world.state.controlPoints);
  world.emit({
    t: "controlPointCaptured",
    tick: world.state.tick,
    point: point.id,
    by: attacker,
    firstEver,
  });
  if (firstEver) {
    adjustTickets(world, attacker, TICKET_GAIN_FIRST_CAPTURE, "firstCapture");
  }
}

/**
 * Double neutral: two or more lane points sitting neutral at once means both
 * teams have cracked the other's defended flag and the front line is
 * genuinely ambiguous. All bleed pauses until it resolves — PLAN §2.1.
 */
function updateNeutralStatus(world: World): void {
  const state = world.state;
  let neutral = 0;
  for (const point of state.controlPoints) {
    if (point.owner === null) neutral++;
  }
  const nowDoubleNeutral = neutral >= DOUBLE_NEUTRAL_MIN_NEUTRAL_POINTS;
  if (nowDoubleNeutral === state.doubleNeutral) return;

  state.doubleNeutral = nowDoubleNeutral;
  world.emit(
    nowDoubleNeutral
      ? { t: "doubleNeutralStarted", tick: state.tick }
      : { t: "doubleNeutralEnded", tick: state.tick },
  );
}

/** Flags currently held by each team. Used by the bleed system and reports. */
export function flagCounts(world: World): Record<TeamId, number> {
  const counts: Record<TeamId, number> = { 0: 0, 1: 0 };
  for (const point of world.state.controlPoints) {
    if (point.owner !== null) counts[point.owner]++;
  }
  return counts;
}
