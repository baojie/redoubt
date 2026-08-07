/**
 * The rifleman.
 *
 * Walk to the objective, shoot what is in front of you, reload when there is
 * something to reload from. Everything more interesting than that belongs to
 * one of the other roles — this is the baseline every bot falls back to when
 * its specialist job has nothing to do.
 */

import { distance, rules, type Command, type ControlPoint, type GameState, type Player } from "@redoubt/core";
import { nearestEnemy, resupplySourceInReach, spreadAround } from "../awareness.js";

/** Spread infantry around the flag instead of stacking them on one pixel. */
const ASSAULT_SPREAD_M = 60;
/** Soldiers below this reload from any source in reach. */
const LOW_AMMO = 20;

export function fightTowards(
  state: GameState,
  player: Player,
  destination: { x: number; y: number },
  out: Command[],
): void {
  const canFire =
    state.tick >= player.nextShotAtTick && player.ammo >= rules.AMMO_PER_ENGAGEMENT;
  if (canFire) {
    const enemy = nearestEnemy(state, player);
    if (enemy !== undefined) {
      out.push({ t: "engage", player: player.id, target: enemy.id });
      // Keep closing rather than standing still — an M0 stand-in for cover.
    }
  }

  if (player.ammo <= LOW_AMMO && resupplySourceInReach(state, player)) {
    out.push({ t: "resupply", player: player.id });
  }

  if (player.waypoint === null || distance(player.waypoint, destination) > ARRIVAL_SLACK_M) {
    out.push({ t: "move", player: player.id, to: destination });
  }
}

/** Re-issuing a move order every time the target shifts a metre is noise. */
const ARRIVAL_SLACK_M = 15;

export function assault(
  state: GameState,
  player: Player,
  objective: ControlPoint,
  out: Command[],
): void {
  fightTowards(state, player, spreadAround(state, objective.pos, player, ASSAULT_SPREAD_M), out);
}
