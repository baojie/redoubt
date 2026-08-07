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
import { resolveCover, type CoverBox } from "./cover.js";
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

  /** Reject a command, recording why. Never throws — see commands.ts. */
  reject(player: PlayerId, command: string, reason: string): void {
    this.emit({ t: "commandRejected", tick: this.state.tick, player, command, reason });
  }
}
