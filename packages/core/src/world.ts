/**
 * The mutable working set a tick operates on.
 *
 * `GameState` is plain serialisable data with entities held in arrays. Systems
 * need id lookups, so `World` layers id→entity indexes over those arrays. The
 * indexes are derived, never authoritative, and are rebuilt only when an array
 * actually grows — entities are soft-deleted (`destroyed: true`) rather than
 * spliced, which keeps ids stable and iteration order deterministic.
 */

import type { GameEvent } from "./events.js";
import { Rng } from "./rng.js";
import { createTerrain, type Terrain } from "./terrain.js";
import { CoverGrid, resolveCover, type CoverBox } from "./cover.js";
import { VEHICLE_SPECS } from "./rules.js";
import type { VehicleTarget } from "./systems/ballistics.js";
import { TEAM_IDS } from "./state.js";
import type {
  Deployable,
  DeployableId,
  Fob,
  FobId,
  GameState,
  Player,
  PlayerId,
  RallyPoint,
  RallyPointId,
  Squad,
  SquadId,
  Vehicle,
  VehicleId,
} from "./types.js";

interface IndexEntry<T> {
  map: Map<number, T>;
  length: number;
}

function refresh<T extends { id: number }>(entry: IndexEntry<T>, source: T[]): Map<number, T> {
  if (entry.length !== source.length) {
    entry.map.clear();
    for (const item of source) entry.map.set(item.id, item);
    entry.length = source.length;
  }
  return entry.map;
}

function emptyIndex<T>(): IndexEntry<T> {
  return { map: new Map<number, T>(), length: -1 };
}

export class World {
  readonly state: GameState;
  readonly rng: Rng;
  /** Events produced by the current tick. Drained by the caller. */
  events: GameEvent[] = [];

  /**
   * The ground. Derived from the match seed rather than stored, and built once
   * per World because it is immutable for the whole match.
   */
  readonly terrain: Terrain;

  /**
   * Cover, bound to the ground beneath it. Resolved once per World because a
   * building does not move, and re-deriving it per shot would put a terrain
   * sample per volume into the hit-registration path.
   */
  readonly cover: readonly CoverBox[];

  /** Spatial index over `cover`, so the hot paths do not scan all of it. */
  readonly coverGrid: CoverGrid;

  private readonly playerIndex = emptyIndex<Player>();
  private readonly squadIndex = emptyIndex<Squad>();
  private readonly fobIndex = emptyIndex<Fob>();
  private readonly deployableIndex = emptyIndex<Deployable>();
  private readonly rallyIndex = emptyIndex<RallyPoint>();
  private readonly vehicleIndex = emptyIndex<Vehicle>();

  constructor(state: GameState) {
    this.state = state;
    this.rng = Rng.restore(state.rng);
    this.terrain = createTerrain(
      state.terrainSeed,
      TEAM_IDS.map((team) => state.teams[team].mainBase),
      state.map.sizeM,
    );
    this.cover = state.map.cover.map((volume) =>
      resolveCover(volume, this.terrain.heightAt(volume.x, volume.y)),
    );
    this.coverGrid = new CoverGrid(this.cover, state.map.sizeM);
  }

  /** Persist the RNG cursor back into the state. Called at end of tick. */
  commitRng(): void {
    this.state.rng = this.rng.save();
  }

  newId(): number {
    return this.state.nextEntityId++;
  }

  emit(event: GameEvent): void {
    this.events.push(event);
  }

  player(id: PlayerId): Player | undefined {
    return refresh(this.playerIndex, this.state.players).get(id);
  }

  squad(id: SquadId): Squad | undefined {
    return refresh(this.squadIndex, this.state.squads).get(id);
  }

  fob(id: FobId): Fob | undefined {
    return refresh(this.fobIndex, this.state.fobs).get(id);
  }

  deployable(id: DeployableId): Deployable | undefined {
    return refresh(this.deployableIndex, this.state.deployables).get(id);
  }

  rally(id: RallyPointId): RallyPoint | undefined {
    return refresh(this.rallyIndex, this.state.rallyPoints).get(id);
  }

  vehicle(id: VehicleId): Vehicle | undefined {
    return refresh(this.vehicleIndex, this.state.vehicles).get(id);
  }

  /**
   * Live vehicle hulls, as boxes a round can hit.
   *
   * Rebuilt on demand rather than cached: vehicles move, and a stale hull is
   * a round that hits nothing or hits thin air. Axis-aligned regardless of
   * heading, for the same reason cover is — this runs in the hit-registration
   * path. A truck is roughly as wide as it is long from a rifleman's point of
   * view, and the error is smaller than the dispersion cone.
   */
  vehicleTargets(): VehicleTarget[] {
    // Cached per tick. Vehicles move at most once a tick, but shots happen
    // many times within one, and each rebuild costs a terrain sample per hull.
    if (this.vehicleTargetsTick === this.state.tick) return this.vehicleTargetCache;

    const targets: VehicleTarget[] = [];
    for (const vehicle of this.state.vehicles) {
      if (vehicle.destroyed) continue;
      const spec = VEHICLE_SPECS[vehicle.type];
      const groundZ = this.terrain.heightAt(vehicle.pos.x, vehicle.pos.y);
      const half = Math.max(spec.halfWidthM, spec.halfLengthM * 0.6);
      targets.push({
        id: vehicle.id,
        box: {
          minX: vehicle.pos.x - half,
          maxX: vehicle.pos.x + half,
          minY: vehicle.pos.y - half,
          maxY: vehicle.pos.y + half,
          minZ: groundZ,
          maxZ: groundZ + spec.heightM,
          kind: "container",
        },
      });
    }
    this.vehicleTargetCache = targets;
    this.vehicleTargetsTick = this.state.tick;
    return targets;
  }

  private vehicleTargetCache: VehicleTarget[] = [];
  private vehicleTargetsTick = -1;

  /** Reject a command, recording why. Never throws — see commands.ts. */
  reject(player: PlayerId, command: string, reason: string): void {
    this.emit({ t: "commandRejected", tick: this.state.tick, player, command, reason });
  }
}
