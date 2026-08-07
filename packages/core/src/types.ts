/**
 * Authoritative state shape.
 *
 * Everything reachable from `GameState` is plain data: no class instances, no
 * closures, no references to anything outside `core`. That is what makes the
 * state cloneable, hashable, snapshot-able over the wire, and replayable.
 */

import type { Vec2 } from "./math.js";
import type { RngState } from "./rng.js";
import type { CoverVolume } from "./cover.js";
import type { DeployableType, VehicleType } from "./rules.js";

export type TeamId = 0 | 1;
export type PlayerId = number;
export type SquadId = number;
export type ControlPointId = number;
export type FobId = number;
export type DeployableId = number;
export type RallyPointId = number;
export type VehicleId = number;

/** Convenience for "the other team". */
export function enemyOf(team: TeamId): TeamId {
  return team === 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export type PlayerRole = "rifleman" | "squadLeader" | "medic" | "crewman";

/**
 * `deploying` means dead and waiting on a spawn timer; `downed` means bleeding
 * out and revivable — no ticket has been spent yet. The ticket is only charged
 * when a downed player bleeds out or gives up, which is what makes the medic
 * mechanic economically meaningful.
 */
export type PlayerStatus = "alive" | "downed" | "deploying";

export interface Player {
  id: PlayerId;
  team: TeamId;
  squad: SquadId;
  role: PlayerRole;
  status: PlayerStatus;
  pos: Vec2;
  /**
   * Standing move order — walk to a point. What a bot issues.
   * Mutually exclusive with `steer`: the last command issued wins.
   */
  waypoint: Vec2 | null;
  /**
   * Standing steer order — a unit vector to keep walking along. What a human
   * on WASD issues. Held until replaced, so a dropped packet does not stop the
   * soldier dead, and so the client can predict from the same input the server
   * will apply.
   */
  steer: Vec2 | null;
  health: number;
  ammo: number;
  /** Tick at which a downed player expires into a real death. */
  bleedoutAtTick: number;
  /**
   * Tick this player entered `deploying`. The wait before they may spawn is
   * measured from here and depends on which spawn they pick — 15s at main,
   * 10s on a rally, 45s on a habitat.
   */
  deployingSinceTick: number;
  /** Vehicle currently occupied, or null. */
  vehicle: VehicleId | null;
  /** Accumulated revive work being applied to this player, in ticks. */
  reviveProgressTicks: number;
  /**
   * Where this soldier is looking. Yaw runs from +x toward +y; pitch is
   * positive upward. Rounds leave along this direction plus dispersion, so it
   * is authoritative state, not a rendering detail.
   */
  aimYaw: number;
  aimPitch: number;
  /** Rounds left in the magazine. Distinct from `ammo`, the reserve. */
  magazine: number;
  /** Tick a reload completes, or 0 when not reloading. */
  reloadingUntilTick: number;
  /**
   * How rattled this soldier is, 0..1. Raised by rounds passing close, decays
   * over time, widens their dispersion. PLAN §5 calls this the soul of the
   * feel — being shot at matters even when the rounds miss.
   */
  suppression: number;
  /** Rounds fired in the current burst; widens the cone, bleeds off at rest. */
  recoilSteps: number;
  /**
   * Suppression accumulated by rounds fired *this tick*, folded into
   * `suppression` once every command has run. Deferred for the same reason
   * damage is: applying it immediately would let whichever team's commands are
   * processed first rattle the other before they shoot, every tick, forever.
   */
  pendingSuppression: number;
  /** Rate-of-fire gate: the earliest tick this player may fire again. */
  nextShotAtTick: number;
  /**
   * Recent ground positions, newest last, for lag-compensated hit
   * registration. The server rewinds to what the shooter actually saw before
   * testing a shot — PLAN §4.
   */
  history: Vec2[];
  /**
   * Who last put a round into this player, for kill credit. Set when damage
   * lands; read when the casualty is resolved at the end of the tick.
   */
  lastHitBy: PlayerId | null;
  /** Lifetime counters, for the battle report. */
  kills: number;
  deaths: number;
}

export interface Squad {
  id: SquadId;
  team: TeamId;
  /** Null when the leader is dead or the squad is empty. */
  leader: PlayerId | null;
  members: PlayerId[];
  /** A squad may hold at most one rally point. */
  rally: RallyPointId | null;
}

export interface Team {
  id: TeamId;
  tickets: number;
  mainBase: Vec2;
  squads: SquadId[];
  players: PlayerId[];
  /**
   * The squad leader holding the commander slot. Their death costs double —
   * PLAN §2.1. Null only if the slot is vacant.
   */
  commander: PlayerId | null;
  /** Set once mercy bleed starts, so it drains at a fixed rate. */
  mercyBleedStartedAtTick: number | null;
}

// ---------------------------------------------------------------------------
// Control points
// ---------------------------------------------------------------------------

export interface ControlPoint {
  id: ControlPointId;
  name: string;
  pos: Vec2;
  /** Null means neutral. */
  owner: TeamId | null;
  /** Team currently making progress on this point, or null. */
  contestingTeam: TeamId | null;
  /**
   * Progress of the current contest in [0, 1]. Interpretation depends on
   * ownership: against an owned point it is neutralisation, against a neutral
   * point it is capture.
   */
  progress: number;
  /** Teams that have ever owned this point, for the one-time capture bonus. */
  everOwnedBy: TeamId[];
}

// ---------------------------------------------------------------------------
// FOBs and deployables
// ---------------------------------------------------------------------------

export interface Fob {
  id: FobId;
  team: TeamId;
  pos: Vec2;
  radioHealth: number;
  /** Construction points. Invariant: within [0, FOB_MAX_CONSTRUCTION_POINTS]. */
  constructionPoints: number;
  /** Ammo points. Invariant: within [0, FOB_MAX_AMMO_POINTS]. */
  ammoPoints: number;
  deployables: DeployableId[];
  destroyed: boolean;
  createdAtTick: number;
}

export interface Deployable {
  id: DeployableId;
  fob: FobId;
  team: TeamId;
  type: DeployableType;
  pos: Vec2;
  /** Seconds of single-builder work completed so far. */
  buildProgressWork: number;
  /** Total work required — cached from the spec at placement time. */
  buildWorkRequired: number;
  built: boolean;
  health: number;
  /** Habitats only: true while enemies are overrunning it. */
  overrun: boolean;
  destroyed: boolean;
  /** Construction points already spent on this build, for partial refunds. */
  constructionPointsSpent: number;
  ammoPointsSpent: number;
  placedAtTick: number;
  /** Tick construction completed, or null while unbuilt. */
  builtAtTick: number | null;
}

export interface RallyPoint {
  id: RallyPointId;
  squad: SquadId;
  team: TeamId;
  pos: Vec2;
  createdAtTick: number;
  /** Tick the current wave opened, or null if no wave is open. */
  waveOpenedAtTick: number | null;
  /** Tick the rally becomes usable again. */
  availableAtTick: number;
  destroyed: boolean;
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export interface Vehicle {
  id: VehicleId;
  team: TeamId;
  type: VehicleType;
  pos: Vec2;
  /** Standing drive order, issued by whoever is in the driver's seat. */
  waypoint: Vec2 | null;
  /** Metres per second actually travelled last tick — gates supply transfer. */
  speedMps: number;
  health: number;
  /** Seat 0 is the driver. */
  occupants: PlayerId[];
  cargoConstructionPoints: number;
  cargoAmmoPoints: number;
  destroyed: boolean;
  /** Tick a destroyed vehicle returns at main. */
  respawnAtTick: number;
  /**
   * An in-progress load or unload. Supply moves at a fixed rate while the
   * driver holds the command, so a run is a session rather than an instant.
   * Cleared — and reported — on the first tick the command stops arriving.
   */
  transfer: SupplyTransfer | null;
}

export interface SupplyTransfer {
  kind: "load" | "unload";
  /** Destination FOB for an unload, null for a load at main. */
  fob: FobId | null;
  /** Points moved so far this session, for the summary event. */
  constructionPoints: number;
  ammoPoints: number;
  /** Set each tick the driver reissues the command; checked and cleared after. */
  activeThisTick: boolean;
}

// ---------------------------------------------------------------------------
// Match-level state
// ---------------------------------------------------------------------------

export type MatchPhase = "staging" | "active" | "finished";

export type MatchOutcome =
  | { kind: "ongoing" }
  | { kind: "ticketsExhausted"; winner: TeamId; loser: TeamId }
  | { kind: "timeLimit"; winner: TeamId | null };

/**
 * A lane is one ordered chain of control points from team 0's side to team 1's.
 * RAAS draws one lane per match and does not reveal it — PLAN §2.2.
 */
export interface Lane {
  name: string;
  points: ControlPointId[];
}

export interface MapDefinition {
  name: string;
  sizeM: number;
  /**
   * Hand-placed solid volumes: buildings, walls, containers. They stop rounds
   * and they stop people, which is what makes "take cover" mean anything on
   * ground that is otherwise open.
   */
  cover: CoverVolume[];
  mainBases: Record<TeamId, Vec2>;
  controlPoints: Array<{ id: ControlPointId; name: string; pos: Vec2 }>;
  lanes: Lane[];
  /** Where each team's vehicles start. */
  vehicleSpawns: Record<TeamId, Vec2>;
}

export interface GameState {
  tick: number;
  phase: MatchPhase;
  outcome: MatchOutcome;

  rng: RngState;
  /**
   * Seed for the procedural terrain. Held separately from the RNG state, which
   * advances every tick — the ground must not move.
   */
  terrainSeed: number;
  map: MapDefinition;
  /** The lane RAAS drew this match. */
  lane: Lane;

  teams: Record<TeamId, Team>;
  players: Player[];
  squads: Squad[];
  controlPoints: ControlPoint[];
  fobs: Fob[];
  deployables: Deployable[];
  rallyPoints: RallyPoint[];
  vehicles: Vehicle[];

  /** Monotonic id source, so ids never collide across entity lifetimes. */
  nextEntityId: number;

  /** True while two or more lane points are neutral: all bleed is paused. */
  doubleNeutral: boolean;

  /** Accumulators for fractional ticket bleed, kept out of the integer count. */
  bleedFraction: Record<TeamId, number>;
}
