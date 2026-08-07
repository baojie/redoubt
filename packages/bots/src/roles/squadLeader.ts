/**
 * The squad leader, and the FOB team that follows them.
 *
 * A squad leader holds the two things that decide where their team can respawn:
 * the rally point in their pocket, and the radio they choose to plant. Those
 * are the highest-leverage decisions in the game, which is why this file is
 * about siting and timing rather than about shooting.
 */

import {
  distance,
  rules,
  type Command,
  type ControlPoint,
  type GameState,
  type Player,
  type TeamId,
  type Vec2,
} from "@redoubt/core";
import { liveFobs, spreadAround } from "../awareness.js";
import { assault, fightTowards } from "./soldier.js";

/** How far behind the contested flag to seat a FOB. */
const FOB_STANDOFF_M = 220;
/**
 * A FOB further than this from the objective has been left behind by the
 * front and is no longer paying for itself.
 */
export const FOB_STALE_DISTANCE_M = 600;
/** Slack over the main-base exclusion so a site is never marginal. */
const MAIN_BASE_MARGIN_M = 30;
/** Close enough to the objective that a leader should drop a rally. */
const RALLY_DROP_DISTANCE_M = 250;

/**
 * Where this team should try to seat its next FOB: behind the objective, on
 * the line back to friendly main, but never so far back that it violates the
 * 150 m main-base exclusion — the standoff shortens rather than the placement
 * failing over and over.
 */
export function fobSite(state: GameState, team: TeamId, objective: ControlPoint): Vec2 {
  const main = state.teams[team].mainBase;
  const dx = main.x - objective.pos.x;
  const dy = main.y - objective.pos.y;
  const toMain = Math.hypot(dx, dy) || 1;

  const clearance = rules.FOB_MIN_DISTANCE_FROM_MAIN_BASE_M + MAIN_BASE_MARGIN_M;
  const standoff = Math.min(FOB_STANDOFF_M, Math.max(0, toMain - clearance));
  return {
    x: objective.pos.x + (dx / toMain) * standoff,
    y: objective.pos.y + (dy / toMain) * standoff,
  };
}

/** Rally management, then fight like anyone else. */
export function leadSquad(
  state: GameState,
  player: Player,
  objective: ControlPoint,
  out: Command[],
): void {
  const squad = state.squads.find((s) => s.id === player.squad);
  const hasRally =
    squad?.rally != null &&
    state.rallyPoints.some((r) => r.id === squad.rally && !r.destroyed);

  if (!hasRally && distance(player.pos, objective.pos) <= RALLY_DROP_DISTANCE_M) {
    out.push({ t: "placeRally", player: player.id });
  }
  assault(state, player, objective, out);
}

/**
 * The FOB team: a squad leader plus two diggers who travel together, plant the
 * radio behind the objective, and build a habitat and an ammo crate as soon as
 * a truck has delivered the construction points to pay for them.
 */
export function workFob(
  state: GameState,
  player: Player,
  isLeader: boolean,
  objective: ControlPoint,
  out: Command[],
): void {
  const team = player.team;
  const site = fobSite(state, team, objective);
  const fobs = liveFobs(state, team);
  const usable = fobs.find((f) => distance(f.pos, objective.pos) <= FOB_STALE_DISTANCE_M);

  if (usable === undefined) {
    // Nothing worth having. If a stale one is in the way of a better site,
    // pull it down first — that is free, and PLAN §2.4 calls it the correct
    // play once a position has stopped being useful.
    const blocking = fobs.find(
      (f) => distance(f.pos, site) < rules.FOB_MIN_DISTANCE_FROM_FRIENDLY_FOB_M,
    );
    if (blocking !== undefined && isLeader) {
      if (distance(player.pos, blocking.pos) > rules.BUILD_REACH_M) {
        out.push({ t: "move", player: player.id, to: blocking.pos });
      } else {
        out.push({ t: "dismantleFob", player: player.id, fob: blocking.id });
      }
      return;
    }

    const stand = isLeader
      ? site
      : spreadAround(state, site, player, rules.FOB_PLACE_SQUADMATE_RADIUS_M / 2);
    if (distance(player.pos, stand) > rules.BUILD_REACH_M) {
      out.push({ t: "move", player: player.id, to: stand });
      return;
    }
    if (isLeader) out.push({ t: "placeFob", player: player.id });
    return;
  }

  // A FOB exists. Stake out what is missing, then dig.
  const owned = state.deployables.filter((d) => d.fob === usable.id && !d.destroyed);
  const wanted: Array<"habitat" | "ammoCrate"> = ["habitat", "ammoCrate"];
  const missing = wanted.find((kind) => !owned.some((d) => d.type === kind));

  const unbuilt = owned.find((d) => !d.built);
  if (unbuilt !== undefined) {
    if (distance(player.pos, unbuilt.pos) > rules.BUILD_REACH_M) {
      out.push({ t: "move", player: player.id, to: unbuilt.pos });
    } else {
      out.push({ t: "build", player: player.id, deployable: unbuilt.id });
    }
    return;
  }

  if (missing !== undefined && isLeader) {
    const spot = spreadAround(state, usable.pos, player, rules.BUILD_REACH_M * 2);
    if (distance(player.pos, spot) > rules.BUILD_REACH_M) {
      out.push({ t: "move", player: player.id, to: spot });
    } else {
      out.push({
        t: "placeDeployable",
        player: player.id,
        fob: usable.id,
        kind: missing,
        pos: { x: player.pos.x, y: player.pos.y },
      });
    }
    return;
  }

  // Nothing left to build. Whether to stay is a real trade, and getting it
  // wrong is expensive in both directions: a habitat nobody is near gets
  // overrun, but three people standing around an unthreatened radio is a
  // quarter of the team missing from the fight. Measured — parking them here
  // unconditionally pushed mean match length from 43 to 66 minutes and left
  // only one match in ten inside the target band.
  //
  // So: guard only when there is something to guard against.
  const threatened = state.players.some(
    (p) =>
      p.team !== team &&
      p.status === "alive" &&
      distance(p.pos, usable.pos) <= FOB_THREAT_RADIUS_M,
  );
  if (threatened) {
    fightTowards(state, player, spreadAround(state, usable.pos, player, FOB_GUARD_RADIUS_M), out);
    return;
  }
  assault(state, player, objective, out);
}

/** How far from the radio the FOB team loiters when defending it. */
const FOB_GUARD_RADIUS_M = 45;
/** An enemy inside this brings the FOB team home. */
const FOB_THREAT_RADIUS_M = 200;
