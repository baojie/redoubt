/**
 * The tick pipeline.
 *
 * One entry point, one fixed order of operations, no ambient state. Given the
 * same `GameState` and the same command list you get the same next state and
 * the same events, on any machine, forever. Everything else in the project —
 * headless balance runs, server authority, client prediction and replay —
 * rests on that being true.
 */

import type { Command } from "./commands.js";
import type { GameEvent } from "./events.js";
import { hashState } from "./hash.js";
import { normalise, withinRange, type Vec2 } from "./math.js";
import { BUILD_REACH_M, STAGING_TICKS } from "./rules.js";
import { createInitialState, type MatchOptions } from "./state.js";
import type { GameState, PlayerId } from "./types.js";
import { World } from "./world.js";

import { updateBleed, updateMatchEnd } from "./systems/bleed.js";
import { updateControlPoints } from "./systems/capture.js";
import {
  aimAt,
  beginReload,
  fire,
  look,
  recordPositionHistory,
  tryResupply,
  updateWeapons,
} from "./systems/combat.js";
import {
  applyConstruction,
  destroyFob,
  placeDeployable,
  placeFob,
  updateOverrun,
  updateTeardown,
} from "./systems/fob.js";
import {
  flushSupplySessions,
  isDriver,
  tryDriveTo,
  tryEnterVehicle,
  tryExitVehicle,
  tryLoadSupply,
  tryUnloadSupply,
  updateVehicleRespawns,
} from "./systems/logistics.js";
import { updateMovement } from "./systems/movement.js";
import { placeRally, updateRallies } from "./systems/rally.js";
import {
  applyRevives,
  canRevive,
  killPlayer,
  resolveHits,
  trySpawn,
  updateCasualties,
} from "./systems/spawn.js";

export class Simulation {
  private readonly world: World;

  private constructor(state: GameState) {
    this.world = new World(state);
  }

  static create(options: MatchOptions): Simulation {
    return new Simulation(createInitialState(options));
  }

  /** Resume from a snapshot. The snapshot is taken by value, not referenced. */
  static fromState(state: GameState): Simulation {
    return new Simulation(state);
  }

  get state(): GameState {
    return this.world.state;
  }

  get finished(): boolean {
    return this.world.state.phase === "finished";
  }

  /** 32-bit hash of the current state. See hash.ts. */
  hash(): number {
    return hashState(this.world.state);
  }

  /**
   * Advance one tick. Returns the events this tick produced; the caller owns
   * the array and the simulation keeps no reference to it.
   */
  step(commands: readonly Command[] = []): GameEvent[] {
    const world = this.world;
    const state = world.state;
    world.events = [];

    if (state.phase === "finished") return world.events;

    if (state.phase === "staging" && state.tick >= STAGING_TICKS) {
      state.phase = "active";
      world.emit({ t: "matchStarted", tick: state.tick, lane: state.lane.name });
    }

    // Build and revive work is collective: several players on one object are
    // faster than one, so these are gathered first and resolved together.
    const builders = new Map<number, number>();
    const medics = new Map<PlayerId, PlayerId[]>();

    for (const command of commands) {
      this.applyCommand(command, builders, medics);
    }

    // Damage from this tick becomes casualties simultaneously, before any
    // system reads who is still standing.
    resolveHits(world);
    applyConstruction(world, builders);
    applyRevives(world, medics);
    updateMovement(world);
    // History is recorded after movement, so a rewind lands on positions the
    // clients were actually shown.
    recordPositionHistory(world);
    updateWeapons(world);
    updateCasualties(world);
    updateRallies(world);
    updateOverrun(world);
    updateTeardown(world);
    updateControlPoints(world);
    updateBleed(world);
    flushSupplySessions(world);
    updateVehicleRespawns(world);
    updateMatchEnd(world);

    world.commitRng();
    state.tick++;
    return world.events;
  }

  private applyCommand(
    command: Command,
    builders: Map<number, number>,
    medics: Map<PlayerId, PlayerId[]>,
  ): void {
    const world = this.world;
    const player = world.player(command.player);
    if (player === undefined) return;

    switch (command.t) {
      case "move": {
        if (player.status !== "alive") {
          world.reject(player.id, command.t, "notAlive");
          return;
        }
        if (player.vehicle !== null) {
          world.reject(player.id, command.t, "mounted");
          return;
        }
        player.waypoint = { x: command.to.x, y: command.to.y };
        player.steer = null;
        return;
      }

      case "steer": {
        if (player.status !== "alive") {
          world.reject(player.id, command.t, "notAlive");
          return;
        }
        if (player.vehicle !== null) {
          world.reject(player.id, command.t, "mounted");
          return;
        }
        // Normalising here, not at the caller, means a client cannot travel
        // faster by sending a longer vector.
        player.steer = normalise(command.dir);
        player.waypoint = null;
        return;
      }

      case "halt": {
        player.waypoint = null;
        player.steer = null;
        // A driver halting stops the vehicle, not just their own legs —
        // otherwise a truck ordered to stop keeps rolling past its FOB.
        if (player.vehicle !== null) {
          const vehicle = world.vehicle(player.vehicle);
          if (vehicle !== undefined && isDriver(vehicle, player)) {
            vehicle.waypoint = null;
          }
        }
        return;
      }

      case "spawn": {
        const rejection = trySpawn(world, player, command.source);
        if (rejection !== null) world.reject(player.id, command.t, rejection);
        return;
      }

      case "placeRally": {
        placeRally(world, player);
        return;
      }

      case "placeFob": {
        placeFob(world, player);
        return;
      }

      case "dismantleFob": {
        const fob = world.fob(command.fob);
        if (fob === undefined || fob.destroyed) {
          world.reject(player.id, command.t, "noSuchFob");
          return;
        }
        if (fob.team !== player.team) {
          world.reject(player.id, command.t, "wrongTeam");
          return;
        }
        destroyFob(world, fob, true);
        return;
      }

      case "placeDeployable": {
        placeDeployable(world, player, command.fob, command.kind, command.pos);
        return;
      }

      case "build": {
        const deployable = world.deployable(command.deployable);
        if (deployable === undefined || deployable.destroyed || deployable.built) {
          world.reject(player.id, command.t, "nothingToBuild");
          return;
        }
        if (deployable.team !== player.team || player.status !== "alive") {
          world.reject(player.id, command.t, "cannotBuild");
          return;
        }
        if (!withinBuildReach(player.pos, deployable.pos)) {
          world.reject(player.id, command.t, "outOfReach");
          return;
        }
        builders.set(deployable.id, (builders.get(deployable.id) ?? 0) + 1);
        return;
      }

      case "look": {
        if (player.status !== "alive") {
          world.reject(player.id, command.t, "notAlive");
          return;
        }
        look(player, command.yaw, command.pitch);
        return;
      }

      case "fire": {
        const rejection = fire(world, player, command.renderTick ?? world.state.tick);
        if (rejection !== null) world.reject(player.id, command.t, rejection);
        return;
      }

      case "reload": {
        beginReload(world, player);
        return;
      }

      case "aim": {
        player.aiming = command.aiming === true && player.status === "alive";
        return;
      }

      case "engage": {
        const rejection = aimAt(world, player, command.target);
        if (rejection !== null) world.reject(player.id, command.t, rejection);
        return;
      }

      case "revive": {
        if (!canRevive(world, player, command.target)) {
          world.reject(player.id, command.t, "cannotRevive");
          return;
        }
        const helpers = medics.get(command.target);
        if (helpers === undefined) medics.set(command.target, [player.id]);
        else helpers.push(player.id);
        return;
      }

      case "giveUp": {
        if (player.status !== "downed") {
          world.reject(player.id, command.t, "notDowned");
          return;
        }
        killPlayer(world, player, "gaveUp");
        return;
      }

      case "resupply": {
        const rejection = tryResupply(world, player);
        if (rejection !== null) world.reject(player.id, command.t, rejection);
        return;
      }

      case "enterVehicle": {
        const rejection = tryEnterVehicle(world, player, command.vehicle);
        if (rejection !== null) world.reject(player.id, command.t, rejection);
        return;
      }

      case "exitVehicle": {
        const rejection = tryExitVehicle(world, player);
        if (rejection !== null) world.reject(player.id, command.t, rejection);
        return;
      }

      case "driveTo": {
        const rejection = tryDriveTo(world, player, command.to);
        if (rejection !== null) world.reject(player.id, command.t, rejection);
        return;
      }

      case "loadSupply": {
        const rejection = tryLoadSupply(
          world,
          player,
          command.constructionPoints,
          command.ammoPoints,
        );
        if (rejection !== null) world.reject(player.id, command.t, rejection);
        return;
      }

      case "unloadSupply": {
        const rejection = tryUnloadSupply(
          world,
          player,
          command.fob,
          command.constructionPoints,
          command.ammoPoints,
        );
        if (rejection !== null) world.reject(player.id, command.t, rejection);
        return;
      }
    }
  }
}

function withinBuildReach(a: Vec2, b: Vec2): boolean {
  return withinRange(a, b, BUILD_REACH_M);
}
