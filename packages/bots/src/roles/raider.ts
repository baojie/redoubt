/**
 * The raiding party.
 *
 * Somebody has to go and kill the enemy's respawns, and until this role
 * existed nobody did. Without it the whole expensive-but-durable half of the
 * spawn economy was untested: in a thousand headless matches not one FOB radio
 * was ever destroyed, so FOB lifetime and the −20 ticket rule were rules that
 * passed their unit tests and had never once fired in anger.
 *
 * Two things keep this honest:
 *
 *  - Raiders only pursue structures their team has actually *seen*
 *    (see awareness.ts). An omniscient raider would delete FOBs the moment
 *    they were planted and make every lifetime statistic meaningless.
 *  - When they have no confirmed target they sweep the ground where a FOB
 *    would have to be, which is reconnaissance rather than a lucky guess.
 */

import {
  distance,
  rules,
  type Command,
  type GameState,
  type Player,
  type Vec2,
} from "@redoubt/core";
import {
  knownEnemyFobs,
  knownEnemyRallies,
  likelyEnemyFobArea,
  flankSide,
  objectiveFor,
  spreadAround,
} from "../awareness.js";
import type { DriverMemory } from "../memory.js";
import { assault, fightTowards } from "./soldier.js";

/**
 * A radio further away than this is not worth abandoning the fight for; the
 * walk costs more than the 20 tickets are worth.
 */
const MAX_RAID_DISTANCE_M = 700;

/**
 * How wide to swing around the contested flag.
 *
 * An enemy radio sits only a couple of hundred metres behind the flag being
 * fought over, so the straight line to it runs through the entire enemy team.
 * Raiders that took that line reliably got to about 125 m and no further —
 * which is exactly where the firing line is. Going around is not a
 * sophistication here, it is the only thing that works, and it is what a human
 * squad does.
 *
 * The clearance has to exceed the 200 m engagement range by a real margin,
 * because the enemy is not a point at the flag: they spread out around it. At
 * 220 m the detour was still inside somebody's range the whole way and the
 * party died at 150 m instead of 125 — an improvement of nothing.
 */
const FLANK_CLEARANCE_M = 320;
/** Inside this range of the target, commit and go straight in. */
const COMMIT_RANGE_M = 140;

/**
 * A rally this close is worth stopping for on the way past. Anything further
 * is a detour into the enemy's strongest ground for no ticket value.
 */
const OPPORTUNIST_RANGE_M = 80;

export function raid(
  state: GameState,
  player: Player,
  memory: DriverMemory,
  out: Command[],
): void {
  const team = player.team;

  // A rally is only worth taking if it is nearly underfoot.
  //
  // It is tempting to rank it first — it is cheap to kill and it strips a
  // squad's fast respawn. But a rally is planted *at the fight*, so a party
  // that chases the nearest one walks into the entire enemy team and dies at
  // about 150 m, every time. Measured, not guessed. The radio sits behind the
  // fight, is softer, is worth 20 tickets, and takes the habitat with it.
  const rally = knownEnemyRallies(state, memory, team, player.pos)[0];
  if (rally !== undefined && distance(rally, player.pos) <= OPPORTUNIST_RANGE_M) {
    approach(state, player, rally, rules.RALLY_ENEMY_DESTROY_RADIUS_M / 2, out);
    return;
  }

  const targets = knownEnemyFobs(state, memory, team, player.pos);
  const target = targets.find((t) => distance(t, player.pos) < MAX_RAID_DISTANCE_M);

  if (target !== undefined) {
    memory.raidTargets.set(player.id, target.id);
    // Standing on the radio is what tears it down — gunfire does nothing to
    // it, so there is no version of this that works from a distance.
    approach(state, player, target, rules.ENEMY_TEARDOWN_RADIUS_M / 2, out);
    return;
  }

  memory.raidTargets.delete(player.id);

  // No radio known, but a rally is. Better than sweeping blind.
  if (rally !== undefined && distance(rally, player.pos) < MAX_RAID_DISTANCE_M) {
    approach(state, player, rally, rules.RALLY_ENEMY_DESTROY_RADIUS_M / 2, out);
    return;
  }

  // Nothing confirmed. Sweep where a radio would have to be: close enough to
  // feed the enemy's fight, far enough back to survive it.
  const sweep = likelyEnemyFobArea(state, team);
  if (sweep !== undefined) {
    fightTowards(state, player, spreadAround(state, sweep, player, SWEEP_SPREAD_M), out);
    return;
  }

  const objective = objectiveFor(state, team);
  if (objective !== undefined) assault(state, player, objective, out);
}

/**
 * Close on a structure and stay on it. Fighting continues on the way — a
 * raider who ignores the guard standing over the radio does not reach it.
 */
function approach(
  state: GameState,
  player: Player,
  target: Vec2,
  standOn: number,
  out: Command[],
): void {
  const gap = distance(player.pos, target);
  if (gap > standOn) {
    fightTowards(state, player, flankingWaypoint(state, player, target), out);
    return;
  }
  // On top of it. Keep shooting whatever is defending, but do not walk away:
  // teardown only accrues while a body is inside the radius.
  const canFire =
    state.tick >= player.nextShotAtTick && player.ammo >= rules.AMMO_PER_ENGAGEMENT;
  if (canFire) {
    const enemy = nearestDefender(state, player);
    if (enemy !== undefined) out.push({ t: "engage", player: player.id, target: enemy.id });
  }
  if (player.waypoint !== null) out.push({ t: "halt", player: player.id });
}

/**
 * Route around the contested flag rather than through it.
 *
 * The detour is expressed along the axis from the fight to the target, and the
 * waypoint it returns depends on how far along that axis the raider already
 * is. That monotone progression is the important part: a flank point computed
 * only from the objective is a fixed point a raider walks to and then sits at,
 * because from there the line to the target still runs past the fight. Asking
 * "how far along am I?" instead means every step is forward.
 *
 * Which side to swing is decided by the raider's own id, so a two-man party
 * splits and covers both approaches instead of walking in file — and the
 * choice is stable, so nobody oscillates between flanks as the front shifts.
 */
function flankingWaypoint(state: GameState, player: Player, target: Vec2): Vec2 {
  if (distance(player.pos, target) <= COMMIT_RANGE_M) return target;

  // Anchored on the two things that do not move: our own main base and the
  // radio. Anchoring on the contested flag instead was the mistake that cost
  // three attempts — the objective flips between flags as the fight swings, so
  // the detour point teleported and raiders zigzagged on the spot instead of
  // making ground.
  const main = state.teams[player.team].mainBase;
  const ax = target.x - main.x;
  const ay = target.y - main.y;
  const axisLength = Math.hypot(ax, ay);
  if (axisLength < 1) return target;
  const axis = { x: ax / axisLength, y: ay / axisLength };

  const side = flankSide(state, player);
  const perp = { x: -axis.y * side, y: axis.x * side };

  // How far along the main→radio line we already are.
  const progress = Math.max(
    0,
    Math.min(
      axisLength,
      (player.pos.x - main.x) * axis.x + (player.pos.y - main.y) * axis.y,
    ),
  );
  const ahead = Math.min(progress + LOOKAHEAD_M, axisLength);

  // A bowed corridor: widest at the halfway point, closing to zero at both
  // ends. It leaves our lines heading sideways, passes the fight well outside
  // weapon range, and converges exactly on the radio — so there is no staging
  // point to get stuck at and every step is forward.
  const lateral = FLANK_CLEARANCE_M * Math.sin((Math.PI * ahead) / axisLength);
  return {
    x: main.x + axis.x * ahead + perp.x * lateral,
    y: main.y + axis.y * ahead + perp.y * lateral,
  };
}

/** How far up the corridor to aim at a time. */
const LOOKAHEAD_M = 120;

function nearestDefender(state: GameState, self: Player): Player | undefined {
  let best: Player | undefined;
  let bestDist = rules.ENGAGEMENT_MAX_RANGE_M;
  for (const other of state.players) {
    if (other.team === self.team || other.status !== "alive") continue;
    const d = distance(other.pos, self.pos);
    if (d <= bestDist) {
      bestDist = d;
      best = other;
    }
  }
  return best;
}

/** Raiders fan out while sweeping so they cover ground rather than a line. */
const SWEEP_SPREAD_M = 90;
