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
import { pushOutOfBox } from "../cover.js";
import {
  ADS_MOVE_SPEED_MULTIPLIER,
  BODY_RADIUS_M,
  DRAG_SPEED_MULTIPLIER,
  PLAYER_SPEED_M_PER_TICK,
  TICK_RATE_HZ,
  VEHICLE_SPECS,
} from "../rules.js";
import type { Vec2 } from "../math.js";
import type { World } from "../world.js";

/**
 * Vehicles are wider than people, so they clear cover by more.
 * Crude, and correct enough: the alternative is a real collision hull, which
 * is a physics engine's job and belongs with M4's vehicle work.
 */
const VEHICLE_CLEARANCE_M = 1.6;

/**
 * Push a position out of any cover it has ended up inside.
 *
 * Applied after the move rather than before it, so a soldier walking into a
 * wall slides along it instead of stopping dead — which is the difference
 * between cover that feels like architecture and cover that feels like glue.
 *
 * Iterated a few times because stepping out of one box can put you inside its
 * neighbour, and a building is usually several boxes.
 */
function resolveCollisions(world: World, at: Vec2, radius: number): Vec2 {
  let position = at;
  for (let pass = 0; pass < COLLISION_PASSES; pass++) {
    let moved = false;
    for (const box of world.cover) {
      const pushed = pushOutOfBox(position.x, position.y, box, radius);
      if (pushed.x !== position.x || pushed.y !== position.y) {
        position = pushed;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return position;
}

const COLLISION_PASSES = 3;

/** Below this, a step counts as having made no headway at all. */
const PROGRESS_EPSILON_M = 1e-4;

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
    const next = resolveCollisions(
      world,
      clampToMap(stepToward(vehicle.pos, vehicle.waypoint, maxStep), mapSize),
      VEHICLE_CLEARANCE_M,
    );
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

    // Aiming down the sights costs mobility. That trade is what makes taking
    // the shot a decision rather than a free upgrade.
    let speed = PLAYER_SPEED_M_PER_TICK;
    if (player.aiming) speed *= ADS_MOVE_SPEED_MULTIPLIER;
    // Hauling a body is slower still, and the two stack: you are bent double,
    // using one arm, and looking down a sight you cannot hold steady.
    if (player.dragging !== null) speed *= DRAG_SPEED_MULTIPLIER;

    // A held direction (human on WASD) takes precedence over a waypoint
    // (bot walking to a place); the command handlers keep them exclusive.
    if (player.steer !== null) {
      player.pos = resolveCollisions(
        world,
        clampToMap(
          {
            x: player.pos.x + player.steer.x * speed,
            y: player.pos.y + player.steer.y * speed,
          },
          mapSize,
        ),
        BODY_RADIUS_M,
      );
      continue;
    }

    if (player.waypoint === null) continue;
    const stepped = clampToMap(stepToward(player.pos, player.waypoint, speed), mapSize);
    const before = distance(player.pos, player.waypoint);
    const next = resolveCollisions(world, stepped, BODY_RADIUS_M);
    player.pos = next;

    if (stepped.x === player.waypoint.x && stepped.y === player.waypoint.y) {
      player.waypoint = null;
      continue;
    }
    // Blocked: cover took the whole step away, so the waypoint is unreachable
    // from here and holding it would grind against the wall forever. Dropping
    // it lets the driver choose again next decision.
    //
    // Only when *no* progress was made. Sliding along a wall still closes the
    // distance, and cutting that short would stop soldiers dead at every
    // corner — which is the difference between architecture and glue.
    if (distance(next, player.waypoint) >= before - PROGRESS_EPSILON_M) {
      player.waypoint = null;
    }
  }
}
