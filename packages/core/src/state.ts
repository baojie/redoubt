/**
 * Match setup.
 *
 * Everything stochastic here — the RAAS lane draw, spawn jitter — comes from
 * the injected seed, so `createInitialState(seed)` is a pure function of its
 * arguments.
 */

import { cloneVec2, type Vec2 } from "./math.js";
import { Rng } from "./rng.js";
import { RIVERBEND } from "./maps/riverbend.js";
import {
  ARMOURED_VEHICLES_PER_TEAM,
  LOGISTICS_TRUCKS_PER_TEAM,
  MAGAZINE_ROUNDS,
  PLAYERS_PER_TEAM,
  PLAYER_MAX_AMMO,
  PLAYER_MAX_HEALTH,
  SQUAD_MAX_SIZE,
  START_TICKETS,
  VEHICLE_SPAWN_SPACING_M,
  VEHICLE_SPECS,
} from "./rules.js";
import type {
  ControlPoint,
  GameState,
  Lane,
  MapDefinition,
  Player,
  PlayerRole,
  Squad,
  Team,
  TeamId,
  Vehicle,
} from "./types.js";

export interface MatchOptions {
  seed: number;
  map?: MapDefinition;
  playersPerTeam?: number;
  /** Force a specific lane by name instead of drawing one. Testing aid. */
  laneName?: string;
}

/** Every team id, in a fixed order. Iteration order must never depend on Object.keys. */
export const TEAM_IDS: readonly TeamId[] = [0, 1];

function assignRole(indexInSquad: number): PlayerRole {
  if (indexInSquad === 0) return "squadLeader";
  if (indexInSquad === 1) return "medic";
  if (indexInSquad === 2) return "crewman";
  return "rifleman";
}

function drawLane(rng: Rng, map: MapDefinition, laneName?: string): Lane {
  if (laneName !== undefined) {
    const forced = map.lanes.find((l) => l.name === laneName);
    if (forced === undefined) {
      throw new Error(`unknown lane "${laneName}" on map ${map.name}`);
    }
    return forced;
  }
  const drawn = rng.pick(map.lanes);
  if (drawn === undefined) {
    throw new Error(`map ${map.name} defines no lanes`);
  }
  return drawn;
}

export function createInitialState(options: MatchOptions): GameState {
  const map = options.map ?? RIVERBEND;
  const playersPerTeam = options.playersPerTeam ?? PLAYERS_PER_TEAM;
  const rng = new Rng(options.seed);

  // Draw the lane first so the RNG stream position depends only on the seed
  // and the map, not on the roster size.
  const lane = drawLane(rng, map, options.laneName);

  const players: Player[] = [];
  const squads: Squad[] = [];
  const vehicles: Vehicle[] = [];
  const teams = {} as Record<TeamId, Team>;

  let nextEntityId = 0;
  const takeId = (): number => nextEntityId++;

  for (const teamId of TEAM_IDS) {
    const mainBase = map.mainBases[teamId];
    const team: Team = {
      id: teamId,
      tickets: START_TICKETS,
      mainBase: cloneVec2(mainBase),
      squads: [],
      players: [],
      commander: null,
      mercyBleedStartedAtTick: null,
    };

    const squadCount = Math.ceil(playersPerTeam / SQUAD_MAX_SIZE);
    for (let s = 0; s < squadCount; s++) {
      const squad: Squad = {
        id: takeId(),
        team: teamId,
        leader: null,
        members: [],
        rally: null,
      };
      squads.push(squad);
      team.squads.push(squad.id);
    }

    for (let i = 0; i < playersPerTeam; i++) {
      const squadIndex = Math.floor(i / SQUAD_MAX_SIZE);
      const squad = squads[squads.length - squadCount + squadIndex];
      if (squad === undefined) continue;
      const indexInSquad = i % SQUAD_MAX_SIZE;
      const role = assignRole(indexInSquad);
      const player: Player = {
        id: takeId(),
        team: teamId,
        squad: squad.id,
        role,
        status: "alive",
        pos: cloneVec2(mainBase),
        waypoint: null,
        steer: null,
        health: PLAYER_MAX_HEALTH,
        ammo: PLAYER_MAX_AMMO,
        bleedoutAtTick: 0,
        deployingSinceTick: 0,
        vehicle: null,
        reviveProgressTicks: 0,
        aimYaw: 0,
        aimPitch: 0,
        magazine: MAGAZINE_ROUNDS,
        reloadingUntilTick: 0,
        suppression: 0,
        recoilSteps: 0,
        aiming: false,
        dragging: null,
        pendingSuppression: 0,
        nextShotAtTick: 0,
        history: [],
        lastHitBy: null,
        invulnerable: false,
        infiniteAmmo: false,
        kills: 0,
        deaths: 0,
      };
      players.push(player);
      squad.members.push(player.id);
      if (role === "squadLeader") squad.leader = player.id;
      team.players.push(player.id);
    }

    // The first squad's leader takes the commander slot.
    const firstSquad = squads[squads.length - squadCount];
    team.commander = firstSquad?.leader ?? null;

    // Parked in a line rather than stacked on one point. Offsets run along y,
    // which is the mirror axis, so both teams get the identical arrangement.
    const vehicleSpawn = map.vehicleSpawns[teamId];
    const fleet: Array<"logistics" | "armoured"> = [
      ...Array<"logistics">(LOGISTICS_TRUCKS_PER_TEAM).fill("logistics"),
      ...Array<"armoured">(ARMOURED_VEHICLES_PER_TEAM).fill("armoured"),
    ];
    for (let v = 0; v < fleet.length; v++) {
      const offset = (v - (fleet.length - 1) / 2) * VEHICLE_SPAWN_SPACING_M;
      vehicles.push(
        makeVehicle(takeId(), teamId, fleet[v] as "logistics" | "armoured", {
          x: vehicleSpawn.x,
          y: vehicleSpawn.y + offset,
        }),
      );
    }

    teams[teamId] = team;
  }

  // Only the drawn lane's points exist as live objectives this match — that is
  // what makes RAAS a scouting problem rather than a memorised route.
  const controlPoints: ControlPoint[] = lane.points.map((pointId) => {
    const def = map.controlPoints.find((c) => c.id === pointId);
    if (def === undefined) {
      throw new Error(`lane "${lane.name}" references unknown point ${pointId}`);
    }
    return {
      id: def.id,
      name: def.name,
      pos: cloneVec2(def.pos),
      owner: null,
      contestingTeam: null,
      progress: 0,
      everOwnedBy: [] as TeamId[],
    };
  });

  // Each team starts holding the flag nearest its own main.
  const first = controlPoints[0];
  const last = controlPoints[controlPoints.length - 1];
  if (first !== undefined) {
    first.owner = 0;
    first.everOwnedBy.push(0);
  }
  if (last !== undefined && last !== first) {
    last.owner = 1;
    last.everOwnedBy.push(1);
  }

  return {
    tick: 0,
    phase: "staging",
    outcome: { kind: "ongoing" },
    rng: rng.save(),
    // Terrain is derived from the match seed and never changes during play.
    terrainSeed: options.seed | 0,
    map,
    lane,
    teams,
    players,
    squads,
    controlPoints,
    fobs: [],
    deployables: [],
    rallyPoints: [],
    vehicles,
    nextEntityId,
    doubleNeutral: false,
    bleedFraction: { 0: 0, 1: 0 },
  };
}

function makeVehicle(
  id: number,
  team: TeamId,
  type: "logistics" | "armoured",
  spawn: Vec2,
): Vehicle {
  return {
    id,
    team,
    type,
    pos: cloneVec2(spawn),
    waypoint: null,
    throttle: 0,
    steering: 0,
    // Facing the enemy at kick-off, which is the way anyone would park.
    heading: team === 0 ? 0 : Math.PI,
    speedMps: 0,
    health: VEHICLE_SPECS[type].maxHealth,
    occupants: [],
    cargoConstructionPoints: 0,
    cargoAmmoPoints: 0,
    destroyed: false,
    respawnAtTick: 0,
    homeX: spawn.x,
    homeY: spawn.y,
    transfer: null,
  };
}
