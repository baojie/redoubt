/**
 * Logistics.
 *
 * PLAN §2.5 calls this the heartbeat of the game, and it is: a FOB radio is
 * worth nothing until a truck has driven construction points to it, and a
 * habitat is 500 of those points. Every spawn on the front line is a delivery
 * somebody made minutes earlier.
 *
 * Loading and unloading are *sessions*, not instants. Points move at a fixed
 * rate while the driver holds the command and the vehicle is stationary, so a
 * resupply run has to be committed to and can be interrupted.
 */

import { distance } from "../math.js";
import {
  MAIN_BASE_RADIUS_M,
  REPAIR_COST_CP_PER_HP,
  REPAIR_EVAL_INTERVAL_TICKS,
  REPAIR_RATE_HP_PER_S,
  REPAIR_REACH_M,
  TICK_RATE_HZ,
  secondsToTicks,
  VEHICLE_MOUNT_REACH_M,
  SUPPLY_TRANSFER_MAX_SPEED_MPS,
  SUPPLY_TRANSFER_POINTS_PER_TICK,
  SUPPLY_UNLOAD_REACH_M,
  VEHICLE_SPECS,
} from "../rules.js";
import type { FobId, Player, Vehicle } from "../types.js";
import type { World } from "../world.js";
import { depositSupply } from "./fob.js";
import { adjustTickets } from "./tickets.js";

export type VehicleRejection =
  | "notAlive"
  | "noSuchVehicle"
  | "wrongTeam"
  | "vehicleDestroyed"
  | "vehicleFull"
  | "outOfReach"
  | "notInVehicle"
  | "notDriver";

export function tryEnterVehicle(
  world: World,
  player: Player,
  vehicleId: number,
): VehicleRejection | null {
  if (player.status !== "alive") return "notAlive";
  const vehicle = world.vehicle(vehicleId);
  if (vehicle === undefined) return "noSuchVehicle";
  if (vehicle.destroyed) return "vehicleDestroyed";
  if (vehicle.team !== player.team) return "wrongTeam";
  if (distance(vehicle.pos, player.pos) > VEHICLE_MOUNT_REACH_M) return "outOfReach";
  if (vehicle.occupants.length >= VEHICLE_SPECS[vehicle.type].seats) return "vehicleFull";

  if (player.vehicle !== null) tryExitVehicle(world, player);
  vehicle.occupants.push(player.id);
  player.vehicle = vehicle.id;
  player.waypoint = null;
  return null;
}

export function tryExitVehicle(world: World, player: Player): VehicleRejection | null {
  if (player.vehicle === null) return "notInVehicle";
  const vehicle = world.vehicle(player.vehicle);
  if (vehicle !== undefined) {
    const index = vehicle.occupants.indexOf(player.id);
    if (index >= 0) vehicle.occupants.splice(index, 1);
    if (vehicle.occupants.length === 0) {
      vehicle.waypoint = null;
      vehicle.throttle = 0;
      vehicle.steering = 0;
      vehicle.speedMps = 0;
    }
  }
  player.vehicle = null;
  return null;
}

/** Seat 0 drives. */
export function isDriver(vehicle: Vehicle, player: Player): boolean {
  return vehicle.occupants[0] === player.id;
}

/**
 * Take the wheel directly.
 *
 * Clamped here rather than trusted: a client sending throttle 50 would
 * otherwise drive fifty times faster, exactly as an unnormalised steer vector
 * would have made a soldier sprint.
 */
export function tryDrive(
  world: World,
  player: Player,
  throttle: number,
  steering: number,
): VehicleRejection | null {
  if (player.status !== "alive") return "notAlive";
  if (player.vehicle === null) return "notInVehicle";
  const vehicle = world.vehicle(player.vehicle);
  if (vehicle === undefined) return "noSuchVehicle";
  if (vehicle.destroyed) return "vehicleDestroyed";
  if (!isDriver(vehicle, player)) return "notDriver";

  vehicle.throttle = clampUnit(throttle);
  vehicle.steering = clampUnit(steering);
  // Direct input supersedes any standing order, so a human taking the wheel
  // from a bot does not have to fight the bot's waypoint.
  vehicle.waypoint = null;
  return null;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

export function tryDriveTo(
  world: World,
  player: Player,
  to: { x: number; y: number },
): VehicleRejection | null {
  if (player.status !== "alive") return "notAlive";
  if (player.vehicle === null) return "notInVehicle";
  const vehicle = world.vehicle(player.vehicle);
  if (vehicle === undefined) return "noSuchVehicle";
  if (vehicle.destroyed) return "vehicleDestroyed";
  if (!isDriver(vehicle, player)) return "notDriver";
  vehicle.waypoint = { x: to.x, y: to.y };
  vehicle.throttle = 0;
  vehicle.steering = 0;
  return null;
}

export type SupplyRejection =
  | VehicleRejection
  | "notALogisticsVehicle"
  | "notAtMainBase"
  | "movingTooFast"
  | "noSuchFob"
  | "fobOutOfReach"
  | "nothingToTransfer";

function beginSession(
  vehicle: Vehicle,
  kind: "load" | "unload",
  fob: FobId | null,
): void {
  if (
    vehicle.transfer === null ||
    vehicle.transfer.kind !== kind ||
    vehicle.transfer.fob !== fob
  ) {
    vehicle.transfer = {
      kind,
      fob,
      constructionPoints: 0,
      ammoPoints: 0,
      activeThisTick: true,
    };
    return;
  }
  vehicle.transfer.activeThisTick = true;
}

/**
 * Split this tick's transfer allowance across the two point types, favouring
 * construction points. Returns [cp, ap].
 */
function allowance(wantCp: number, wantAp: number): [number, number] {
  const budget = SUPPLY_TRANSFER_POINTS_PER_TICK;
  const cp = Math.min(wantCp, budget);
  const ap = Math.min(wantAp, budget - cp);
  return [cp, ap];
}

/** Load cargo at your own main base. */
export function tryLoadSupply(
  world: World,
  player: Player,
  wantConstructionPoints: number,
  wantAmmoPoints: number,
): SupplyRejection | null {
  if (player.status !== "alive") return "notAlive";
  if (player.vehicle === null) return "notInVehicle";
  const vehicle = world.vehicle(player.vehicle);
  if (vehicle === undefined) return "noSuchVehicle";
  if (vehicle.destroyed) return "vehicleDestroyed";
  if (!isDriver(vehicle, player)) return "notDriver";

  const spec = VEHICLE_SPECS[vehicle.type];
  if (spec.maxCargoConstructionPoints === 0 && spec.maxCargoAmmoPoints === 0) {
    return "notALogisticsVehicle";
  }
  if (vehicle.speedMps > SUPPLY_TRANSFER_MAX_SPEED_MPS) return "movingTooFast";

  const main = world.state.teams[vehicle.team].mainBase;
  if (distance(vehicle.pos, main) > MAIN_BASE_RADIUS_M) return "notAtMainBase";

  const targetCp = Math.min(wantConstructionPoints, spec.maxCargoConstructionPoints);
  const targetAp = Math.min(wantAmmoPoints, spec.maxCargoAmmoPoints);
  const [cp, ap] = allowance(
    Math.max(0, targetCp - vehicle.cargoConstructionPoints),
    Math.max(0, targetAp - vehicle.cargoAmmoPoints),
  );
  if (cp <= 0 && ap <= 0) return "nothingToTransfer";

  beginSession(vehicle, "load", null);
  vehicle.cargoConstructionPoints += cp;
  vehicle.cargoAmmoPoints += ap;
  if (vehicle.transfer !== null) {
    vehicle.transfer.constructionPoints += cp;
    vehicle.transfer.ammoPoints += ap;
  }
  return null;
}

/** Unload cargo into a friendly FOB — the delivery that makes a FOB real. */
export function tryUnloadSupply(
  world: World,
  player: Player,
  fobId: FobId,
  wantConstructionPoints: number,
  wantAmmoPoints: number,
): SupplyRejection | null {
  if (player.status !== "alive") return "notAlive";
  if (player.vehicle === null) return "notInVehicle";
  const vehicle = world.vehicle(player.vehicle);
  if (vehicle === undefined) return "noSuchVehicle";
  if (vehicle.destroyed) return "vehicleDestroyed";
  if (!isDriver(vehicle, player)) return "notDriver";
  if (vehicle.speedMps > SUPPLY_TRANSFER_MAX_SPEED_MPS) return "movingTooFast";

  const fob = world.fob(fobId);
  if (fob === undefined || fob.destroyed) return "noSuchFob";
  if (fob.team !== vehicle.team) return "wrongTeam";
  if (distance(vehicle.pos, fob.pos) > SUPPLY_UNLOAD_REACH_M) return "fobOutOfReach";

  const [cp, ap] = allowance(
    Math.min(wantConstructionPoints, vehicle.cargoConstructionPoints),
    Math.min(wantAmmoPoints, vehicle.cargoAmmoPoints),
  );
  if (cp <= 0 && ap <= 0) return "nothingToTransfer";

  const accepted = depositSupply(fob, cp, ap);
  if (accepted.constructionPoints <= 0 && accepted.ammoPoints <= 0) {
    return "nothingToTransfer";
  }

  beginSession(vehicle, "unload", fob.id);
  vehicle.cargoConstructionPoints -= accepted.constructionPoints;
  vehicle.cargoAmmoPoints -= accepted.ammoPoints;
  if (vehicle.transfer !== null) {
    vehicle.transfer.constructionPoints += accepted.constructionPoints;
    vehicle.transfer.ammoPoints += accepted.ammoPoints;
  }
  return null;
}

/**
 * Close out any transfer session that stopped receiving commands this tick and
 * report the total moved. One event per run, not one per tick.
 */
export function flushSupplySessions(world: World): void {
  for (const vehicle of world.state.vehicles) {
    const session = vehicle.transfer;
    if (session === null) continue;
    if (session.activeThisTick) {
      session.activeThisTick = false;
      continue;
    }

    if (session.kind === "load") {
      world.emit({
        t: "supplyLoaded",
        tick: world.state.tick,
        vehicle: vehicle.id,
        team: vehicle.team,
        constructionPoints: session.constructionPoints,
        ammoPoints: session.ammoPoints,
      });
    } else if (session.fob !== null) {
      world.emit({
        t: "supplyUnloaded",
        tick: world.state.tick,
        vehicle: vehicle.id,
        fob: session.fob,
        team: vehicle.team,
        constructionPoints: session.constructionPoints,
        ammoPoints: session.ammoPoints,
      });
    }
    vehicle.transfer = null;
  }
}

/**
 * Write a vehicle off.
 *
 * Ejects the crew — being inside is not protection from the thing exploding —
 * charges the ticket, and starts the respawn timer. Until this existed nothing
 * in the codebase ever set `destroyed`, so the −5/−10 rule in PLAN §2.1 had
 * never once fired in a match.
 */
export function destroyVehicle(world: World, vehicle: Vehicle): void {
  if (vehicle.destroyed) return;
  const spec = VEHICLE_SPECS[vehicle.type];

  vehicle.destroyed = true;
  vehicle.health = 0;
  vehicle.waypoint = null;
  vehicle.speedMps = 0;
  vehicle.transfer = null;
  // Cargo burns with it, which is what makes losing a loaded truck hurt more
  // than losing an empty one even though the ticket cost is the same.
  vehicle.cargoConstructionPoints = 0;
  vehicle.cargoAmmoPoints = 0;
  vehicle.respawnAtTick = world.state.tick + secondsToTicks(spec.respawnDelayS);

  for (const id of [...vehicle.occupants]) {
    const occupant = world.player(id);
    if (occupant !== undefined) occupant.vehicle = null;
  }
  vehicle.occupants = [];

  world.emit({
    t: "vehicleDestroyed",
    tick: world.state.tick,
    vehicle: vehicle.id,
    team: vehicle.team,
    kind: vehicle.type,
  });
  adjustTickets(world, vehicle.team, -spec.ticketCost, "vehicleLost");
}

/**
 * Repair stations mend friendly vehicles parked beside them.
 *
 * Paid for out of the FOB's construction points, so keeping armour alive is
 * one more thing the supply run funds — which is the whole reason the station
 * is a FOB deployable rather than a free ability.
 */
export function updateRepairs(world: World): void {
  const state = world.state;
  if (state.tick % REPAIR_EVAL_INTERVAL_TICKS !== 0) return;
  const seconds = REPAIR_EVAL_INTERVAL_TICKS / TICK_RATE_HZ;

  for (const station of state.deployables) {
    if (station.destroyed || !station.built) continue;
    if (station.type !== "repairStation") continue;
    const fob = world.fob(station.fob);
    if (fob === undefined || fob.destroyed) continue;

    for (const vehicle of state.vehicles) {
      if (vehicle.destroyed || vehicle.team !== station.team) continue;
      const spec = VEHICLE_SPECS[vehicle.type];
      if (vehicle.health >= spec.maxHealth) continue;
      if (distance(vehicle.pos, station.pos) > REPAIR_REACH_M) continue;

      const wanted = Math.min(REPAIR_RATE_HP_PER_S * seconds, spec.maxHealth - vehicle.health);
      const affordable = Math.min(wanted, fob.constructionPoints / REPAIR_COST_CP_PER_HP);
      if (affordable <= 0) continue;

      vehicle.health += affordable;
      fob.constructionPoints = Math.max(
        0,
        fob.constructionPoints - affordable * REPAIR_COST_CP_PER_HP,
      );
    }
  }
}

/** Respawn destroyed vehicles back at main once their timer runs out. */
export function updateVehicleRespawns(world: World): void {
  for (const vehicle of world.state.vehicles) {
    if (!vehicle.destroyed) continue;
    if (world.state.tick < vehicle.respawnAtTick) continue;
    vehicle.destroyed = false;
    vehicle.health = VEHICLE_SPECS[vehicle.type].maxHealth;
    // Back into its own parking space, not on top of whatever is already there.
    vehicle.pos = { x: vehicle.homeX, y: vehicle.homeY };
    vehicle.waypoint = null;
    vehicle.speedMps = 0;
    vehicle.cargoConstructionPoints = 0;
    vehicle.cargoAmmoPoints = 0;
    vehicle.transfer = null;
  }
}
