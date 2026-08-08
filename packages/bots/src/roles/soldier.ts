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
/** Soldiers below this reserve reload from any source in reach. */
const LOW_AMMO = 20;
/** Top up the magazine once it drops to here, given a lull. */
const MAGAZINE_RELOAD_THRESHOLD = 8;
/** Closer than this and you finish the magazine before reloading. */
const URGENT_CONTACT_M = 60;

export function fightTowards(
  state: GameState,
  player: Player,
  destination: { x: number; y: number },
  out: Command[],
): void {
  const enemy = nearestEnemy(state, player);
  const reloading = player.reloadingUntilTick > state.tick;

  // Reload in the gaps rather than discovering an empty magazine mid-contact.
  // Bots that only reloaded when the trigger clicked spent most of a match
  // waiting on it and generated twenty thousand rejected commands a match.
  if (!reloading && player.magazine <= MAGAZINE_RELOAD_THRESHOLD) {
    const contact = enemy !== undefined && distance(enemy.pos, player.pos) < URGENT_CONTACT_M;
    if (!contact || player.magazine < rules.AMMO_PER_ENGAGEMENT) {
      out.push({ t: "reload", player: player.id });
    }
  }

  const canFire =
    !reloading &&
    state.tick >= player.nextShotAtTick &&
    player.magazine >= rules.AMMO_PER_ENGAGEMENT;
  if (canFire && enemy !== undefined) {
    out.push({ t: "engage", player: player.id, target: enemy.id });
    // Keep closing rather than standing still — an M0 stand-in for cover.
  }

  // Throw one at an enemy who is close enough to reach and far enough not to
  // catch the blast. Bots throw at all so that the rule is exercised by the
  // hundred-match harness: this project has three times shipped a rule that was
  // unit-tested, correct, and had never once fired in a real match.
  if (
    enemy !== undefined &&
    player.grenades > 0 &&
    state.tick >= player.nextShotAtTick &&
    inGrenadeBand(distance(player.pos, enemy.pos))
  ) {
    // Aimed with an explicit look rather than `engage`, which aims *and*
    // fires: a bot that engaged in order to throw would empty a magazine into
    // the target on the same tick.
    out.push({
      t: "look",
      player: player.id,
      yaw: Math.atan2(enemy.pos.y - player.pos.y, enemy.pos.x - player.pos.x),
      pitch: 0,
    });
    out.push({ t: "throwGrenade", player: player.id });
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

/**
 * The band in which throwing is sensible.
 *
 * Near edge is outside the blast radius plus a margin, because a bot that lobs
 * one at somebody ten metres away kills itself; far edge is inside what the
 * throw actually reaches, or the grenade lands in open ground and only warns
 * the enemy.
 */
const GRENADE_MIN_THROW_M = rules.GRENADE_BLAST_RADIUS_M + 4;
const GRENADE_MAX_THROW_M = 32;

function inGrenadeBand(range: number): boolean {
  return range >= GRENADE_MIN_THROW_M && range <= GRENADE_MAX_THROW_M;
}

export function assault(
  state: GameState,
  player: Player,
  objective: ControlPoint,
  out: Command[],
): void {
  fightTowards(state, player, spreadAround(state, objective.pos, player, ASSAULT_SPREAD_M), out);
}
