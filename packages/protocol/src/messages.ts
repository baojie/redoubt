/**
 * The wire contract.
 *
 * Server and client both depend on this and on nothing of each other's. It
 * describes only what crosses the socket — never how either side stores or
 * renders it.
 *
 * Three ideas shape the design, all from PLAN §4:
 *
 *  1. The server is the only authority. The client sends *intents*, never
 *     results, and never its own position.
 *  2. Every input carries a sequence number, and every snapshot echoes the last
 *     sequence the server consumed. That echo is what lets the client throw
 *     away confirmed predictions and replay the rest.
 *  3. Snapshots are culled by distance and diffed per entity, because 12 people
 *     on a 1 km² map do not need to know about the other side of it.
 */

import type {
  ControlPointId,
  DeployableId,
  DeployableType,
  FobId,
  GameEvent,
  Lane,
  MapDefinition,
  PlayerId,
  PlayerRole,
  PlayerStatus,
  RallyPointId,
  SquadId,
  TeamId,
  VehicleId,
  VehicleType,
} from "@redoubt/core";

/**
 * Bumped to 2 when `SelfView.runTicks` was added.
 *
 * The version exists so a mismatch is refused at the door. It was not bumped
 * with that field, and the consequence was immediate and ugly: a client running
 * the new code against a server still running the old one read `runTicks` as
 * undefined, computed `undefined + 1`, and predicted its own position as NaN.
 * The world stopped being drawn entirely — no error, no clue, just a blank
 * screen and `pos NaN, NaN` in the corner.
 *
 * Any change to what is on the wire has to come with a bump, including one that
 * only adds a field. "Additive changes are compatible" is only true for readers
 * that check whether the field arrived.
 *
 * 3 added grenades: a count on `SelfView` and the ones in the air on the
 * snapshot.
 */
export const PROTOCOL_VERSION = 3;

// ---------------------------------------------------------------------------
// Intents: what a client is allowed to ask for
// ---------------------------------------------------------------------------

/**
 * A command with the actor stripped out.
 *
 * The server fills in `player` from the authenticated connection. A client
 * that could name the actor could act as anyone, so the field simply does not
 * exist on the wire.
 */
export type Intent =
  | { t: "steer"; dir: { x: number; y: number } }
  | { t: "halt" }
  /** Mouse look. Authoritative — rounds leave along this. */
  | { t: "look"; yaw: number; pitch: number }
  /**
   * Pull the trigger. `renderTick` is what the shooter was looking at, for
   * lag compensation; the server clamps it into a legal window.
   */
  | { t: "fire"; renderTick?: number }
  | { t: "throwGrenade" }
  | { t: "reload" }
  /** Hold to aim down the sights. */
  | { t: "aim"; aiming: boolean }
  | { t: "spawn"; source: SpawnChoice }
  | { t: "placeRally" }
  | { t: "placeFob" }
  | { t: "dismantleFob"; fob: FobId }
  | { t: "placeDeployable"; fob: FobId; kind: DeployableType; pos: { x: number; y: number } }
  | { t: "build"; deployable: DeployableId }
  | { t: "engage"; target: PlayerId }
  | { t: "revive"; target: PlayerId }
  /** Pick up a casualty, or null to put them down. */
  | { t: "drag"; target: PlayerId | null }
  | { t: "giveUp" }
  | { t: "resupply" }
  | { t: "enterVehicle"; vehicle: VehicleId }
  | { t: "exitVehicle" }
  | { t: "driveTo"; to: { x: number; y: number } }
  /** Throttle and wheel, both in [-1, 1]. Held state. */
  | { t: "drive"; throttle: number; steering: number }
  | { t: "loadSupply"; constructionPoints: number; ammoPoints: number }
  | {
      t: "unloadSupply";
      fob: FobId;
      constructionPoints: number;
      ammoPoints: number;
    };

export type SpawnChoice =
  | { kind: "main" }
  | { kind: "rally"; rally: RallyPointId }
  | { kind: "habitat"; deployable: DeployableId };

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { t: "join"; protocol: number; name: string }
  /**
   * One input frame. `seq` is monotonic per connection; the server acks the
   * highest it has consumed. `intents` is the whole set for this frame, so a
   * lost frame costs one frame of input rather than desynchronising anything.
   */
  | { t: "input"; seq: number; intents: Intent[] }
  /** Round-trip probe. `sent` is the client's own clock, echoed back untouched. */
  | { t: "ping"; sent: number };

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/**
 * Everything about a player that a client can legitimately see. Note what is
 * absent: another player's ammo, their supply, their orders.
 */
export interface PlayerView {
  id: PlayerId;
  team: TeamId;
  squad: SquadId;
  role: PlayerRole;
  status: PlayerStatus;
  x: number;
  y: number;
  /** Which way they are facing, so a 3D client can orient the body. */
  yaw: number;
  /**
   * Riding in a vehicle. The renderer skips them: a soldier drawn at the
   * truck's own position ends up inside the truck, which reads as an empty
   * vehicle and as a teammate who is not there.
   */
  mounted: boolean;
}

/** Extra fields sent only for the receiving client's own soldier. */
export interface SelfView extends PlayerView {
  health: number;
  ammo: number;
  vehicle: VehicleId | null;
  /**
   * Raw ticks, not a countdown. The client owns `core`'s rule constants, so it
   * can work out the wait for each spawn source itself — and a countdown
   * computed server-side would be stale by the time it arrived anyway.
   */
  deployingSinceTick: number;
  bleedoutAtTick: number;
  /** Authoritative aim. The client predicts it locally and reconciles here. */
  aimYaw: number;
  aimPitch: number;
  /** Rounds in the magazine, distinct from `ammo`, the reserve. */
  magazine: number;
  /** Tick a reload finishes, or 0. */
  reloadingUntilTick: number;
  /** 0..1. Drives the client's vignette and its spread indicator. */
  suppression: number;
  /** Authoritative aiming state, so the client's zoom follows the server. */
  aiming: boolean;
  /** A casualty this player is hauling, or null. */
  dragging: PlayerId | null;
  /** Grenades left in hand, for the count on the HUD. */
  grenades: number;
  /**
   * Ticks of unbroken movement, which is what the run-up is built from.
   *
   * Sent because the client predicts its own movement and has to replay the
   * same speed curve; without it, prediction would walk at the standing-start
   * speed while the server ran, and the correction would grow with every step.
   */
  runTicks: number;
}

export interface ControlPointView {
  id: ControlPointId;
  owner: TeamId | null;
  contestingTeam: TeamId | null;
  progress: number;
}

export interface FobView {
  id: FobId;
  team: TeamId;
  x: number;
  y: number;
  constructionPoints: number;
  ammoPoints: number;
  radioHealth: number;
}

export interface DeployableView {
  id: DeployableId;
  fob: FobId;
  team: TeamId;
  kind: DeployableType;
  x: number;
  y: number;
  /** 0..1. */
  buildProgress: number;
  built: boolean;
  overrun: boolean;
}

export interface RallyView {
  id: RallyPointId;
  squad: SquadId;
  team: TeamId;
  x: number;
  y: number;
  /** Ticks until the wave cooldown expires, 0 if it already has. */
  readyInTicks: number;
  /**
   * Whether it will actually accept a spawn right now. Distinct from the
   * cooldown: a rally with enemies inside 50 m is off the menu regardless of
   * its timer, and the client cannot see those enemies to work it out.
   */
  live: boolean;
}

/** A grenade in flight, for the renderer. */
export interface GrenadeView {
  id: number;
  x: number;
  y: number;
  z: number;
}

export interface VehicleView {
  id: VehicleId;
  team: TeamId;
  kind: VehicleType;
  x: number;
  y: number;
  /** Which way it is pointing, so the renderer can orient the hull. */
  heading: number;
  occupants: number;
  /** Total seats, so a client can show "2/3" and know whether to offer a ride. */
  seats: number;
  /** 0..1. A burning truck should look like one. */
  health: number;
  cargoConstructionPoints: number;
  cargoAmmoPoints: number;
}

export interface TeamView {
  id: TeamId;
  tickets: number;
}

/**
 * One frame of world state.
 *
 * `removed` carries ids that have left this client's view — either destroyed
 * or simply out of range. Without it a client would accumulate ghosts, since
 * absence from a delta means "unchanged", not "gone".
 */
export interface Snapshot {
  tick: number;
  /** Highest input sequence from this client that the server has consumed. */
  ackSeq: number;
  /** True when this frame carries every visible entity, not just the changes. */
  full: boolean;

  self: SelfView | null;
  players: PlayerView[];
  controlPoints: ControlPointView[];
  fobs: FobView[];
  deployables: DeployableView[];
  rallies: RallyView[];
  vehicles: VehicleView[];
  /**
   * Grenades in the air.
   *
   * Sent in full rather than diffed: there are almost never more than a handful
   * and each lives about three seconds, so the dirty-tracking that pays for
   * itself on players and vehicles would cost more than it saves here.
   */
  grenades: GrenadeView[];
  teams: TeamView[];

  removed: {
    players: PlayerId[];
    fobs: FobId[];
    deployables: DeployableId[];
    rallies: RallyPointId[];
    vehicles: VehicleId[];
  };

  doubleNeutral: boolean;
  phase: "staging" | "active" | "finished";
}

/** Sent once on join: the constants a client needs before it can draw anything. */
export interface WelcomePayload {
  protocol: number;
  playerId: PlayerId;
  team: TeamId;
  squad: SquadId;
  tickRateHz: number;
  /**
   * Seed for the procedural terrain. The client rebuilds the exact same ground
   * from this rather than downloading a heightmap — see core/terrain.ts.
   */
  terrainSeed: number;
  /**
   * How often snapshots are sent, which is deliberately slower than the tick
   * rate. The client needs it to size its interpolation delay: it renders one
   * snapshot interval in the past so it always has two frames to interpolate
   * between.
   */
  snapshotRateHz: number;
  /** Server tick at the moment of joining, so the client can align its clock. */
  tick: number;
  map: MapDefinition;
  /**
   * The drawn lane. Sent in full because a 2D map client renders the flags it
   * can see anyway; RAAS hides the *route*, and hiding it from the renderer
   * rather than the protocol keeps the client honest about what it displays.
   */
  lane: Lane;
}

export type ServerMessage =
  | ({ t: "welcome" } & WelcomePayload)
  | { t: "snapshot"; snapshot: Snapshot }
  /** Gameplay events worth surfacing: kill feed, flag captures, FOB losses. */
  | { t: "events"; tick: number; events: GameEvent[] }
  | { t: "pong"; sent: number; serverTick: number }
  | { t: "rejected"; reason: string };
