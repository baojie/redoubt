/**
 * Movement integration.
 *
 * Deliberately trivial: straight-line travel toward a standing waypoint at a
 * fixed speed, with no terrain, no collision, and no pathfinding. The rules
 * engine only needs positions accurate enough to answer "who is inside this
 * radius". Real character control arrives with Rapier in M3 and lives in the
 * server/client layer, not here.
 */

import { clampToMap, distance, stepToward } from "../math.js";
import { PLAYER_SPEED_M_PER_TICK, TICK_RATE_HZ, VEHICLE_SPECS } from "../rules.js";
import type { World } from "../world.js";

export function updateMovement(world: World): void {
  const state = world.state;
  const mapSize = state.map.sizeM;

  for (const vehicle of state.vehicles) {
    if (vehicle.destroyed) {
      vehicle.speedMps = 0;
      continue;
    }
    if (vehicle.waypoint === null || vehicle.occupants.length === 0) {
      vehicle.speedMps = 0;
      continue;
    }
    const maxStep = VEHICLE_SPECS[vehicle.type].speedMps / TICK_RATE_HZ;
    const next = clampToMap(stepToward(vehicle.pos, vehicle.waypoint, maxStep), mapSize);
    const travelled = distance(vehicle.pos, next);
    vehicle.pos = next;
    vehicle.speedMps = travelled * TICK_RATE_HZ;
    if (travelled === 0) vehicle.waypoint = null;
  }

  for (const player of state.players) {
    if (player.status !== "alive") continue;

    if (player.vehicle !== null) {
      const vehicle = world.vehicle(player.vehicle);
      if (vehicle !== undefined && !vehicle.destroyed) {
        player.pos = { x: vehicle.pos.x, y: vehicle.pos.y };
        continue;
      }
      player.vehicle = null;
    }

    // A held direction (human on WASD) takes precedence over a waypoint
    // (bot walking to a place); the command handlers keep them exclusive.
    if (player.steer !== null) {
      player.pos = clampToMap(
        {
          x: player.pos.x + player.steer.x * PLAYER_SPEED_M_PER_TICK,
          y: player.pos.y + player.steer.y * PLAYER_SPEED_M_PER_TICK,
        },
        mapSize,
      );
      continue;
    }

    if (player.waypoint === null) continue;
    const next = clampToMap(
      stepToward(player.pos, player.waypoint, PLAYER_SPEED_M_PER_TICK),
      mapSize,
    );
    player.pos = next;
    if (next.x === player.waypoint.x && next.y === player.waypoint.y) {
      player.waypoint = null;
    }
  }
}
