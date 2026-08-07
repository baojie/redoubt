/**
 * FOB radios, deployables, construction, and overrun.
 *
 * This is the expensive-but-durable half of the spawn economy. The cheap-but-
 * fragile half lives in rally.ts, and the tension between them is the engine
 * of the whole tactical layer — PLAN §2.3/§2.4.
 */

import { distance, withinRange, type Vec2 } from "../math.js";
import {
  BUILD_REACH_M,
  DEPLOYABLE_SPECS,
  ENEMY_TEARDOWN_DAMAGE_PER_SECOND,
  ENEMY_TEARDOWN_RADIUS_M,
  FOB_BUILD_RADIUS_M,
  FOB_MAX_AMMO_POINTS,
  FOB_MAX_CONSTRUCTION_POINTS,
  FOB_MIN_DISTANCE_FROM_FRIENDLY_FOB_M,
  FOB_MIN_DISTANCE_FROM_MAIN_BASE_M,
  FOB_PLACE_MIN_SQUADMATES,
  FOB_PLACE_SQUADMATE_RADIUS_M,
  FOB_RADIO_MAX_HEALTH,
  OVERRUN_CLOSE_ENEMY_COUNT,
  OVERRUN_CLOSE_RADIUS_M,
  OVERRUN_EVAL_INTERVAL_TICKS,
  OVERRUN_FAR_ENEMY_COUNT,
  OVERRUN_FAR_RADIUS_M,
  OVERRUN_RADIO_HEALTH_FRACTION,
  TICKET_COST_FOB_RADIO_DESTROYED,
  TICK_RATE_HZ,
  buildSpeedMultiplier,
  type DeployableType,
} from "../rules.js";
import { TEAM_IDS } from "../state.js";
import type { Deployable, Fob, FobId, Player, TeamId } from "../types.js";
import { enemyOf } from "../types.js";
import type { World } from "../world.js";
import { adjustTickets } from "./tickets.js";

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export type PlacementRejection =
  | "notSquadLeader"
  | "notAlive"
  | "notEnoughSquadmates"
  | "tooCloseToFriendlyFob"
  | "tooCloseToMainBase";

/**
 * Pure predicate form of the placement rules, so property tests can assert the
 * spacing invariants without driving a whole match.
 */
export function validateFobPlacement(world: World, player: Player): PlacementRejection | null {
  if (player.status !== "alive") return "notAlive";
  if (player.role !== "squadLeader") return "notSquadLeader";

  let squadmates = 0;
  for (const other of world.state.players) {
    if (other.id === player.id) continue;
    if (other.squad !== player.squad) continue;
    if (other.status !== "alive") continue;
    if (withinRange(other.pos, player.pos, FOB_PLACE_SQUADMATE_RADIUS_M)) squadmates++;
  }
  if (squadmates < FOB_PLACE_MIN_SQUADMATES) return "notEnoughSquadmates";

  for (const fob of world.state.fobs) {
    if (fob.destroyed) continue;
    if (fob.team !== player.team) continue;
    if (distance(fob.pos, player.pos) < FOB_MIN_DISTANCE_FROM_FRIENDLY_FOB_M) {
      return "tooCloseToFriendlyFob";
    }
  }

  for (const team of TEAM_IDS) {
    const base = world.state.teams[team].mainBase;
    if (distance(base, player.pos) < FOB_MIN_DISTANCE_FROM_MAIN_BASE_M) {
      return "tooCloseToMainBase";
    }
  }

  return null;
}

export function placeFob(world: World, player: Player): Fob | null {
  const rejection = validateFobPlacement(world, player);
  if (rejection !== null) {
    world.reject(player.id, "placeFob", rejection);
    return null;
  }

  const fob: Fob = {
    id: world.newId(),
    team: player.team,
    pos: { x: player.pos.x, y: player.pos.y },
    radioHealth: FOB_RADIO_MAX_HEALTH,
    constructionPoints: 0,
    ammoPoints: 0,
    deployables: [],
    destroyed: false,
    createdAtTick: world.state.tick,
  };
  world.state.fobs.push(fob);
  world.emit({
    t: "fobPlaced",
    tick: world.state.tick,
    fob: fob.id,
    team: fob.team,
    by: player.id,
  });
  return fob;
}

export type DeployableRejection =
  | "noSuchFob"
  | "wrongTeam"
  | "fobDestroyed"
  | "outsideBuildRadius"
  | "outOfReach"
  | "typeLimitReached"
  | "notAlive";

export function validateDeployablePlacement(
  world: World,
  player: Player,
  fobId: FobId,
  kind: DeployableType,
  pos: Vec2,
): DeployableRejection | null {
  if (player.status !== "alive") return "notAlive";
  const fob = world.fob(fobId);
  if (fob === undefined) return "noSuchFob";
  if (fob.destroyed) return "fobDestroyed";
  if (fob.team !== player.team) return "wrongTeam";
  if (!withinRange(pos, fob.pos, FOB_BUILD_RADIUS_M)) return "outsideBuildRadius";
  if (!withinRange(player.pos, pos, BUILD_REACH_M)) return "outOfReach";

  const spec = DEPLOYABLE_SPECS[kind];
  let existing = 0;
  for (const id of fob.deployables) {
    const d = world.deployable(id);
    if (d !== undefined && !d.destroyed && d.type === kind) existing++;
  }
  if (existing >= spec.maxPerFob) return "typeLimitReached";

  return null;
}

export function placeDeployable(
  world: World,
  player: Player,
  fobId: FobId,
  kind: DeployableType,
  pos: Vec2,
): Deployable | null {
  const rejection = validateDeployablePlacement(world, player, fobId, kind, pos);
  if (rejection !== null) {
    world.reject(player.id, "placeDeployable", rejection);
    return null;
  }
  const fob = world.fob(fobId);
  if (fob === undefined) return null;

  const spec = DEPLOYABLE_SPECS[kind];
  const deployable: Deployable = {
    id: world.newId(),
    fob: fob.id,
    team: player.team,
    type: kind,
    pos: { x: pos.x, y: pos.y },
    buildProgressWork: 0,
    buildWorkRequired: spec.buildWorkSeconds,
    built: false,
    health: spec.maxHealth,
    overrun: false,
    destroyed: false,
    constructionPointsSpent: 0,
    ammoPointsSpent: 0,
    placedAtTick: world.state.tick,
    builtAtTick: null,
  };
  world.state.deployables.push(deployable);
  fob.deployables.push(deployable.id);
  world.emit({
    t: "deployablePlaced",
    tick: world.state.tick,
    deployable: deployable.id,
    fob: fob.id,
    team: deployable.team,
    kind,
  });
  return deployable;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Apply one tick of construction work.
 *
 * `builders` maps deployable id to how many players are digging on it this
 * tick. The super-linear speed curve in rules.ts is what makes a habitat take
 * 40 seconds alone and 4 seconds with five — the rule that manufactures the
 * "everybody build, then fight" moment.
 *
 * Supply is spent continuously as progress accrues, so a FOB that runs dry
 * mid-build stalls rather than silently completing for free.
 */
export function applyConstruction(world: World, builders: Map<number, number>): void {
  if (builders.size === 0) return;

  // Iterate the deployable array rather than the map so ordering is
  // deterministic regardless of command arrival order.
  for (const deployable of world.state.deployables) {
    if (deployable.built || deployable.destroyed) continue;
    const builderCount = builders.get(deployable.id);
    if (builderCount === undefined || builderCount <= 0) continue;

    const fob = world.fob(deployable.fob);
    if (fob === undefined || fob.destroyed) continue;

    const spec = DEPLOYABLE_SPECS[deployable.type];
    const remainingWork = deployable.buildWorkRequired - deployable.buildProgressWork;
    if (remainingWork <= 0) continue;

    let work = Math.min(
      remainingWork,
      buildSpeedMultiplier(builderCount) / TICK_RATE_HZ,
    );

    // Scale the work down to whatever the FOB can actually pay for.
    const fraction = work / deployable.buildWorkRequired;
    let cpWanted = spec.constructionCost * fraction;
    let apWanted = spec.ammoCost * fraction;

    let affordable = 1;
    if (cpWanted > 0) affordable = Math.min(affordable, fob.constructionPoints / cpWanted);
    if (apWanted > 0) affordable = Math.min(affordable, fob.ammoPoints / apWanted);
    if (affordable <= 0) continue;
    if (affordable < 1) {
      work *= affordable;
      cpWanted *= affordable;
      apWanted *= affordable;
    }

    fob.constructionPoints = Math.max(0, fob.constructionPoints - cpWanted);
    fob.ammoPoints = Math.max(0, fob.ammoPoints - apWanted);
    deployable.constructionPointsSpent += cpWanted;
    deployable.ammoPointsSpent += apWanted;
    deployable.buildProgressWork += work;

    if (deployable.buildProgressWork >= deployable.buildWorkRequired) {
      deployable.buildProgressWork = deployable.buildWorkRequired;
      deployable.built = true;
      deployable.builtAtTick = world.state.tick;
      world.emit({
        t: "deployableBuilt",
        tick: world.state.tick,
        deployable: deployable.id,
        team: deployable.team,
        kind: deployable.type,
        builders: builderCount,
        buildTicks: world.state.tick - deployable.placedAtTick,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Overrun
// ---------------------------------------------------------------------------

/**
 * A habitat goes red — no spawning — when enemies are close enough in enough
 * numbers, or when its radio has been chewed below half health. PLAN §2.4.
 */
export function updateOverrun(world: World): void {
  const state = world.state;
  if (state.tick % OVERRUN_EVAL_INTERVAL_TICKS !== 0) return;

  for (const deployable of state.deployables) {
    if (deployable.destroyed) continue;
    if (deployable.type !== "habitat") continue;

    const fob = world.fob(deployable.fob);
    const radioHurt =
      fob === undefined ||
      fob.destroyed ||
      fob.radioHealth < FOB_RADIO_MAX_HEALTH * OVERRUN_RADIO_HEALTH_FRACTION;

    let close = 0;
    let far = 0;
    const enemy = enemyOf(deployable.team);
    for (const player of state.players) {
      if (player.team !== enemy) continue;
      if (player.status !== "alive") continue;
      if (withinRange(player.pos, deployable.pos, OVERRUN_CLOSE_RADIUS_M)) close++;
      if (withinRange(player.pos, deployable.pos, OVERRUN_FAR_RADIUS_M)) far++;
    }

    const nowOverrun =
      radioHurt || close >= OVERRUN_CLOSE_ENEMY_COUNT || far >= OVERRUN_FAR_ENEMY_COUNT;
    if (nowOverrun === deployable.overrun) continue;

    deployable.overrun = nowOverrun;
    world.emit(
      nowOverrun
        ? {
            t: "habitatOverrunStarted",
            tick: state.tick,
            deployable: deployable.id,
            team: deployable.team,
          }
        : {
            t: "habitatOverrunEnded",
            tick: state.tick,
            deployable: deployable.id,
            team: deployable.team,
          },
    );
  }
}

/** Can this habitat currently receive spawns? */
export function habitatIsLive(world: World, deployable: Deployable): boolean {
  if (deployable.destroyed || !deployable.built) return false;
  if (deployable.type !== "habitat") return false;
  if (deployable.overrun) return false;
  const fob = world.fob(deployable.fob);
  return fob !== undefined && !fob.destroyed;
}

// ---------------------------------------------------------------------------
// Damage and destruction
// ---------------------------------------------------------------------------

/**
 * Enemies standing on a radio or a deployable tear it down. Note that nothing
 * here is triggered by gunfire: emplacements have to be physically reached.
 */
export function updateTeardown(world: World): void {
  const state = world.state;
  if (state.tick % OVERRUN_EVAL_INTERVAL_TICKS !== 0) return;
  const damage =
    (ENEMY_TEARDOWN_DAMAGE_PER_SECOND * OVERRUN_EVAL_INTERVAL_TICKS) / TICK_RATE_HZ;

  for (const fob of state.fobs) {
    if (fob.destroyed) continue;
    const enemy = enemyOf(fob.team);
    let attackers = 0;
    for (const player of state.players) {
      if (player.team !== enemy || player.status !== "alive") continue;
      if (withinRange(player.pos, fob.pos, ENEMY_TEARDOWN_RADIUS_M)) attackers++;
    }
    if (attackers === 0) continue;
    fob.radioHealth -= damage * attackers;
    if (fob.radioHealth <= 0) {
      destroyFob(world, fob, false);
    }
  }

  for (const deployable of state.deployables) {
    if (deployable.destroyed) continue;
    const fob = world.fob(deployable.fob);
    if (fob === undefined || fob.destroyed) continue;
    const enemy = enemyOf(deployable.team);
    let attackers = 0;
    for (const player of state.players) {
      if (player.team !== enemy || player.status !== "alive") continue;
      if (withinRange(player.pos, deployable.pos, ENEMY_TEARDOWN_RADIUS_M)) attackers++;
    }
    if (attackers === 0) continue;
    deployable.health -= damage * attackers;
    if (deployable.health <= 0) {
      destroyDeployable(world, deployable, false);
    }
  }
}

export function destroyDeployable(
  world: World,
  deployable: Deployable,
  cascaded: boolean,
): void {
  if (deployable.destroyed) return;
  deployable.destroyed = true;
  deployable.health = 0;
  deployable.built = false;
  deployable.overrun = false;
  world.emit({
    t: "deployableDestroyed",
    tick: world.state.tick,
    deployable: deployable.id,
    team: deployable.team,
    kind: deployable.type,
    cascaded,
  });
}

/**
 * Losing a radio to the enemy costs 20 tickets and instantly vaporises every
 * tech structure inside its build radius. Pulling your own radio down costs
 * nothing — the correct play once a position is compromised. PLAN §2.4.
 */
export function destroyFob(world: World, fob: Fob, selfDismantled: boolean): void {
  if (fob.destroyed) return;
  fob.destroyed = true;
  fob.radioHealth = 0;
  const lifetimeTicks = world.state.tick - fob.createdAtTick;

  for (const id of fob.deployables) {
    const deployable = world.deployable(id);
    if (deployable === undefined || deployable.destroyed) continue;
    // Earthworks survive their radio; anything powered by it does not.
    if (!DEPLOYABLE_SPECS[deployable.type].isTech) continue;
    destroyDeployable(world, deployable, true);
  }

  world.emit({
    t: "fobDestroyed",
    tick: world.state.tick,
    fob: fob.id,
    team: fob.team,
    selfDismantled,
    lifetimeTicks,
  });

  if (!selfDismantled) {
    adjustTickets(world, fob.team, -TICKET_COST_FOB_RADIO_DESTROYED, "fobRadioDestroyed");
  }
}

// ---------------------------------------------------------------------------
// Supply
// ---------------------------------------------------------------------------

/** Add supply to a FOB, honouring the pool ceilings. Returns what was accepted. */
export function depositSupply(
  fob: Fob,
  constructionPoints: number,
  ammoPoints: number,
): { constructionPoints: number; ammoPoints: number } {
  const cpRoom = FOB_MAX_CONSTRUCTION_POINTS - fob.constructionPoints;
  const apRoom = FOB_MAX_AMMO_POINTS - fob.ammoPoints;
  const cp = Math.max(0, Math.min(constructionPoints, cpRoom));
  const ap = Math.max(0, Math.min(ammoPoints, apRoom));
  fob.constructionPoints += cp;
  fob.ammoPoints += ap;
  return { constructionPoints: cp, ammoPoints: ap };
}

/** Nearest live friendly FOB to a position, or undefined. */
export function nearestFriendlyFob(
  world: World,
  team: TeamId,
  pos: Vec2,
): Fob | undefined {
  let best: Fob | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const fob of world.state.fobs) {
    if (fob.destroyed || fob.team !== team) continue;
    const d = distance(fob.pos, pos);
    if (d < bestDist) {
      bestDist = d;
      best = fob;
    }
  }
  return best;
}
