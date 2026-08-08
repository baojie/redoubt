/**
 * Casualties, revives, and getting back into the fight.
 *
 * The economy this file implements is the whole point of the game: a body is
 * only worth a ticket once it stops being revivable, and where you re-enter the
 * world is decided by logistics that happened minutes earlier.
 */

import { cloneVec2 } from "../math.js";
import { withinRange } from "../math.js";
import {
  BLEEDOUT_TICKS,
  DRAG_REACH_M,
  HABITAT_SPAWN_DELAY_TICKS,
  MAIN_BASE_SPAWN_DELAY_TICKS,
  PLAYER_MAX_AMMO,
  PLAYER_MAX_HEALTH,
  RALLY_SPAWN_DELAY_TICKS,
  REVIVE_HEALTH,
  REVIVE_REACH_M,
  REVIVE_TICKS,
  SPAWN_SCATTER_RADIUS_M,
  TICKET_COST_COMMANDER_DEATH,
  TICKET_COST_INFANTRY_DEATH,
  BODY_RADIUS_M,
} from "../rules.js";
import type { SpawnSource } from "../commands.js";
import type { Player, PlayerId } from "../types.js";
import type { World } from "../world.js";
import { habitatIsLive } from "./fob.js";
import { resolveCollisions } from "./movement.js";
import { noteRallySpawn, rallyIsLive } from "./rally.js";
import { adjustTickets } from "./tickets.js";

/** Knock a player down. No ticket is spent yet — a medic can still save it. */
export function downPlayer(world: World, player: Player, by: PlayerId | null): void {
  if (player.status !== "alive") return;
  player.status = "downed";
  player.health = 0;
  // Both hands needed to stay upright: whatever you were hauling, you let go.
  player.dragging = null;
  player.waypoint = null;
  player.steer = null;
  player.reviveProgressTicks = 0;
  player.lastHitBy = null;
  player.bleedoutAtTick = world.state.tick + BLEEDOUT_TICKS;
  if (player.vehicle !== null) ejectFromVehicle(world, player);
  world.emit({
    t: "playerDowned",
    tick: world.state.tick,
    player: player.id,
    team: player.team,
    by,
  });
  if (by !== null) {
    const killer = world.player(by);
    if (killer !== undefined) killer.kills++;
  }
}

/** Convert a downed player into a real casualty. This is where tickets go. */
export function killPlayer(
  world: World,
  player: Player,
  cause: "bleedout" | "gaveUp" | "finished",
): void {
  if (player.status === "deploying") return;
  player.status = "deploying";
  player.health = 0;
  player.dragging = null;
  player.waypoint = null;
  player.steer = null;
  player.reviveProgressTicks = 0;
  player.deployingSinceTick = world.state.tick;
  player.deaths++;
  if (player.vehicle !== null) ejectFromVehicle(world, player);

  world.emit({
    t: "playerDied",
    tick: world.state.tick,
    player: player.id,
    team: player.team,
    cause,
  });

  const isCommander = world.state.teams[player.team].commander === player.id;
  if (isCommander) {
    adjustTickets(world, player.team, -TICKET_COST_COMMANDER_DEATH, "commanderDeath");
  } else {
    adjustTickets(world, player.team, -TICKET_COST_INFANTRY_DEATH, "infantryDeath");
  }
}

function ejectFromVehicle(world: World, player: Player): void {
  if (player.vehicle === null) return;
  const vehicle = world.vehicle(player.vehicle);
  if (vehicle !== undefined) {
    const index = vehicle.occupants.indexOf(player.id);
    if (index >= 0) vehicle.occupants.splice(index, 1);
  }
  player.vehicle = null;
}

/**
 * Turn this tick's damage into casualties, all at once.
 *
 * Runs after every command has been applied, so two soldiers who shot each
 * other in the same tick both land their rounds and both go down. Resolving a
 * hit the instant it is scored would instead hand the win to whichever
 * command the server happened to process first — which is player-id order, and
 * therefore the same team every time.
 */
export function resolveHits(world: World): void {
  for (const player of world.state.players) {
    // Suppression lands at the same moment for everyone, so being shot at
    // never depends on whose commands the server happened to run first.
    if (player.pendingSuppression > 0) {
      player.suppression = Math.min(1, player.suppression + player.pendingSuppression);
      player.pendingSuppression = 0;
    }

    if (player.status === "alive") {
      if (player.health > 0) continue;
      downPlayer(world, player, player.lastHitBy);
      continue;
    }
    // A body that took another round while down is finished.
    if (player.status === "downed" && player.health < 0) {
      killPlayer(world, player, "finished");
    }
  }
}

/** Bleed-out timers. Runs every tick; the check is one comparison per body. */
export function updateCasualties(world: World): void {
  for (const player of world.state.players) {
    if (player.status !== "downed") continue;
    // Revive work only counts while someone is actively working this tick;
    // applyRevive resets it when they stop.
    if (world.state.tick >= player.bleedoutAtTick) {
      killPlayer(world, player, "bleedout");
    }
  }
}

/**
 * Apply one tick of revive work. `medics` maps a downed player id to how many
 * teammates are working on them.
 */
export function applyRevives(world: World, medics: Map<PlayerId, PlayerId[]>): void {
  for (const player of world.state.players) {
    if (player.status !== "downed") continue;
    const helpers = medics.get(player.id);
    if (helpers === undefined || helpers.length === 0) {
      player.reviveProgressTicks = 0;
      continue;
    }
    player.reviveProgressTicks += helpers.length;
    if (player.reviveProgressTicks < REVIVE_TICKS) continue;

    player.status = "alive";
    player.health = REVIVE_HEALTH;
    player.reviveProgressTicks = 0;
    const by = helpers[0] ?? null;
    if (by !== null) {
      world.emit({
        t: "playerRevived",
        tick: world.state.tick,
        player: player.id,
        team: player.team,
        by,
      });
    }
  }
}

/**
 * Pick up or drop a casualty.
 *
 * Returns a rejection reason, or null on success. Dropping (`target: null`) is
 * always allowed — you can always let go.
 */
export function tryDrag(
  world: World,
  carrier: Player,
  targetId: PlayerId | null,
): DragRejection | null {
  if (targetId === null) {
    carrier.dragging = null;
    return null;
  }
  if (carrier.status !== "alive") return "notAlive";
  if (carrier.vehicle !== null) return "mounted";

  const target = world.player(targetId);
  if (target === undefined) return "noSuchTarget";
  if (target.status !== "downed") return "notDowned";
  if (target.team !== carrier.team) return "wrongTeam";
  if (!withinRange(carrier.pos, target.pos, DRAG_REACH_M)) return "outOfReach";

  // One pair of hands per body. Somebody already hauling this casualty keeps
  // them; otherwise two players would tug the same body in opposite directions.
  for (const other of world.state.players) {
    if (other.id !== carrier.id && other.dragging === targetId) return "alreadyDragged";
  }

  carrier.dragging = targetId;
  return null;
}

export type DragRejection =
  | "notAlive"
  | "mounted"
  | "noSuchTarget"
  | "notDowned"
  | "wrongTeam"
  | "outOfReach"
  | "alreadyDragged";

/**
 * Haul dragged bodies along behind their carriers, and drop the ones that are
 * no longer draggable. Runs after movement, so the body ends the tick where
 * the carrier actually got to.
 */
export function updateDragging(world: World): void {
  for (const carrier of world.state.players) {
    if (carrier.dragging === null) continue;

    const body = world.player(carrier.dragging);
    const stillValid =
      body !== undefined &&
      body.status === "downed" &&
      carrier.status === "alive" &&
      carrier.vehicle === null;
    if (!stillValid) {
      carrier.dragging = null;
      continue;
    }

    // Trail just behind the carrier rather than sitting on top of them, so a
    // dragged body still reads as a separate thing being pulled.
    const dx = body.pos.x - carrier.pos.x;
    const dy = body.pos.y - carrier.pos.y;
    const gap = Math.hypot(dx, dy);
    if (gap <= DRAG_TRAIL_M) continue;
    const scale = DRAG_TRAIL_M / gap;
    body.pos = {
      x: carrier.pos.x + dx * scale,
      y: carrier.pos.y + dy * scale,
    };
  }
}

/** How far behind the carrier a dragged body trails. */
const DRAG_TRAIL_M = 1.2;

/** Is this reviver allowed to work on this target right now? */
export function canRevive(world: World, reviver: Player, targetId: PlayerId): boolean {
  if (reviver.status !== "alive") return false;
  const target = world.player(targetId);
  if (target === undefined) return false;
  if (target.status !== "downed") return false;
  if (target.team !== reviver.team) return false;
  return withinRange(reviver.pos, target.pos, REVIVE_REACH_M);
}

// ---------------------------------------------------------------------------
// Deploying
// ---------------------------------------------------------------------------

export type SpawnRejection =
  | "notDeploying"
  | "timerNotElapsed"
  | "noSuchRally"
  | "rallyNotYours"
  | "rallyNotLive"
  | "noSuchHabitat"
  | "habitatNotLive";

function spawnDelayTicks(source: SpawnSource): number {
  switch (source.kind) {
    case "main":
      return MAIN_BASE_SPAWN_DELAY_TICKS;
    case "rally":
      return RALLY_SPAWN_DELAY_TICKS;
    case "habitat":
      return HABITAT_SPAWN_DELAY_TICKS;
  }
}

export function trySpawn(
  world: World,
  player: Player,
  source: SpawnSource,
): SpawnRejection | null {
  if (player.status !== "deploying") return "notDeploying";
  if (world.state.tick < player.deployingSinceTick + spawnDelayTicks(source)) {
    return "timerNotElapsed";
  }

  switch (source.kind) {
    case "main": {
      enterWorld(world, player, world.state.teams[player.team].mainBase, "main");
      return null;
    }
    case "rally": {
      const rally = world.rally(source.rally);
      if (rally === undefined) return "noSuchRally";
      if (rally.squad !== player.squad) return "rallyNotYours";
      if (!rallyIsLive(world, rally)) return "rallyNotLive";
      noteRallySpawn(world, rally);
      enterWorld(world, player, rally.pos, "rally");
      return null;
    }
    case "habitat": {
      const habitat = world.deployable(source.deployable);
      if (habitat === undefined || habitat.type !== "habitat") return "noSuchHabitat";
      if (habitat.team !== player.team) return "habitatNotLive";
      if (!habitatIsLive(world, habitat)) return "habitatNotLive";
      enterWorld(world, player, habitat.pos, "habitat");
      return null;
    }
  }
}

/**
 * A spot near the spawn point rather than exactly on it.
 *
 * Every soldier spawning from one source used to arrive at the identical
 * coordinate, and since soldiers do not collide with each other they simply
 * stayed stacked. The renderer hides bodies within about a metre of the camera
 * — a teammate standing on you would otherwise fill the screen with the inside
 * of their head — so a whole wave spawning together was a wave nobody could
 * see. Spawning at main alongside eleven teammates looked like spawning alone.
 *
 * Uniform over the disc: `sqrt` on the radius, because sampling the radius
 * linearly would pile everyone into the middle, which is the problem this is
 * here to fix. The two draws come from the seeded RNG, so a wave lands in the
 * same places on a replay of the same seed.
 *
 * The result is pushed out of any cover it landed in, using the same
 * resolution a walking soldier gets — spawning inside a wall would otherwise
 * be a new way to get stuck.
 */
function scatterAround(world: World, at: { x: number; y: number }): { x: number; y: number } {
  const angle = world.rng.next() * Math.PI * 2;
  const radius = Math.sqrt(world.rng.next()) * SPAWN_SCATTER_RADIUS_M;
  const scattered = {
    x: at.x + Math.cos(angle) * radius,
    y: at.y + Math.sin(angle) * radius,
  };
  return cloneVec2(resolveCollisions(world, scattered, BODY_RADIUS_M));
}

function enterWorld(
  world: World,
  player: Player,
  at: { x: number; y: number },
  source: "main" | "rally" | "habitat",
): void {
  player.status = "alive";
  player.health = PLAYER_MAX_HEALTH;
  player.ammo = PLAYER_MAX_AMMO;
  player.pos = scatterAround(world, at);
  player.waypoint = null;
  player.steer = null;
  player.reviveProgressTicks = 0;
  world.emit({
    t: "playerSpawned",
    tick: world.state.tick,
    player: player.id,
    team: player.team,
    source,
  });
}
