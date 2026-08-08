/**
 * Player intents.
 *
 * A tick consumes a batch of these. Commands are *requests*: every one is
 * validated against authoritative state and silently rejected (with a
 * `commandRejected` event) if illegal. Systems never throw on bad input —
 * a malicious or buggy client must not be able to crash the server.
 */

import type { Vec2 } from "./math.js";
import type { DeployableType } from "./rules.js";
import type { DeployableId, FobId, PlayerId, RallyPointId, VehicleId } from "./types.js";

/** Where a deploying player wants to enter the world. */
export type SpawnSource =
  | { kind: "main" }
  | { kind: "rally"; rally: RallyPointId }
  | { kind: "habitat"; deployable: DeployableId };

export type Command =
  /** Walk toward a point. Persists until replaced — one waypoint per player. */
  | { t: "move"; player: PlayerId; to: Vec2 }
  /**
   * Walk along a direction until told otherwise — the WASD form of `move`.
   * `dir` need not be normalised; a zero vector stops. Persisting rather than
   * being per-tick means a dropped input packet does not stutter the soldier,
   * and the client can predict forward from the last direction it sent.
   */
  | { t: "steer"; player: PlayerId; dir: Vec2 }
  /** Stop moving. */
  | { t: "halt"; player: PlayerId }
  /** Enter the world from the chosen spawn, once the timer allows. */
  | { t: "spawn"; player: PlayerId; source: SpawnSource }
  /** Squad leader plants a rally point at their feet. */
  | { t: "placeRally"; player: PlayerId }
  /** Squad leader plants a FOB radio at their feet. */
  | { t: "placeFob"; player: PlayerId }
  /** Tear down your own radio — costs no tickets. */
  | { t: "dismantleFob"; player: PlayerId; fob: FobId }
  /** Stake out a build site inside a FOB's build radius. */
  | {
      t: "placeDeployable";
      player: PlayerId;
      fob: FobId;
      kind: DeployableType;
      pos: Vec2;
    }
  /** Contribute build work this tick. Must be within reach of the site. */
  | { t: "build"; player: PlayerId; deployable: DeployableId }
  /**
   * Point the rifle. What a mouse produces, and authoritative state — rounds
   * leave along this direction, so it is not a rendering detail.
   */
  | { t: "look"; player: PlayerId; yaw: number; pitch: number }
  /**
   * Pull the trigger along the current aim. `renderTick` is the tick the
   * shooter believes they were looking at; the server clamps it into the
   * lag-compensation window before rewinding.
   */
  | { t: "fire"; player: PlayerId; renderTick?: number }
  | { t: "reload"; player: PlayerId }
  /** Hold to aim down the sights. Held state, like steering. */
  | { t: "aim"; player: PlayerId; aiming: boolean }
  /**
   * Swing onto a body and fire. What a bot issues — a convenience over
   * look+fire, with no privileged path to a hit: the round still has to fly.
   */
  | { t: "engage"; player: PlayerId; target: PlayerId }
  /** Work on reviving a downed teammate within reach. */
  | { t: "revive"; player: PlayerId; target: PlayerId }
  /**
   * Pick up or put down a downed teammate. Dragging is held state: the body
   * follows until dropped, the carrier is killed, or the casualty is revived
   * or expires.
   */
  | { t: "drag"; player: PlayerId; target: PlayerId | null }
  /** Give up while downed: costs the ticket immediately. */
  | { t: "giveUp"; player: PlayerId }
  /** Top up ammo from a crate, a FOB radio, or a vehicle. */
  | { t: "resupply"; player: PlayerId }
  | { t: "enterVehicle"; player: PlayerId; vehicle: VehicleId }
  | { t: "exitVehicle"; player: PlayerId }
  /** Drive the occupied vehicle toward a point. What a bot issues. */
  | { t: "driveTo"; player: PlayerId; to: Vec2 }
  /**
   * Throttle and wheel. What a human issues. Held state; supersedes any
   * standing waypoint so the two can never fight over the vehicle.
   */
  | { t: "drive"; player: PlayerId; throttle: number; steering: number }
  /** Load cargo at main base. Amounts are clamped to spec and availability. */
  | {
      t: "loadSupply";
      player: PlayerId;
      constructionPoints: number;
      ammoPoints: number;
    }
  /** Unload cargo into a FOB within the unload radius. */
  | {
      t: "unloadSupply";
      player: PlayerId;
      fob: FobId;
      constructionPoints: number;
      ammoPoints: number;
    }
  /**
   * Make a soldier immune to damage. A playtest affordance.
   *
   * A command rather than a poke at the state from outside, so the match stays
   * reproducible from its seed and its inputs. Nothing in `protocol` maps an
   * intent onto it — only the server can issue it, and only when it was told
   * to at startup, so it is unreachable from the wire.
   */
  | { t: "setInvulnerable"; player: PlayerId; on: boolean };

export type CommandType = Command["t"];
