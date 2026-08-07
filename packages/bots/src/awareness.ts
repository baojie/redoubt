/**
 * Situational awareness: the questions every role needs answered.
 *
 * Kept in one place so the roles read as decisions rather than as queries, and
 * so the rules about *what a bot is allowed to know* live somewhere findable.
 */

import {
  distance,
  rules,
  type Deployable,
  type Fob,
  type GameState,
  type Player,
  type TeamId,
  type Vec2,
  type World,
} from "@redoubt/core";
import type { DriverMemory, Sighting } from "./memory.js";

/**
 * How close a soldier must get before their team knows a structure is there.
 *
 * Generous — a FOB is a radio mast and a pile of sandbags, not a hidden cache —
 * but finite, which is the point. Below the 500 m the server culls at, so bots
 * never know more than a human client is told.
 */
export const SIGHT_RADIUS_M = 250;

/** The first point along the lane this team does not own — where the fight is. */
export function objectiveFor(state: GameState, team: TeamId) {
  const points = state.controlPoints;
  if (team === 0) {
    for (const point of points) {
      if (point.owner !== 0) return point;
    }
    return points[points.length - 1];
  }
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (point !== undefined && point.owner !== 1) return point;
  }
  return points[0];
}

/** The last point along the lane this team still holds — worth defending. */
export function rearguardFor(state: GameState, team: TeamId) {
  const points = state.controlPoints;
  const owned = points.filter((p) => p.owner === team);
  if (owned.length === 0) return undefined;
  return team === 0 ? owned[owned.length - 1] : owned[0];
}

export function nearestEnemy(state: GameState, self: Player): Player | undefined {
  let best: Player | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const other of state.players) {
    if (other.team === self.team || other.status !== "alive") continue;
    const d = distance(other.pos, self.pos);
    if (d < bestDist) {
      bestDist = d;
      best = other;
    }
  }
  return bestDist <= rules.ENGAGEMENT_MAX_RANGE_M ? best : undefined;
}

export function liveFobs(state: GameState, team: TeamId): Fob[] {
  return state.fobs.filter((f) => !f.destroyed && f.team === team);
}

export function liveHabitat(state: GameState, team: TeamId): Deployable | undefined {
  return state.deployables.find(
    (d) => d.team === team && d.type === "habitat" && d.built && !d.destroyed && !d.overrun,
  );
}

/** Is there anything within reach that could actually top this soldier up? */
export function resupplySourceInReach(state: GameState, player: Player): boolean {
  const reach = rules.RESUPPLY_REACH_M;
  for (const d of state.deployables) {
    if (d.team !== player.team || d.type !== "ammoCrate" || !d.built || d.destroyed) continue;
    if (distance(d.pos, player.pos) <= reach) return true;
  }
  for (const f of state.fobs) {
    if (f.team !== player.team || f.destroyed) continue;
    if (distance(f.pos, player.pos) <= reach) return true;
  }
  for (const v of state.vehicles) {
    if (v.team !== player.team || v.destroyed) continue;
    if (distance(v.pos, player.pos) <= reach) return true;
  }
  return distance(state.teams[player.team].mainBase, player.pos) <= rules.MAIN_BASE_RADIUS_M;
}

/**
 * A player's index within their own team, 0-based.
 *
 * Anything positional derived from a bot's identity must use this rather than
 * the raw entity id. Ids are handed out globally — team 0 gets 2..13, team 1
 * gets 16..27 — so an angle computed from `player.id` gives the two teams
 * *different* formations for the same roles. On a provably mirror-symmetric
 * map that alone produced per-lane win splits as skewed as 17/83, because one
 * side's squad leader was standing somewhere systematically better than the
 * other's.
 */
export function teamIndexOf(state: GameState, player: Player): number {
  const index = state.teams[player.team].players.indexOf(player.id);
  return index < 0 ? 0 : index;
}

/**
 * Deterministic per-player scatter so a squad forms a ring, not a stack.
 *
 * Team-relative *and mirrored for team 1*. Both matter. Using the same angle
 * for the same index on both sides sounds symmetric and is not: the map is
 * mirror-symmetric about its centre line, so the fair counterpart of standing
 * at angle θ is standing at π − θ, not at θ. Copying the formation instead of
 * reflecting it left a residual bias worth 15 points of win rate on some lanes
 * even after the map and the id-keying were both fixed.
 */
export function spreadAround(
  state: GameState,
  centre: Vec2,
  player: Player,
  radius: number,
): Vec2 {
  const base = (teamIndexOf(state, player) * Math.PI * 2) / rules.PLAYERS_PER_TEAM;
  const angle = player.team === 0 ? base : Math.PI - base;
  return { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius };
}

/**
 * Which way a bot should swing when it flanks, mirrored for team 1 for the
 * same reason as the formation above.
 */
export function flankSide(state: GameState, player: Player): 1 | -1 {
  const even = teamIndexOf(state, player) % 2 === 0;
  const side = even ? 1 : -1;
  return (player.team === 0 ? side : -side) as 1 | -1;
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

/**
 * Update what each side has seen.
 *
 * Run once per decision tick, before any role acts. Structures are remembered
 * until they are destroyed: a radio mast does not move, so forgetting one
 * would be stranger than remembering it.
 */
export function updateSightings(state: GameState, memory: DriverMemory): void {
  for (const fob of state.fobs) {
    const enemy: TeamId = fob.team === 0 ? 1 : 0;
    const known = memory.knownEnemyFobs[enemy];
    if (fob.destroyed) {
      known.delete(fob.id);
      continue;
    }
    if (known.has(fob.id)) continue;
    if (spotted(state, enemy, fob.pos)) {
      known.set(fob.id, { id: fob.id, x: fob.pos.x, y: fob.pos.y, atTick: state.tick });
    }
  }

  for (const rally of state.rallyPoints) {
    const enemy: TeamId = rally.team === 0 ? 1 : 0;
    const known = memory.knownEnemyRallies[enemy];
    if (rally.destroyed) {
      known.delete(rally.id);
      continue;
    }
    if (known.has(rally.id)) continue;
    if (spotted(state, enemy, rally.pos)) {
      known.set(rally.id, { id: rally.id, x: rally.pos.x, y: rally.pos.y, atTick: state.tick });
    }
  }
}

function spotted(state: GameState, observingTeam: TeamId, pos: Vec2): boolean {
  for (const player of state.players) {
    if (player.team !== observingTeam || player.status !== "alive") continue;
    if (distance(player.pos, pos) <= SIGHT_RADIUS_M) return true;
  }
  return false;
}

/** Known enemy radios, nearest to `from` first. Only ones still standing. */
export function knownEnemyFobs(
  state: GameState,
  memory: DriverMemory,
  team: TeamId,
  from: Vec2,
): Sighting[] {
  const alive = new Set(state.fobs.filter((f) => !f.destroyed).map((f) => f.id));
  return [...memory.knownEnemyFobs[team].values()]
    .filter((s) => alive.has(s.id))
    .sort((a, b) => distance(a, from) - distance(b, from) || a.id - b.id);
}

/** Known enemy rallies, nearest first. Cheap to kill and worth the detour. */
export function knownEnemyRallies(
  state: GameState,
  memory: DriverMemory,
  team: TeamId,
  from: Vec2,
): Sighting[] {
  const alive = new Set(state.rallyPoints.filter((r) => !r.destroyed).map((r) => r.id));
  return [...memory.knownEnemyRallies[team].values()]
    .filter((s) => alive.has(s.id))
    .sort((a, b) => distance(a, from) - distance(b, from) || a.id - b.id);
}

/**
 * Where a raiding party should look when it has no confirmed target: behind
 * the contested flag, on the enemy's side. That is where a FOB has to be —
 * close enough to feed the fight, far enough back to survive it — so sweeping
 * there is reconnaissance rather than a lucky guess.
 */
export function likelyEnemyFobArea(state: GameState, team: TeamId): Vec2 | undefined {
  const objective = objectiveFor(state, team);
  if (objective === undefined) return undefined;
  const enemyMain = state.teams[team === 0 ? 1 : 0].mainBase;
  const dx = enemyMain.x - objective.pos.x;
  const dy = enemyMain.y - objective.pos.y;
  const length = Math.hypot(dx, dy) || 1;
  const standoff = Math.min(FOB_SEARCH_STANDOFF_M, length - rules.MAIN_BASE_RADIUS_M);
  return {
    x: objective.pos.x + (dx / length) * standoff,
    y: objective.pos.y + (dy / length) * standoff,
  };
}

/** How far behind the contested flag to sweep for an undiscovered radio. */
const FOB_SEARCH_STANDOFF_M = 260;

/** Nearest live friendly FOB to a position. */
export function nearestFob(fobs: readonly Fob[], to: Vec2): Fob | undefined {
  let best: Fob | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const fob of fobs) {
    const d = distance(fob.pos, to);
    if (d < bestDist) {
      bestDist = d;
      best = fob;
    }
  }
  return best;
}

/** Look up a player without scanning the array. */
export function playerById(world: World, id: number): Player | undefined {
  return world.player(id);
}
