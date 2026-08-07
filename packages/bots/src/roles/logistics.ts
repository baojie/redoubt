/**
 * The truck run: main base → load → drive to the FOB → unload → repeat.
 *
 * PLAN §2.5 calls this the heartbeat of the game, and it is the one behaviour
 * a balance test cannot fake. Every forward respawn in a match is a delivery
 * somebody made minutes earlier.
 */

import {
  distance,
  rules,
  type Command,
  type ControlPoint,
  type Fob,
  type GameState,
  type Player,
  type TeamId,
  type Vehicle,
} from "@redoubt/core";
import { liveFobs } from "../awareness.js";
import type { DriverMemory } from "../memory.js";
import { assault } from "./soldier.js";

export function runSupply(
  state: GameState,
  player: Player,
  memory: DriverMemory,
  objective: ControlPoint,
  out: Command[],
): void {
  const team = player.team;
  const main = state.teams[team].mainBase;
  let plan = memory.trucks.get(player.id);
  if (plan === undefined) {
    plan = { phase: "toTruck", vehicle: null };
    memory.trucks.set(player.id, plan);
  }

  // Reacquire a truck if ours is gone or we were killed out of it.
  if (plan.vehicle !== null) {
    const owned = state.vehicles.find((v) => v.id === plan.vehicle);
    if (owned === undefined || owned.destroyed) {
      plan.vehicle = null;
      plan.phase = "toTruck";
    }
  }
  if (player.vehicle === null && plan.phase !== "toTruck") {
    plan.phase = "toTruck";
  }

  if (plan.phase === "toTruck") {
    const truck = claimTruck(state, player, memory);
    if (truck === undefined) {
      // No truck free — be a rifleman rather than stand at main doing nothing.
      assault(state, player, objective, out);
      return;
    }
    plan.vehicle = truck.id;
    if (player.vehicle === truck.id) {
      plan.phase = "loading";
      return;
    }
    if (distance(player.pos, truck.pos) > rules.VEHICLE_MOUNT_REACH_M) {
      out.push({ t: "move", player: player.id, to: truck.pos });
    } else {
      out.push({ t: "enterVehicle", player: player.id, vehicle: truck.id });
    }
    return;
  }

  const truck =
    plan.vehicle === null ? undefined : state.vehicles.find((v) => v.id === plan.vehicle);
  if (truck === undefined) {
    plan.phase = "toTruck";
    return;
  }

  const spec = rules.VEHICLE_SPECS[truck.type];
  const destination = deliveryTarget(state, team, objective);

  if (plan.phase === "loading") {
    if (distance(truck.pos, main) > rules.MAIN_BASE_RADIUS_M) {
      out.push({ t: "driveTo", player: player.id, to: main });
      return;
    }
    // Load for the deficit at the destination, not blindly to capacity. A FOB
    // sitting on a full ammo pool does not need another 1800 points of it, and
    // hauling them there is a truck round trip wasted.
    const wantCp = Math.min(
      spec.maxCargoConstructionPoints,
      destination === undefined
        ? spec.maxCargoConstructionPoints
        : rules.FOB_MAX_CONSTRUCTION_POINTS - destination.constructionPoints,
    );
    const wantAp = Math.min(
      spec.maxCargoAmmoPoints,
      destination === undefined
        ? spec.maxCargoAmmoPoints
        : rules.FOB_MAX_AMMO_POINTS - destination.ammoPoints,
    );

    if (truck.cargoConstructionPoints >= wantCp && truck.cargoAmmoPoints >= wantAp) {
      plan.phase = "outbound";
      return;
    }
    out.push({
      t: "loadSupply",
      player: player.id,
      constructionPoints: wantCp,
      ammoPoints: wantAp,
    });
    return;
  }

  if (plan.phase === "outbound") {
    if (destination === undefined) {
      // Nowhere to deliver yet. Idle near main rather than driving a loaded
      // truck into the map for the enemy to find.
      out.push({ t: "driveTo", player: player.id, to: main });
      return;
    }
    if (distance(truck.pos, destination.pos) > rules.SUPPLY_UNLOAD_REACH_M) {
      out.push({ t: "driveTo", player: player.id, to: destination.pos });
      return;
    }
    out.push({ t: "halt", player: player.id });
    plan.phase = "unloading";
    return;
  }

  if (plan.phase === "unloading") {
    if (destination === undefined) {
      plan.phase = "returning";
      return;
    }
    const cp = Math.min(
      truck.cargoConstructionPoints,
      rules.FOB_MAX_CONSTRUCTION_POINTS - destination.constructionPoints,
    );
    const ap = Math.min(
      truck.cargoAmmoPoints,
      rules.FOB_MAX_AMMO_POINTS - destination.ammoPoints,
    );
    if (cp <= 0 && ap <= 0) {
      plan.phase = "returning";
      return;
    }
    out.push({
      t: "unloadSupply",
      player: player.id,
      fob: destination.id,
      constructionPoints: cp,
      ammoPoints: ap,
    });
    return;
  }

  // returning
  if (distance(truck.pos, main) > rules.MAIN_BASE_RADIUS_M) {
    out.push({ t: "driveTo", player: player.id, to: main });
    return;
  }
  plan.phase = "loading";
}

/** The friendly FOB a truck should be feeding: the one nearest the fight. */
function deliveryTarget(
  state: GameState,
  team: TeamId,
  objective: ControlPoint,
): Fob | undefined {
  let best: Fob | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const fob of liveFobs(state, team)) {
    const d = distance(fob.pos, objective.pos);
    if (d < bestDist) {
      bestDist = d;
      best = fob;
    }
  }
  return best;
}

function claimTruck(
  state: GameState,
  player: Player,
  memory: DriverMemory,
): Vehicle | undefined {
  const taken = new Set<number>();
  for (const [ownerId, plan] of memory.trucks) {
    if (ownerId !== player.id && plan.vehicle !== null) taken.add(plan.vehicle);
  }
  return state.vehicles.find(
    (v) =>
      v.team === player.team &&
      v.type === "logistics" &&
      !v.destroyed &&
      !taken.has(v.id) &&
      (v.occupants.length === 0 || v.occupants[0] === player.id),
  );
}
