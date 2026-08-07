/**
 * The orchestrator: who does what, and when.
 *
 * Roles are assigned by index within the squad, deterministically — no
 * negotiation, no shared blackboard. That is a real limitation and a
 * deliberate one: the point of these bots is to exercise the *rules* at scale
 * with reproducible results, not to be good company. A cleverer assignment
 * that varied run to run would make the balance harness harder to trust.
 *
 * The one dynamic piece is the raiding party, which only exists while there is
 * something confirmed to raid.
 */

import {
  distance,
  rules,
  type Command,
  type GameState,
  type Player,
  type PlayerId,
  type SpawnSource,
  type World,
  rallyIsLive,
} from "@redoubt/core";
import {
  knownEnemyFobs,
  knownEnemyRallies,
  liveHabitat,
  objectiveFor,
  updateSightings,
} from "./awareness.js";
import { forgetPlayer, type DriverMemory } from "./memory.js";
import { runSupply } from "./roles/logistics.js";
import { raid } from "./roles/raider.js";
import { assault } from "./roles/soldier.js";
import { leadSquad, workFob } from "./roles/squadLeader.js";

/** Decisions are re-evaluated at this cadence rather than every tick. */
const DECISION_INTERVAL_TICKS = 10;

/** A casualty this far away is worth walking to; further, they are on their own. */
const CASUALTY_SEEK_RADIUS_M = 80;

/** How many of the assault squad peel off to raid once a target is confirmed. */
const RAIDERS_PER_TEAM = 2;

export interface DecideOptions {
  /**
   * Players the bots must not touch — slots a human has taken over. Their
   * sustained work is dropped too, so a bot's half-finished dig does not keep
   * ticking under a human's control.
   */
  skip?: ReadonlySet<PlayerId>;
}

/** Commands that express continuous work and must be repeated every tick. */
function isSustained(command: Command): boolean {
  return (
    command.t === "build" ||
    command.t === "revive" ||
    command.t === "loadSupply" ||
    command.t === "unloadSupply"
  );
}

/**
 * Drop a sustained command as soon as it has stopped accomplishing anything,
 * rather than hammering the simulation until the next planning tick. Keeps the
 * rejection log meaningful: what is left in it is a real mistake.
 */
function stillWorthDoing(world: World, player: Player, command: Command): boolean {
  switch (command.t) {
    case "build": {
      const deployable = world.deployable(command.deployable);
      return deployable !== undefined && !deployable.built && !deployable.destroyed;
    }
    case "revive": {
      const target = world.player(command.target);
      return target !== undefined && target.status === "downed";
    }
    case "loadSupply": {
      if (player.vehicle === null) return false;
      const vehicle = world.vehicle(player.vehicle);
      if (vehicle === undefined) return false;
      return (
        vehicle.cargoConstructionPoints < command.constructionPoints ||
        vehicle.cargoAmmoPoints < command.ammoPoints
      );
    }
    case "unloadSupply": {
      if (player.vehicle === null) return false;
      const vehicle = world.vehicle(player.vehicle);
      const fob = world.fob(command.fob);
      if (vehicle === undefined || fob === undefined || fob.destroyed) return false;
      const room =
        rules.FOB_MAX_CONSTRUCTION_POINTS - fob.constructionPoints > 0 ||
        rules.FOB_MAX_AMMO_POINTS - fob.ammoPoints > 0;
      return room && (vehicle.cargoConstructionPoints > 0 || vehicle.cargoAmmoPoints > 0);
    }
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

function spawnDelayTicks(source: SpawnSource): number {
  switch (source.kind) {
    case "main":
      return rules.MAIN_BASE_SPAWN_DELAY_TICKS;
    case "rally":
      return rules.RALLY_SPAWN_DELAY_TICKS;
    case "habitat":
      return rules.HABITAT_SPAWN_DELAY_TICKS;
  }
}

/**
 * Pick the best spawn available and *wait* for it.
 *
 * The ranking is what makes the spawn economy visible: a rally puts you back
 * on the objective in 10 seconds, a habitat in 45, main base means a walk that
 * may take five minutes. A soldier will sit through the habitat's longer timer
 * rather than take the free spawn at main — which is exactly the pressure that
 * makes the logistics run worth doing.
 */
function chooseSpawn(state: GameState, world: World, player: Player): SpawnSource | null {
  const squad = state.squads.find((s) => s.id === player.squad);

  if (squad?.rally != null) {
    const rally = state.rallyPoints.find((r) => r.id === squad.rally);
    if (rally !== undefined && rallyIsLive(world, rally)) {
      const source: SpawnSource = { kind: "rally", rally: rally.id };
      return readyFor(state, player, source) ? source : null;
    }
  }

  const habitat = liveHabitat(state, player.team);
  if (habitat !== undefined) {
    const source: SpawnSource = { kind: "habitat", deployable: habitat.id };
    return readyFor(state, player, source) ? source : null;
  }

  const source: SpawnSource = { kind: "main" };
  return readyFor(state, player, source) ? source : null;
}

function readyFor(state: GameState, player: Player, source: SpawnSource): boolean {
  return state.tick >= player.deployingSinceTick + spawnDelayTicks(source);
}

// ---------------------------------------------------------------------------
// Casualty triage
// ---------------------------------------------------------------------------

interface RescueAssignment {
  taskOf: Map<PlayerId, PlayerId>;
  rescued: Set<PlayerId>;
}

/**
 * Match each casualty to its nearest free teammate, closest pairs first.
 *
 * This is what makes the downed state mean anything: a body only costs a
 * ticket if nobody comes for it, so holding ground near your casualties is
 * worth real tickets.
 */
function assignRescuers(
  state: GameState,
  exempt: ReadonlySet<PlayerId>,
): RescueAssignment {
  const taskOf = new Map<PlayerId, PlayerId>();
  const rescued = new Set<PlayerId>();

  const pairs: Array<{ casualty: number; rescuer: number; dist: number }> = [];
  for (const casualty of state.players) {
    if (casualty.status !== "downed") continue;
    for (const rescuer of state.players) {
      if (rescuer.team !== casualty.team || rescuer.status !== "alive") continue;
      if (rescuer.vehicle !== null) continue;
      // Raiders are on a job that only works if they keep walking. A party
      // that stops for every body on the way never reaches the radio.
      if (exempt.has(rescuer.id)) continue;
      const d = distance(rescuer.pos, casualty.pos);
      if (d > CASUALTY_SEEK_RADIUS_M) continue;
      pairs.push({ casualty: casualty.id, rescuer: rescuer.id, dist: d });
    }
  }

  // Deterministic ordering: distance, then ids. Never depends on array order.
  pairs.sort((a, b) => a.dist - b.dist || a.casualty - b.casualty || a.rescuer - b.rescuer);

  for (const pair of pairs) {
    if (rescued.has(pair.casualty)) continue;
    if (taskOf.has(pair.rescuer)) continue;
    taskOf.set(pair.rescuer, pair.casualty);
    rescued.add(pair.casualty);
  }

  return { taskOf, rescued };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Produce this tick's commands for every bot-controlled player on both teams.
 *
 * Squad 0 assaults the objective; two of them peel off to raid once their team
 * has confirmed something worth raiding. Squad 1 splits into a FOB team and
 * truck drivers.
 */
export function decide(
  state: GameState,
  world: World,
  memory: DriverMemory,
  options: DecideOptions = {},
): Command[] {
  const out: Command[] = [];
  if (state.phase === "finished") return out;
  const skip = options.skip;

  if (state.tick % DECISION_INTERVAL_TICKS !== 0) {
    // Between decisions, keep working at whatever we were last told to do.
    for (const [playerId, command] of memory.sustained) {
      if (skip?.has(playerId) === true) {
        memory.sustained.delete(playerId);
        continue;
      }
      const player = world.player(playerId);
      if (player === undefined || player.status !== "alive") continue;
      if (!stillWorthDoing(world, player, command)) {
        memory.sustained.delete(playerId);
        continue;
      }
      out.push(command);
    }
    return out;
  }
  memory.sustained.clear();

  updateSightings(state, memory);
  const raidingTeams = teamsWithTargets(state, memory);
  const raiders = raidingParty(state, raidingTeams);
  const rescuers = assignRescuers(state, raiders);

  for (const player of state.players) {
    if (skip?.has(player.id) === true) {
      forgetPlayer(memory, player.id);
      continue;
    }

    if (player.status === "deploying") {
      const source = chooseSpawn(state, world, player);
      if (source !== null) out.push({ t: "spawn", player: player.id, source });
      continue;
    }

    if (player.status === "downed") {
      // Nobody is coming: bleeding out for 90 seconds helps no one, and the
      // ticket is spent either way.
      if (!rescuers.rescued.has(player.id)) out.push({ t: "giveUp", player: player.id });
      continue;
    }

    // A body we have claimed outranks everything else.
    const claimedId = rescuers.taskOf.get(player.id);
    if (claimedId !== undefined) {
      const casualty = world.player(claimedId);
      if (casualty !== undefined && casualty.status === "downed") {
        if (distance(casualty.pos, player.pos) <= rules.REVIVE_REACH_M) {
          out.push({ t: "revive", player: player.id, target: casualty.id });
        } else {
          out.push({ t: "move", player: player.id, to: casualty.pos });
        }
        continue;
      }
    }

    const objective = objectiveFor(state, player.team);
    if (objective === undefined) continue;

    const squad = state.squads.find((s) => s.id === player.squad);
    const squadIndex =
      squad === undefined ? 0 : state.teams[player.team].squads.indexOf(squad.id);
    const indexInSquad = squad === undefined ? 0 : squad.members.indexOf(player.id);

    if (squadIndex === 0) {
      if (raiders.has(player.id)) raid(state, player, memory, out);
      else if (player.role === "squadLeader") leadSquad(state, player, objective, out);
      else assault(state, player, objective, out);
      continue;
    }

    if (indexInSquad <= 2) {
      workFob(state, player, player.role === "squadLeader", objective, out);
    } else {
      runSupply(state, player, memory, objective, out);
    }
  }

  for (const command of out) {
    if (isSustained(command)) memory.sustained.set(command.player, command);
  }

  return out;
}

/**
 * Who is raiding right now.
 *
 * The last two of each assault squad, but only while their team has something
 * confirmed to raid — otherwise those two are worth more on the objective.
 * Computed before anything else acts, because being a raider changes what
 * other duties a bot is exempt from.
 */
function raidingParty(state: GameState, raidingTeams: ReadonlySet<number>): Set<PlayerId> {
  const raiders = new Set<PlayerId>();
  for (const team of [0, 1] as const) {
    if (!raidingTeams.has(team)) continue;
    const assaultSquadId = state.teams[team].squads[0];
    const squad = state.squads.find((s) => s.id === assaultSquadId);
    if (squad === undefined) continue;
    for (const id of squad.members.slice(-RAIDERS_PER_TEAM)) raiders.add(id);
  }
  return raiders;
}

/** Teams that currently know of something worth raiding. */
function teamsWithTargets(state: GameState, memory: DriverMemory): Set<number> {
  const teams = new Set<number>();
  for (const team of [0, 1] as const) {
    const origin = state.teams[team].mainBase;
    if (
      knownEnemyFobs(state, memory, team, origin).length > 0 ||
      knownEnemyRallies(state, memory, team, origin).length > 0
    ) {
      teams.add(team);
    }
  }
  return teams;
}
