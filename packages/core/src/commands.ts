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
  /** Shoot at someone. The simplified M0/M1 combat model resolves it. */
  | { t: "engage"; player: PlayerId; target: PlayerId }
  /** Work on reviving a downed teammate within reach. */
  | { t: "revive"; player: PlayerId; target: PlayerId }
  /** Give up while downed: costs the ticket immediately. */
  | { t: "giveUp"; player: PlayerId }
  /** Top up ammo from a crate, a FOB radio, or a vehicle. */
  | { t: "resupply"; player: PlayerId }
  | { t: "enterVehicle"; player: PlayerId; vehicle: VehicleId }
  | { t: "exitVehicle"; player: PlayerId }
  /** Drive the occupied vehicle toward a point. */
  | { t: "driveTo"; player: PlayerId; to: Vec2 }
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
    };

export type CommandType = Command["t"];
