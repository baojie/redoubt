/**
 * Turning a client's intent into an authoritative command.
 *
 * This is the trust boundary, and it is deliberately one small function.
 * Everything arriving from a socket is shaped like `Intent`, which carries no
 * actor: the server supplies the player id from the connection, so a client
 * cannot act as anybody but itself no matter what it sends.
 *
 * Numeric fields are sanitised here too. `core` validates *game* legality —
 * can this squad leader place a FOB here — but it reasonably assumes its
 * inputs are finite numbers. A NaN reaching a position would poison state
 * silently, so it is rejected at the door.
 */

import { DEPLOYABLE_TYPES, type Command, type DeployableType, type PlayerId } from "@redoubt/core";
import type { Intent } from "./messages.js";

const DEPLOYABLE_TYPE_SET: ReadonlySet<string> = new Set(DEPLOYABLE_TYPES);

function deployableType(value: unknown): DeployableType | null {
  if (typeof value !== "string") return null;
  return DEPLOYABLE_TYPE_SET.has(value) ? (value as DeployableType) : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function point(value: unknown): { x: number; y: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y } = value as { x?: unknown; y?: unknown };
  if (!finite(x) || !finite(y)) return null;
  return { x, y };
}

function id(value: unknown): number | null {
  if (!finite(value)) return null;
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

/** Non-negative, finite, and not absurd — supply amounts are clamped by core. */
function amount(value: unknown): number | null {
  if (!finite(value) || value < 0) return null;
  return value;
}

/**
 * Returns the command to apply, or null if the intent is malformed.
 *
 * A null result means "drop this intent", never "drop the connection": a
 * client that sends one bad frame during a reconnect should not be kicked.
 */
export function intentToCommand(player: PlayerId, intent: Intent): Command | null {
  if (typeof intent !== "object" || intent === null) return null;

  switch (intent.t) {
    case "steer": {
      const dir = point(intent.dir);
      return dir === null ? null : { t: "steer", player, dir };
    }
    case "halt":
      return { t: "halt", player };

    case "look": {
      if (!finite(intent.yaw) || !finite(intent.pitch)) return null;
      return { t: "look", player, yaw: intent.yaw, pitch: intent.pitch };
    }
    case "fire": {
      const renderTick = intent.renderTick;
      if (renderTick !== undefined && !finite(renderTick)) return null;
      return renderTick === undefined
        ? { t: "fire", player }
        : { t: "fire", player, renderTick };
    }
    case "reload":
      return { t: "reload", player };
    case "aim":
      return { t: "aim", player, aiming: intent.aiming === true };

    case "spawn": {
      const source = intent.source;
      if (typeof source !== "object" || source === null) return null;
      switch (source.kind) {
        case "main":
          return { t: "spawn", player, source: { kind: "main" } };
        case "rally": {
          const rally = id(source.rally);
          return rally === null
            ? null
            : { t: "spawn", player, source: { kind: "rally", rally } };
        }
        case "habitat": {
          const deployable = id(source.deployable);
          return deployable === null
            ? null
            : { t: "spawn", player, source: { kind: "habitat", deployable } };
        }
        default:
          return null;
      }
    }

    case "placeRally":
      return { t: "placeRally", player };
    case "placeFob":
      return { t: "placeFob", player };

    case "dismantleFob": {
      const fob = id(intent.fob);
      return fob === null ? null : { t: "dismantleFob", player, fob };
    }

    case "placeDeployable": {
      const fob = id(intent.fob);
      const pos = point(intent.pos);
      // Validated against core's own table rather than trusted as a string:
      // an unknown kind would index the spec map to undefined and crash a
      // system that has every right to assume its input is a real type.
      const kind = deployableType(intent.kind);
      if (fob === null || pos === null || kind === null) return null;
      return { t: "placeDeployable", player, fob, kind, pos };
    }

    case "build": {
      const deployable = id(intent.deployable);
      return deployable === null ? null : { t: "build", player, deployable };
    }

    case "engage": {
      const target = id(intent.target);
      return target === null ? null : { t: "engage", player, target };
    }
    case "revive": {
      const target = id(intent.target);
      return target === null ? null : { t: "revive", player, target };
    }
    case "drag": {
      if (intent.target === null) return { t: "drag", player, target: null };
      const target = id(intent.target);
      return target === null ? null : { t: "drag", player, target };
    }

    case "giveUp":
      return { t: "giveUp", player };
    case "resupply":
      return { t: "resupply", player };

    case "enterVehicle": {
      const vehicle = id(intent.vehicle);
      return vehicle === null ? null : { t: "enterVehicle", player, vehicle };
    }
    case "exitVehicle":
      return { t: "exitVehicle", player };

    case "driveTo": {
      const to = point(intent.to);
      return to === null ? null : { t: "driveTo", player, to };
    }
    case "drive": {
      if (!finite(intent.throttle) || !finite(intent.steering)) return null;
      // Range is clamped by core, which is the authority on how fast a truck
      // goes; this only rejects values that are not numbers at all.
      return {
        t: "drive",
        player,
        throttle: intent.throttle,
        steering: intent.steering,
      };
    }

    case "loadSupply": {
      const constructionPoints = amount(intent.constructionPoints);
      const ammoPoints = amount(intent.ammoPoints);
      if (constructionPoints === null || ammoPoints === null) return null;
      return { t: "loadSupply", player, constructionPoints, ammoPoints };
    }

    case "unloadSupply": {
      const fob = id(intent.fob);
      const constructionPoints = amount(intent.constructionPoints);
      const ammoPoints = amount(intent.ammoPoints);
      if (fob === null || constructionPoints === null || ammoPoints === null) return null;
      return { t: "unloadSupply", player, fob, constructionPoints, ammoPoints };
    }

    default:
      return null;
  }
}
