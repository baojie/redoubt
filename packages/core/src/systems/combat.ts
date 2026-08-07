/**
 * The M0/M1 combat stand-in.
 *
 * A hit-probability model, not ballistics. PLAN §5 is explicit that real
 * projectiles, suppression and lag-compensated hit registration belong to M3;
 * until then combat only needs to produce casualties at a believable rate so
 * the ticket economy can be measured. Everything here is replaceable without
 * touching a single rule in the layers above.
 */

import { distance } from "../math.js";
import {
  AMMO_PER_ENGAGEMENT,
  DAMAGE_PER_HIT,
  ENGAGEMENT_COOLDOWN_TICKS,
  ENGAGEMENT_MAX_RANGE_M,
  MAIN_BASE_RADIUS_M,
  RESUPPLY_AMMO_PER_PULL,
  RESUPPLY_AMMO_POINT_COST_PER_UNIT,
  RESUPPLY_REACH_M,
  PLAYER_MAX_AMMO,
  hitChanceAtRange,
} from "../rules.js";
import type { Player, PlayerId } from "../types.js";
import type { World } from "../world.js";
import { downPlayer } from "./spawn.js";

export type EngageRejection =
  | "notAlive"
  | "noSuchTarget"
  | "targetNotEngageable"
  | "outOfRange"
  | "outOfAmmo"
  | "weaponCycling";

export function tryEngage(
  world: World,
  shooter: Player,
  targetId: PlayerId,
): EngageRejection | null {
  if (shooter.status !== "alive") return "notAlive";
  const target = world.player(targetId);
  if (target === undefined) return "noSuchTarget";
  if (target.team === shooter.team || target.status !== "alive") {
    return "targetNotEngageable";
  }
  if (world.state.tick < shooter.nextShotAtTick) return "weaponCycling";
  if (shooter.ammo < AMMO_PER_ENGAGEMENT) return "outOfAmmo";

  const range = distance(shooter.pos, target.pos);
  if (range > ENGAGEMENT_MAX_RANGE_M) return "outOfRange";

  shooter.ammo -= AMMO_PER_ENGAGEMENT;
  shooter.nextShotAtTick = world.state.tick + ENGAGEMENT_COOLDOWN_TICKS;
  if (!world.rng.chance(hitChanceAtRange(range))) return null;

  target.health -= DAMAGE_PER_HIT;
  if (target.health <= 0) {
    downPlayer(world, target, shooter.id);
  }
  return null;
}

export type ResupplyRejection = "notAlive" | "noSourceInReach" | "sourceEmpty" | "alreadyFull";

/**
 * Top up from an ammo crate, a FOB radio, or a logistics truck within reach.
 * Ammo is not free: it comes out of the same ammo-point pool that pays for
 * emplacements, which is what makes a squad leader's 50-round rally an actual
 * decision rather than a free action.
 */
export function tryResupply(world: World, player: Player): ResupplyRejection | null {
  if (player.status !== "alive") return "notAlive";
  if (player.ammo >= PLAYER_MAX_AMMO) return "alreadyFull";

  const wanted = Math.min(RESUPPLY_AMMO_PER_PULL, PLAYER_MAX_AMMO - player.ammo);
  const cost = wanted * RESUPPLY_AMMO_POINT_COST_PER_UNIT;

  let foundSource = false;

  for (const deployable of world.state.deployables) {
    if (deployable.destroyed || !deployable.built) continue;
    if (deployable.type !== "ammoCrate" || deployable.team !== player.team) continue;
    if (distance(deployable.pos, player.pos) > RESUPPLY_REACH_M) continue;
    const fob = world.fob(deployable.fob);
    if (fob === undefined || fob.destroyed) continue;
    foundSource = true;
    if (fob.ammoPoints < cost) continue;
    fob.ammoPoints -= cost;
    player.ammo += wanted;
    return null;
  }

  for (const fob of world.state.fobs) {
    if (fob.destroyed || fob.team !== player.team) continue;
    if (distance(fob.pos, player.pos) > RESUPPLY_REACH_M) continue;
    foundSource = true;
    if (fob.ammoPoints < cost) continue;
    fob.ammoPoints -= cost;
    player.ammo += wanted;
    return null;
  }

  for (const vehicle of world.state.vehicles) {
    if (vehicle.destroyed || vehicle.team !== player.team) continue;
    if (distance(vehicle.pos, player.pos) > RESUPPLY_REACH_M) continue;
    foundSource = true;
    if (vehicle.cargoAmmoPoints < cost) continue;
    vehicle.cargoAmmoPoints -= cost;
    player.ammo += wanted;
    return null;
  }

  // Main base is an unlimited source — you rearm for free where you spawn.
  const main = world.state.teams[player.team].mainBase;
  if (distance(main, player.pos) <= MAIN_BASE_RADIUS_M) {
    player.ammo = PLAYER_MAX_AMMO;
    return null;
  }

  return foundSource ? "sourceEmpty" : "noSourceInReach";
}
