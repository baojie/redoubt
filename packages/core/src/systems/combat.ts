/**
 * Shooting.
 *
 * Two ways to point a rifle, one way to fire it:
 *
 *  - `aimAt` swings onto a body and is what a bot issues. It applies the
 *    elevation a competent shooter would hold for the range, then fires.
 *  - `look` sets yaw and pitch directly and is what a human on a mouse issues.
 *
 * Both end up in `fire`, so there is exactly one place where a round is
 * created and exactly one set of rules about where it goes. A bot has no
 * privileged path to a hit; it aims and misses like everyone else, and the
 * spread model in rules.ts is what decides.
 *
 * Hit registration is lag-compensated: the shot is tested against where the
 * targets *were* at the tick the shooter was looking at, not where they are
 * now (PLAN §4). Without it, hitting a moving target at any real ping means
 * leading them by an amount no player can be expected to judge.
 */

import { directionFromAngles, distance, anglesFromDirection } from "../math.js";
import type { Vec2, Vec3 } from "../math.js";
import {
  AMMO_PER_ENGAGEMENT,
  DAMAGE_PER_HIT,
  ENGAGEMENT_COOLDOWN_TICKS,
  LAG_COMPENSATION_TICKS,
  GRENADES_PER_SOLDIER,
  MAGAZINE_ROUNDS,
  MAIN_BASE_RADIUS_M,
  VEHICLE_SPECS,
  RECOIL_MAX_STEPS,
  RECOIL_RECOVERY_PER_S,
  RELOAD_TICKS,
  RESUPPLY_AMMO_PER_PULL,
  RESUPPLY_AMMO_POINT_COST_PER_UNIT,
  RESUPPLY_REACH_M,
  SUPPRESSION_DECAY_PER_S,
  SUPPRESSION_PER_ROUND,
  PLAYER_MAX_AMMO,
  TICK_RATE_HZ,
  weaponSpreadRad,
} from "../rules.js";
import { EYE_HEIGHT_M, TORSO_HEIGHT_M } from "../terrain.js";
import type { Player, PlayerId } from "../types.js";
import type { World } from "../world.js";
import { applySpread, aimWithDrop, resolveShot, type Target } from "./ballistics.js";
import { destroyVehicle } from "./logistics.js";

export type FireRejection =
  | "notAlive"
  | "mounted"
  | "outOfAmmo"
  | "reloading"
  | "weaponCycling";

export type EngageRejection = FireRejection | "noSuchTarget" | "targetNotEngageable";

// ---------------------------------------------------------------------------
// Pointing the rifle
// ---------------------------------------------------------------------------

/** Set aim directly. What a mouse produces. */
export function look(player: Player, yaw: number, pitch: number): void {
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
  player.aimYaw = wrapAngle(yaw);
  // Nobody can look further than straight up or straight down.
  player.aimPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, pitch));
}

const MAX_PITCH_RAD = Math.PI / 2 - 0.01;

function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  const wrapped = angle % twoPi;
  return wrapped > Math.PI ? wrapped - twoPi : wrapped <= -Math.PI ? wrapped + twoPi : wrapped;
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

/**
 * Fire one round along the shooter's current aim.
 *
 * `renderTick` is the tick the shooter believes they were looking at. It is
 * clamped to a legal window before use, so a client cannot rewind the world
 * to whenever suits it.
 */
export function fire(world: World, shooter: Player, renderTick: number): FireRejection | null {
  const state = world.state;
  if (shooter.status !== "alive") return "notAlive";
  if (shooter.vehicle !== null) return "mounted";
  // A pending reload is any non-zero finish tick, not one strictly in the
  // future. `updateWeapons` is what clears it, and it runs after commands — so
  // on the exact tick a reload was due to finish, `> state.tick` reads false,
  // the trigger falls through to an empty magazine, and the reload below is
  // started over. Holding the trigger through a dry magazine restarted the
  // timer every single tick: the magazine never refilled, the reserve was never
  // touched, and the weapon never fired again for the rest of the match.
  if (shooter.reloadingUntilTick > 0) return "reloading";
  if (state.tick < shooter.nextShotAtTick) return "weaponCycling";
  if (shooter.magazine < AMMO_PER_ENGAGEMENT) {
    // Dry magazine starts a reload rather than silently doing nothing, which
    // is what a player expects from pulling the trigger on an empty gun.
    beginReload(world, shooter);
    return "outOfAmmo";
  }

  shooter.magazine -= AMMO_PER_ENGAGEMENT;
  shooter.nextShotAtTick = state.tick + ENGAGEMENT_COOLDOWN_TICKS;
  shooter.recoilSteps = Math.min(RECOIL_MAX_STEPS, shooter.recoilSteps + 1);

  const terrain = world.terrain;
  const origin: Vec3 = {
    x: shooter.pos.x,
    y: shooter.pos.y,
    z: terrain.heightAt(shooter.pos.x, shooter.pos.y) + EYE_HEIGHT_M,
  };

  const spread = weaponSpreadRad({
    moving: isMoving(shooter),
    suppression: shooter.suppression,
    recoilSteps: shooter.recoilSteps,
    aiming: shooter.aiming,
  });
  const aim = directionFromAngles(shooter.aimYaw, shooter.aimPitch);
  const direction = applySpread(aim, spread, world.rng.next(), world.rng.next());

  const targets = rewoundTargets(world, shooter, renderTick);
  const impact = resolveShot(
    terrain,
    origin,
    direction,
    targets,
    world.cover,
    world.vehicleTargets(),
    world.coverGrid,
  );

  for (const id of impact.suppressed) {
    const victim = world.player(id);
    if (victim === undefined || victim.status !== "alive") continue;
    victim.pendingSuppression += SUPPRESSION_PER_ROUND;
  }

  if (impact.hit !== null) {
    const victim = world.player(impact.hit);
    // Invulnerability is checked here and only here, because this is the only
    // place a round takes health off a soldier. The shot still happens: the
    // tracer flies, the suppression above still lands, and the shooter sees
    // exactly what they would see against anyone else. Only the damage stops.
    if (victim !== undefined && victim.team !== shooter.team && !victim.invulnerable) {
      if (victim.status === "alive") {
        // Damage lands now; going down is resolved once every command this
        // tick has run, so simultaneous exchanges are genuinely simultaneous.
        victim.health -= DAMAGE_PER_HIT;
        victim.lastHitBy = shooter.id;
      } else if (victim.status === "downed") {
        // A body on the ground is still a target, and putting another round
        // into it ends the argument. Without this rule a squad standing over
        // its casualties revives them faster than anyone can kill them: it
        // measured at five revives per death, and the ticket economy — which
        // is the entire game — stopped meaning anything.
        //
        // Driven negative rather than killed on the spot, so the casualty
        // resolves with everything else at the end of the tick.
        victim.health -= DAMAGE_PER_HIT;
        victim.lastHitBy = shooter.id;
      }
    }
  }

  if (impact.hitVehicle !== null) {
    const vehicle = world.vehicle(impact.hitVehicle);
    if (vehicle !== undefined && !vehicle.destroyed && vehicle.team !== shooter.team) {
      // Most of a rifle round is wasted on armour. That is what makes the
      // anti-tank emplacement worth its 600 CP rather than a curiosity.
      const spec = VEHICLE_SPECS[vehicle.type];
      vehicle.health -= DAMAGE_PER_HIT * spec.smallArmsResistance;
      if (vehicle.health <= 0) destroyVehicle(world, vehicle);
    }
  }

  world.emit({
    t: "shotFired",
    tick: state.tick,
    shooter: shooter.id,
    team: shooter.team,
    from: origin,
    to: impact.at,
    flightSeconds: impact.flightSeconds,
    hit: impact.hit,
  });

  return null;
}

/** Swing onto a body and fire. What a bot issues. */
export function aimAt(
  world: World,
  shooter: Player,
  targetId: PlayerId,
): EngageRejection | null {
  const target = world.player(targetId);
  if (target === undefined) return "noSuchTarget";
  if (target.team === shooter.team || target.status !== "alive") {
    return "targetNotEngageable";
  }
  if (shooter.status !== "alive") return "notAlive";

  const terrain = world.terrain;
  const origin: Vec3 = {
    x: shooter.pos.x,
    y: shooter.pos.y,
    z: terrain.heightAt(shooter.pos.x, shooter.pos.y) + EYE_HEIGHT_M,
  };
  const aimPoint: Vec3 = {
    x: target.pos.x,
    y: target.pos.y,
    z: terrain.heightAt(target.pos.x, target.pos.y) + TORSO_HEIGHT_M,
  };

  // Hold the elevation the range calls for. Without this a bot shoots flat and
  // its rounds bury themselves in the dirt past about a hundred metres.
  const direction = aimWithDrop(origin, aimPoint);
  const angles = anglesFromDirection(direction);
  look(shooter, angles.yaw, angles.pitch);

  return fire(world, shooter, world.state.tick);
}

export function beginReload(world: World, player: Player): void {
  if (player.reloadingUntilTick > 0) return;
  if (player.magazine >= MAGAZINE_ROUNDS) return;
  if (player.ammo <= 0) return;
  player.reloadingUntilTick = world.state.tick + RELOAD_TICKS;
  // Both hands on the magazine: you cannot be looking down the sights.
  player.aiming = false;
}

/** Complete reloads, and bleed off recoil and suppression. */
export function updateWeapons(world: World): void {
  const state = world.state;
  const perTick = 1 / TICK_RATE_HZ;

  for (const player of state.players) {
    // Playtest only, and off for everyone unless the server was asked for it.
    // Done before the reload draws from the reserve, so a soldier who was
    // already dry is re-armed by the next reload rather than having to find a
    // crate first.
    if (player.infiniteAmmo) {
      player.ammo = PLAYER_MAX_AMMO;
      // Grenades too. The switch is called "never run dry", and a playtest
      // that runs out of the thing being tested is exactly what it exists to
      // prevent — this was found the first time a probe threw three and then
      // had nothing left to check the blast with.
      player.grenades = GRENADES_PER_SOLDIER;
    }

    if (player.reloadingUntilTick > 0 && state.tick >= player.reloadingUntilTick) {
      player.reloadingUntilTick = 0;
      // The reserve pays for the magazine, so a soldier who has not resupplied
      // eventually cannot reload — ammo is a logistics resource, not a number
      // that regenerates.
      const wanted = MAGAZINE_ROUNDS - player.magazine;
      const drawn = Math.min(wanted, player.ammo);
      player.magazine += drawn;
      player.ammo -= drawn;
    }

    if (player.suppression > 0) {
      player.suppression = Math.max(0, player.suppression - SUPPRESSION_DECAY_PER_S * perTick);
    }
    if (player.recoilSteps > 0 && state.tick >= player.nextShotAtTick) {
      player.recoilSteps = Math.max(0, player.recoilSteps - RECOIL_RECOVERY_PER_S * perTick);
    }
  }
}

/** Record this tick's positions for lag compensation. Runs after movement. */
export function recordPositionHistory(world: World): void {
  for (const player of world.state.players) {
    player.history.push({ x: player.pos.x, y: player.pos.y });
    while (player.history.length > LAG_COMPENSATION_TICKS) player.history.shift();
  }
}

/**
 * The enemy, positioned as the shooter saw them.
 *
 * `renderTick` is clamped into the compensation window: a client that claims
 * to be looking at a tick from ten seconds ago gets the oldest position the
 * server still keeps, not a time machine.
 */
function rewoundTargets(world: World, shooter: Player, renderTick: number): Target[] {
  const state = world.state;
  const terrain = world.terrain;
  const requested = Number.isFinite(renderTick) ? Math.floor(renderTick) : state.tick;
  const oldest = state.tick - LAG_COMPENSATION_TICKS;
  const clamped = Math.max(oldest, Math.min(state.tick, requested));
  const ticksBack = state.tick - clamped;

  const targets: Target[] = [];
  for (const player of state.players) {
    if (player.id === shooter.id) continue;
    // Downed bodies included: they can be finished off, and a round that
    // passes through where one is lying should not carry on to the man behind.
    if (player.status === "deploying") continue;
    if (player.team === shooter.team) continue;
    // Riding inside: the hull is between you and the round, so the vehicle
    // takes it. Without this a rifleman kills the driver *through* the truck,
    // because the crew stand at the vehicle's own position and bodies are
    // tested before hulls.
    if (player.vehicle !== null) continue;
    const at = positionAt(player, ticksBack);
    targets.push({
      id: player.id,
      torso: { x: at.x, y: at.y, z: terrain.heightAt(at.x, at.y) + TORSO_HEIGHT_M },
    });
  }
  return targets;
}

function positionAt(player: Player, ticksBack: number): Vec2 {
  if (ticksBack <= 0 || player.history.length === 0) return player.pos;
  const index = player.history.length - ticksBack;
  return player.history[Math.max(0, index)] ?? player.pos;
}

function isMoving(player: Player): boolean {
  return player.steer !== null || player.waypoint !== null;
}

// ---------------------------------------------------------------------------
// Resupply
// ---------------------------------------------------------------------------

export type ResupplyRejection = "notAlive" | "noSourceInReach" | "sourceEmpty" | "alreadyFull";

/**
 * Top up from an ammo crate, a FOB radio, or a logistics truck within reach.
 * Ammo is not free: it comes out of the same ammo-point pool that pays for
 * emplacements, which is what makes a squad leader's 50-round rally an actual
 * decision rather than a free action.
 */
export function tryResupply(world: World, player: Player): ResupplyRejection | null {
  if (player.status !== "alive") return "notAlive";
  if (player.ammo >= PLAYER_MAX_AMMO && player.grenades >= GRENADES_PER_SOLDIER) {
    return "alreadyFull";
  }

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
    refillGrenades(player);
    return null;
  }

  for (const fob of world.state.fobs) {
    if (fob.destroyed || fob.team !== player.team) continue;
    if (distance(fob.pos, player.pos) > RESUPPLY_REACH_M) continue;
    foundSource = true;
    if (fob.ammoPoints < cost) continue;
    fob.ammoPoints -= cost;
    player.ammo += wanted;
    refillGrenades(player);
    return null;
  }

  for (const vehicle of world.state.vehicles) {
    if (vehicle.destroyed || vehicle.team !== player.team) continue;
    if (distance(vehicle.pos, player.pos) > RESUPPLY_REACH_M) continue;
    foundSource = true;
    if (vehicle.cargoAmmoPoints < cost) continue;
    vehicle.cargoAmmoPoints -= cost;
    player.ammo += wanted;
    refillGrenades(player);
    return null;
  }

  // Main base is an unlimited source — you rearm for free where you spawn.
  const main = world.state.teams[player.team].mainBase;
  if (distance(main, player.pos) <= MAIN_BASE_RADIUS_M) {
    player.ammo = PLAYER_MAX_AMMO;
    player.grenades = GRENADES_PER_SOLDIER;
    return null;
  }

  return foundSource ? "sourceEmpty" : "noSourceInReach";
}

/**
 * Top a soldier back up to a full set of grenades.
 *
 * Free once the pull has been paid for. Charging separately would mean a
 * soldier who is out of grenades but full on rounds cannot restock at all,
 * because the pull is refused as "already full" before it ever gets here.
 */
function refillGrenades(player: Player): void {
  player.grenades = GRENADES_PER_SOLDIER;
}
