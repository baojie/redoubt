/**
 * Events emitted by a tick.
 *
 * `core` has no logging, no console, no I/O. It reports what happened by
 * appending to an event list that the caller drains. The headless sim turns
 * these into a battle report; the server will forward a filtered subset to
 * clients.
 */

import type { Vec3 } from "./math.js";
import type {
  ControlPointId,
  DeployableId,
  FobId,
  PlayerId,
  RallyPointId,
  SquadId,
  TeamId,
  VehicleId,
} from "./types.js";
import type { DeployableType, VehicleType } from "./rules.js";

export type TicketReason =
  | "infantryDeath"
  | "commanderDeath"
  | "fobRadioDestroyed"
  | "vehicleLost"
  | "firstCapture"
  | "positionalBleed"
  | "mercyBleed";

export type GameEvent =
  | { t: "matchStarted"; tick: number; lane: string }
  | { t: "matchEnded"; tick: number; winner: TeamId | null; reason: string }
  | {
      t: "ticketChange";
      tick: number;
      team: TeamId;
      delta: number;
      total: number;
      reason: TicketReason;
    }
  | {
      t: "controlPointNeutralised";
      tick: number;
      point: ControlPointId;
      by: TeamId;
      formerOwner: TeamId;
    }
  | {
      t: "controlPointCaptured";
      tick: number;
      point: ControlPointId;
      by: TeamId;
      firstEver: boolean;
    }
  | { t: "doubleNeutralStarted"; tick: number }
  | { t: "doubleNeutralEnded"; tick: number }
  | { t: "mercyBleedStarted"; tick: number; bleeding: TeamId }
  | { t: "mercyBleedEnded"; tick: number; bleeding: TeamId }
  | { t: "fobPlaced"; tick: number; fob: FobId; team: TeamId; by: PlayerId }
  | {
      t: "fobDestroyed";
      tick: number;
      fob: FobId;
      team: TeamId;
      selfDismantled: boolean;
      lifetimeTicks: number;
    }
  | {
      t: "deployablePlaced";
      tick: number;
      deployable: DeployableId;
      fob: FobId;
      team: TeamId;
      kind: DeployableType;
    }
  | {
      t: "deployableBuilt";
      tick: number;
      deployable: DeployableId;
      team: TeamId;
      kind: DeployableType;
      builders: number;
      buildTicks: number;
    }
  | {
      t: "deployableDestroyed";
      tick: number;
      deployable: DeployableId;
      team: TeamId;
      kind: DeployableType;
      cascaded: boolean;
    }
  | { t: "habitatOverrunStarted"; tick: number; deployable: DeployableId; team: TeamId }
  | { t: "habitatOverrunEnded"; tick: number; deployable: DeployableId; team: TeamId }
  | { t: "rallyPlaced"; tick: number; rally: RallyPointId; squad: SquadId; team: TeamId }
  | {
      t: "rallyDestroyed";
      tick: number;
      rally: RallyPointId;
      squad: SquadId;
      team: TeamId;
      byEnemy: boolean;
    }
  | {
      t: "playerSpawned";
      tick: number;
      player: PlayerId;
      team: TeamId;
      source: "main" | "rally" | "habitat";
    }
  | { t: "playerDowned"; tick: number; player: PlayerId; team: TeamId; by: PlayerId | null }
  | { t: "playerRevived"; tick: number; player: PlayerId; team: TeamId; by: PlayerId }
  | {
      t: "playerDied";
      tick: number;
      player: PlayerId;
      team: TeamId;
      cause: "bleedout" | "gaveUp" | "finished";
    }
  | {
      t: "supplyLoaded";
      tick: number;
      vehicle: VehicleId;
      team: TeamId;
      constructionPoints: number;
      ammoPoints: number;
    }
  | {
      t: "supplyUnloaded";
      tick: number;
      vehicle: VehicleId;
      fob: FobId;
      team: TeamId;
      constructionPoints: number;
      ammoPoints: number;
    }
  | {
      t: "vehicleDestroyed";
      tick: number;
      vehicle: VehicleId;
      team: TeamId;
      kind: VehicleType;
    }
  | {
      /**
       * One round, from muzzle to impact. Carries time of flight so a client
       * can draw a tracer that arrives when the round actually did.
       */
      t: "grenadeThrown";
      grenade: number;
      thrower: PlayerId;
      team: TeamId;
      from: Vec3;
    }
  | {
      /** A grenade went off. Carries where, so clients can put an effect there. */
      t: "grenadeExploded";
      grenade: number;
      thrower: PlayerId;
      at: Vec3;
    }
  | {
      t: "shotFired";
      tick: number;
      shooter: PlayerId;
      team: TeamId;
      from: { x: number; y: number; z: number };
      to: { x: number; y: number; z: number };
      flightSeconds: number;
      hit: PlayerId | null;
    }
  | {
      t: "commandRejected";
      tick: number;
      player: PlayerId;
      command: string;
      reason: string;
    };

/** Sink handed to systems so they can report without owning the array. */
export type EventSink = GameEvent[];

/**
 * Every kind of event a system can emit, at runtime.
 *
 * The union above cannot be enumerated at runtime, which is how an event kind
 * comes to exist that nothing downstream ever carries: `grenadeExploded` was
 * emitted correctly, matched no case in the server's routing, and reached no
 * client — the fourth time this project produced that same shape of gap.
 *
 * The two checks below make the list impossible to leave stale: one fails to
 * compile if a kind is emitted but not listed, the other if a kind is listed
 * but no longer exists. Adding an event and forgetting this file is a build
 * error, and the server has a test that every entry here is routed somewhere.
 */
export const EVENT_KINDS = [
  "matchStarted",
  "matchEnded",
  "controlPointCaptured",
  "controlPointNeutralised",
  "doubleNeutralStarted",
  "doubleNeutralEnded",
  "mercyBleedStarted",
  "mercyBleedEnded",
  "habitatOverrunStarted",
  "habitatOverrunEnded",
  "fobPlaced",
  "fobDestroyed",
  "deployablePlaced",
  "deployableBuilt",
  "deployableDestroyed",
  "rallyPlaced",
  "rallyDestroyed",
  "playerSpawned",
  "playerDowned",
  "playerRevived",
  "playerDied",
  "shotFired",
  "grenadeThrown",
  "grenadeExploded",
  "vehicleDestroyed",
  "supplyLoaded",
  "supplyUnloaded",
  "ticketChange",
  "commandRejected",
] as const;

type ListedKind = (typeof EVENT_KINDS)[number];
type EmittedKind = GameEvent["t"];

/** Fails to compile if a kind is emitted but missing from EVENT_KINDS. */
type MissingFromList = Exclude<EmittedKind, ListedKind>;
/** Fails to compile if EVENT_KINDS names something no longer emitted. */
type StaleInList = Exclude<ListedKind, EmittedKind>;

const _everyEmittedKindIsListed: MissingFromList extends never ? true : never = true;
const _nothingStaleIsListed: StaleInList extends never ? true : never = true;
void _everyEmittedKindIsListed;
void _nothingStaleIsListed;
