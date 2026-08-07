/**
 * Baseline match driver for M0.
 *
 * Just enough decision-making to make a match actually happen end to end:
 * one squad pushes the objective, one squad runs the logistics loop and digs
 * the FOB. It is intentionally simple and lives here rather than in `core` —
 * `core` never decides anything, it only adjudicates.
 *
 * M1 replaces this with `packages/bots`: layered soldier / squad leader /
 * logistics behaviour plus the balance harness. The interface it has to hit is
 * the one below — state in, commands out, no hidden clocks, no Math.random.
 */

import {
  Rng,
  World,
  distance,
  rallyIsLive,
  rules,
  type Command,
  type ControlPoint,
  type GameState,
  type Player,
  type SpawnSource,
  type TeamId,
  type Vec2,
  type Vehicle,
} from "@redoubt/core";

/** Decisions are re-evaluated at this cadence rather than every tick. */
const DECISION_INTERVAL_TICKS = 10;

/** How far behind the contested flag the driver tries to seat a FOB. */
const FOB_STANDOFF_M = 220;
/** A FOB further than this from the objective is considered stale. */
const FOB_STALE_DISTANCE_M = 600;
/** Close enough to the objective that a squad leader should drop a rally. */
const RALLY_DROP_DISTANCE_M = 250;
/** Spread infantry around the flag instead of stacking them on one pixel. */
const ASSAULT_SPREAD_M = 60;
/** Soldiers below this reload from any source in reach. */
const LOW_AMMO = 20;
/** A casualty this far away is worth walking to; further, they are on their own. */
const CASUALTY_SEEK_RADIUS_M = 80;
/** Slack over the main-base exclusion so a FOB site is never marginal. */
const MAIN_BASE_MARGIN_M = 30;

type DriverPhase = "toTruck" | "loading" | "outbound" | "unloading" | "returning";

interface TruckPlan {
  phase: DriverPhase;
  vehicle: number | null;
}

export interface DriverMemory {
  trucks: Map<number, TruckPlan>;
  /**
   * Continuous actions, re-issued every tick between decisions.
   *
   * Digging, reviving and moving supply are all *rates*: `core` accrues
   * progress per tick from players who are working that tick. A planner that
   * only speaks at 2 Hz would therefore build and revive at a tenth speed. The
   * planner runs at its own cadence and this keeps its hands busy in between.
   */
  sustained: Map<number, Command>;
  rng: Rng;
}

export function createDriverMemory(seed: number): DriverMemory {
  return { trucks: new Map(), sustained: new Map(), rng: new Rng(seed) };
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
// Situational awareness
// ---------------------------------------------------------------------------

/** The first point along the lane this team does not own — where the fight is. */
export function objectiveFor(state: GameState, team: TeamId): ControlPoint | undefined {
  const points = state.controlPoints;
  if (team === 0) {
    for (const point of points) {
      if (point.owner !== 0) return point;
    }
    return points[points.length - 1];
  }
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (point !== undefined && point.owner !== 1) return point;
  }
  return points[0];
}

function nearestEnemy(state: GameState, self: Player): Player | undefined {
  let best: Player | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const other of state.players) {
    if (other.team === self.team || other.status !== "alive") continue;
    const d = distance(other.pos, self.pos);
    if (d < bestDist) {
      bestDist = d;
      best = other;
    }
  }
  return bestDist <= rules.ENGAGEMENT_MAX_RANGE_M ? best : undefined;
}

function liveFobs(state: GameState, team: TeamId) {
  return state.fobs.filter((f) => !f.destroyed && f.team === team);
}

function liveHabitat(state: GameState, team: TeamId) {
  return state.deployables.find(
    (d) => d.team === team && d.type === "habitat" && d.built && !d.destroyed && !d.overrun,
  );
}

/**
 * Where this team should try to seat its next FOB: behind the objective, on
 * the line back to friendly main, but never so far back that it violates the
 * 150 m main-base exclusion — the standoff shortens rather than the placement
 * failing over and over.
 */
function fobSite(state: GameState, team: TeamId, objective: ControlPoint): Vec2 {
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

/** Deterministic per-player scatter so a squad forms a line, not a stack. */
function spreadAround(centre: Vec2, player: Player, radius: number): Vec2 {
  const angle = (player.id * Math.PI * 2) / rules.PLAYERS_PER_TEAM;
  return { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius };
}

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
 * may take five minutes. A soldier will happily sit through the habitat's
 * longer timer rather than take the free spawn at main — which is exactly the
 * pressure that makes the logistics run worth doing.
 *
 * Returns null while the chosen spawn's timer is still running, so the command
 * stream carries no rejections.
 */
function chooseSpawn(
  state: GameState,
  world: World,
  player: Player,
): SpawnSource | null {
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
// Per-player behaviour
// ---------------------------------------------------------------------------

/** Is there anything within reach that could actually top this soldier up? */
function resupplySourceInReach(state: GameState, player: Player): boolean {
  const reach = rules.RESUPPLY_REACH_M;
  for (const d of state.deployables) {
    if (d.team !== player.team || d.type !== "ammoCrate" || !d.built || d.destroyed) continue;
    if (distance(d.pos, player.pos) <= reach) return true;
  }
  for (const f of state.fobs) {
    if (f.team !== player.team || f.destroyed) continue;
    if (distance(f.pos, player.pos) <= reach) return true;
  }
  for (const v of state.vehicles) {
    if (v.team !== player.team || v.destroyed) continue;
    if (distance(v.pos, player.pos) <= reach) return true;
  }
  return (
    distance(state.teams[player.team].mainBase, player.pos) <= rules.MAIN_BASE_RADIUS_M
  );
}

function driveInfantry(
  state: GameState,
  player: Player,
  objective: ControlPoint,
  out: Command[],
): void {
  const canFire =
    state.tick >= player.nextShotAtTick && player.ammo >= rules.AMMO_PER_ENGAGEMENT;
  if (canFire) {
    const enemy = nearestEnemy(state, player);
    if (enemy !== undefined) {
      out.push({ t: "engage", player: player.id, target: enemy.id });
      // Keep closing rather than standing still — an M0 stand-in for cover.
    }
  }

  if (player.ammo <= LOW_AMMO && resupplySourceInReach(state, player)) {
    out.push({ t: "resupply", player: player.id });
  }

  const target = spreadAround(objective.pos, player, ASSAULT_SPREAD_M);
  if (player.waypoint === null || distance(player.waypoint, target) > ASSAULT_SPREAD_M) {
    out.push({ t: "move", player: player.id, to: target });
  }
}

function driveSquadLeader(
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
  driveInfantry(state, player, objective, out);
}

/**
 * The FOB team: the squad leader plus two diggers travel together, plant the
 * radio behind the objective, then build a habitat and an ammo crate as soon
 * as a truck has delivered the construction points to pay for them.
 */
function driveFobTeam(
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
    // No FOB worth having: walk the group to the site and plant one.
    const stand = isLeader
      ? site
      : spreadAround(site, player, rules.FOB_PLACE_SQUADMATE_RADIUS_M / 2);
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
    const spot = spreadAround(usable.pos, player, rules.BUILD_REACH_M * 2);
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

  // Nothing left to build here — join the fight.
  driveInfantry(state, player, objective, out);
}

/**
 * The logistics loop: main base → load → drive to the FOB → unload → repeat.
 * This is the loop PLAN §2.5 calls the heartbeat of the game, and it is the
 * one behaviour a balance test cannot fake.
 */
function driveLogistics(
  state: GameState,
  player: Player,
  memory: DriverMemory,
  objective: ControlPoint,
  out: Command[],
): void {
  const team = player.team;
  const main = state.teams[team].mainBase;
  let plan = memory.trucks.get(player.id);
  if (plan === undefined) {
    plan = { phase: "toTruck", vehicle: null };
    memory.trucks.set(player.id, plan);
  }

  // Reacquire a truck if ours is gone or we were killed out of it.
  if (plan.vehicle !== null) {
    const owned = state.vehicles.find((v) => v.id === plan.vehicle);
    if (owned === undefined || owned.destroyed) {
      plan.vehicle = null;
      plan.phase = "toTruck";
    }
  }
  if (player.vehicle === null && plan.phase !== "toTruck") {
    plan.phase = "toTruck";
  }

  if (plan.phase === "toTruck") {
    const truck = claimTruck(state, player, memory);
    if (truck === undefined) {
      driveInfantry(state, player, objective, out);
      return;
    }
    plan.vehicle = truck.id;
    if (player.vehicle === truck.id) {
      plan.phase = "loading";
      return;
    }
    if (distance(player.pos, truck.pos) > rules.VEHICLE_MOUNT_REACH_M) {
      out.push({ t: "move", player: player.id, to: truck.pos });
    } else {
      out.push({ t: "enterVehicle", player: player.id, vehicle: truck.id });
    }
    return;
  }

  const truck = plan.vehicle === null ? undefined : state.vehicles.find((v) => v.id === plan.vehicle);
  if (truck === undefined) {
    plan.phase = "toTruck";
    return;
  }

  const spec = rules.VEHICLE_SPECS[truck.type];

  if (plan.phase === "loading") {
    if (distance(truck.pos, main) > rules.MAIN_BASE_RADIUS_M) {
      out.push({ t: "driveTo", player: player.id, to: main });
      return;
    }
    // Load for the deficit at the destination, not blindly to capacity.
    // A FOB sitting on a full ammo pool does not need another 1800 points of
    // it, and hauling them there is a truck round trip wasted.
    const target = deliveryTarget(state, team, objective);
    const wantCp = Math.min(
      spec.maxCargoConstructionPoints,
      target === undefined
        ? spec.maxCargoConstructionPoints
        : rules.FOB_MAX_CONSTRUCTION_POINTS - target.constructionPoints,
    );
    const wantAp = Math.min(
      spec.maxCargoAmmoPoints,
      target === undefined
        ? spec.maxCargoAmmoPoints
        : rules.FOB_MAX_AMMO_POINTS - target.ammoPoints,
    );

    if (truck.cargoConstructionPoints >= wantCp && truck.cargoAmmoPoints >= wantAp) {
      plan.phase = "outbound";
      return;
    }
    out.push({
      t: "loadSupply",
      player: player.id,
      constructionPoints: wantCp,
      ammoPoints: wantAp,
    });
    return;
  }

  const destination = deliveryTarget(state, team, objective);

  if (plan.phase === "outbound") {
    if (destination === undefined) {
      // Nowhere to deliver yet. Idle near main rather than driving into the map.
      out.push({ t: "driveTo", player: player.id, to: main });
      return;
    }
    if (distance(truck.pos, destination.pos) > rules.SUPPLY_UNLOAD_REACH_M) {
      out.push({ t: "driveTo", player: player.id, to: destination.pos });
      return;
    }
    out.push({ t: "halt", player: player.id });
    plan.phase = "unloading";
    return;
  }

  if (plan.phase === "unloading") {
    if (destination === undefined) {
      plan.phase = "returning";
      return;
    }
    const cp = Math.min(
      truck.cargoConstructionPoints,
      rules.FOB_MAX_CONSTRUCTION_POINTS - destination.constructionPoints,
    );
    const ap = Math.min(
      truck.cargoAmmoPoints,
      rules.FOB_MAX_AMMO_POINTS - destination.ammoPoints,
    );
    if (cp <= 0 && ap <= 0) {
      plan.phase = "returning";
      return;
    }
    out.push({
      t: "unloadSupply",
      player: player.id,
      fob: destination.id,
      constructionPoints: cp,
      ammoPoints: ap,
    });
    return;
  }

  // returning
  if (distance(truck.pos, main) > rules.MAIN_BASE_RADIUS_M) {
    out.push({ t: "driveTo", player: player.id, to: main });
    return;
  }
  plan.phase = "loading";
}

/** The friendly FOB a truck should be feeding: the one nearest the fight. */
function deliveryTarget(state: GameState, team: TeamId, objective: ControlPoint) {
  let best: ReturnType<typeof liveFobs>[number] | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const fob of liveFobs(state, team)) {
    const d = distance(fob.pos, objective.pos);
    if (d < bestDist) {
      bestDist = d;
      best = fob;
    }
  }
  return best;
}

function claimTruck(
  state: GameState,
  player: Player,
  memory: DriverMemory,
): Vehicle | undefined {
  const taken = new Set<number>();
  for (const [ownerId, plan] of memory.trucks) {
    if (ownerId !== player.id && plan.vehicle !== null) taken.add(plan.vehicle);
  }
  return state.vehicles.find(
    (v) =>
      v.team === player.team &&
      v.type === "logistics" &&
      !v.destroyed &&
      !taken.has(v.id) &&
      (v.occupants.length === 0 || v.occupants[0] === player.id),
  );
}

// ---------------------------------------------------------------------------
// Casualty triage
// ---------------------------------------------------------------------------

interface RescueAssignment {
  /** rescuer id -> casualty id */
  taskOf: Map<number, number>;
  /** casualties someone is on their way to */
  rescued: Set<number>;
}

/**
 * Match each casualty to its nearest free teammate, closest pairs first.
 *
 * This is what makes the downed state mean anything: a body only costs a
 * ticket if nobody comes for it, so being able to hold ground near your
 * casualties is worth real tickets. PLAN §5 M3 calls the downed system a team
 * glue mechanic — it only glues if somebody actually walks over.
 */
function assignRescuers(state: GameState): RescueAssignment {
  const taskOf = new Map<number, number>();
  const rescued = new Set<number>();

  const pairs: Array<{ casualty: number; rescuer: number; dist: number }> = [];
  for (const casualty of state.players) {
    if (casualty.status !== "downed") continue;
    for (const rescuer of state.players) {
      if (rescuer.team !== casualty.team || rescuer.status !== "alive") continue;
      if (rescuer.vehicle !== null) continue;
      const d = distance(rescuer.pos, casualty.pos);
      if (d > CASUALTY_SEEK_RADIUS_M) continue;
      pairs.push({ casualty: casualty.id, rescuer: rescuer.id, dist: d });
    }
  }

  // Deterministic ordering: distance, then ids. Never depends on array order.
  pairs.sort(
    (a, b) => a.dist - b.dist || a.casualty - b.casualty || a.rescuer - b.rescuer,
  );

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
 * Produce this tick's commands for every player on both teams.
 *
 * Roles are assigned by index within the squad, deterministically:
 *   squad 0 — assault, led by its squad leader who drops rallies
 *   squad 1 — index 0-2 dig the FOB, index 3+ run trucks
 */
export interface DecideOptions {
  /**
   * Players the bots must not touch — slots a human has taken over. Their
   * sustained work is dropped too, so a bot's half-finished dig does not keep
   * ticking under a human's control.
   */
  skip?: ReadonlySet<number>;
}

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

  // Work out who is going to pick up whom before anyone acts, so two soldiers
  // do not both walk past the same body.
  const rescuers = assignRescuers(state);

  for (const player of state.players) {
    if (skip?.has(player.id) === true) {
      memory.trucks.delete(player.id);
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

    // Alive: a body we have claimed outranks everything else.
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
    const squadIndex = squad === undefined ? 0 : state.teams[player.team].squads.indexOf(squad.id);
    const indexInSquad = squad === undefined ? 0 : squad.members.indexOf(player.id);

    if (squadIndex === 0) {
      if (player.role === "squadLeader") driveSquadLeader(state, player, objective, out);
      else driveInfantry(state, player, objective, out);
      continue;
    }

    if (indexInSquad <= 2) {
      driveFobTeam(state, player, player.role === "squadLeader", objective, out);
    } else {
      driveLogistics(state, player, memory, objective, out);
    }
  }

  for (const command of out) {
    if (isSustained(command)) memory.sustained.set(command.player, command);
  }

  return out;
}
