/**
 * Rally points — the cheap, fragile half of the spawn economy.
 *
 * A rally costs no construction points, no tickets, and no build time. It
 * costs 50 rounds out of the squad leader's own pouches and it dies the moment
 * an enemy walks onto it. Bullets and explosives cannot touch it: the only
 * counter is presence. PLAN §2.3.
 */

import { distance, withinRange } from "../math.js";
import {
  OVERRUN_EVAL_INTERVAL_TICKS,
  RALLY_AMMO_COST,
  RALLY_ENEMY_BLOCK_RADIUS_M,
  RALLY_ENEMY_DESTROY_RADIUS_M,
  RALLY_MIN_DISTANCE_FROM_MAIN_BASE_M,
  RALLY_PLACE_MIN_SQUADMATES,
  RALLY_PLACE_SQUADMATE_RADIUS_M,
  RALLY_WAVE_COOLDOWN_TICKS,
  RALLY_WAVE_WINDOW_TICKS,
} from "../rules.js";
import { TEAM_IDS } from "../state.js";
import type { Player, RallyPoint } from "../types.js";
import { enemyOf } from "../types.js";
import type { World } from "../world.js";

export type RallyRejection =
  | "notAlive"
  | "notSquadLeader"
  | "notEnoughSquadmates"
  | "notEnoughAmmo"
  | "enemiesTooClose"
  | "tooCloseToMainBase";

export function validateRallyPlacement(world: World, player: Player): RallyRejection | null {
  if (player.status !== "alive") return "notAlive";
  if (player.role !== "squadLeader") return "notSquadLeader";
  if (player.ammo < RALLY_AMMO_COST) return "notEnoughAmmo";

  let squadmates = 0;
  for (const other of world.state.players) {
    if (other.id === player.id) continue;
    if (other.squad !== player.squad) continue;
    if (other.status !== "alive") continue;
    if (withinRange(other.pos, player.pos, RALLY_PLACE_SQUADMATE_RADIUS_M)) squadmates++;
  }
  if (squadmates < RALLY_PLACE_MIN_SQUADMATES) return "notEnoughSquadmates";

  const enemy = enemyOf(player.team);
  for (const other of world.state.players) {
    if (other.team !== enemy || other.status !== "alive") continue;
    if (withinRange(other.pos, player.pos, RALLY_ENEMY_BLOCK_RADIUS_M)) {
      return "enemiesTooClose";
    }
  }

  for (const team of TEAM_IDS) {
    const base = world.state.teams[team].mainBase;
    if (distance(base, player.pos) < RALLY_MIN_DISTANCE_FROM_MAIN_BASE_M) {
      return "tooCloseToMainBase";
    }
  }

  return null;
}

export function placeRally(world: World, player: Player): RallyPoint | null {
  const rejection = validateRallyPlacement(world, player);
  if (rejection !== null) {
    world.reject(player.id, "placeRally", rejection);
    return null;
  }

  const squad = world.squad(player.squad);
  if (squad === undefined) return null;

  // A squad holds one rally at a time. Placing again picks the old one up —
  // it costs nothing but the ammo, so repositioning is always available.
  if (squad.rally !== null) {
    const previous = world.rally(squad.rally);
    if (previous !== undefined && !previous.destroyed) {
      previous.destroyed = true;
      world.emit({
        t: "rallyDestroyed",
        tick: world.state.tick,
        rally: previous.id,
        squad: squad.id,
        team: squad.team,
        byEnemy: false,
      });
    }
    squad.rally = null;
  }

  player.ammo -= RALLY_AMMO_COST;

  const rally: RallyPoint = {
    id: world.newId(),
    squad: squad.id,
    team: player.team,
    pos: { x: player.pos.x, y: player.pos.y },
    createdAtTick: world.state.tick,
    waveOpenedAtTick: null,
    availableAtTick: world.state.tick,
    destroyed: false,
  };
  world.state.rallyPoints.push(rally);
  squad.rally = rally.id;
  world.emit({
    t: "rallyPlaced",
    tick: world.state.tick,
    rally: rally.id,
    squad: squad.id,
    team: rally.team,
  });
  return rally;
}

/** Enemies standing on a rally destroy it; enemies merely near it block spawns. */
export function updateRallies(world: World): void {
  const state = world.state;

  for (const rally of state.rallyPoints) {
    if (rally.destroyed) continue;

    // Close an expired spawn wave and start the cooldown.
    if (
      rally.waveOpenedAtTick !== null &&
      state.tick >= rally.waveOpenedAtTick + RALLY_WAVE_WINDOW_TICKS
    ) {
      rally.availableAtTick =
        rally.waveOpenedAtTick + RALLY_WAVE_WINDOW_TICKS + RALLY_WAVE_COOLDOWN_TICKS;
      rally.waveOpenedAtTick = null;
    }

    if (state.tick % OVERRUN_EVAL_INTERVAL_TICKS !== 0) continue;

    const enemy = enemyOf(rally.team);
    let overrunBy = 0;
    for (const player of state.players) {
      if (player.team !== enemy || player.status !== "alive") continue;
      if (withinRange(player.pos, rally.pos, RALLY_ENEMY_DESTROY_RADIUS_M)) overrunBy++;
    }
    if (overrunBy === 0) continue;

    rally.destroyed = true;
    const squad = world.squad(rally.squad);
    if (squad !== undefined && squad.rally === rally.id) squad.rally = null;
    world.emit({
      t: "rallyDestroyed",
      tick: state.tick,
      rally: rally.id,
      squad: rally.squad,
      team: rally.team,
      byEnemy: true,
    });
  }
}

/** Is this rally currently accepting spawns? */
export function rallyIsLive(world: World, rally: RallyPoint): boolean {
  if (rally.destroyed) return false;

  const waveOpen =
    rally.waveOpenedAtTick !== null &&
    world.state.tick < rally.waveOpenedAtTick + RALLY_WAVE_WINDOW_TICKS;
  if (!waveOpen && world.state.tick < rally.availableAtTick) return false;

  const enemy = enemyOf(rally.team);
  for (const player of world.state.players) {
    if (player.team !== enemy || player.status !== "alive") continue;
    if (withinRange(player.pos, rally.pos, RALLY_ENEMY_BLOCK_RADIUS_M)) return false;
  }
  return true;
}

/** Record that a player used this rally, opening a wave if one is not already. */
export function noteRallySpawn(world: World, rally: RallyPoint): void {
  if (rally.waveOpenedAtTick === null) {
    rally.waveOpenedAtTick = world.state.tick;
  }
}
