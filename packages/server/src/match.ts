/**
 * The match: the one authoritative `GameState` in existence.
 *
 * Everything else on the server is transport. This class owns the simulation,
 * decides when it advances, and decides who is allowed to command whom.
 *
 * Humans take over bot-held slots rather than being added to the roster. The
 * roster is fixed at match start — 12 a side — and a joining player inherits a
 * soldier that a bot was already playing. That keeps team sizes, squad
 * structure and the ticket economy stable whoever happens to be connected, and
 * it means an empty server still plays a real match.
 */

import { createDriverMemory, decide, type DriverMemory } from "@redoubt/bots";
import {
  Simulation,
  World,
  rules,
  type Command,
  type GameEvent,
  type GameState,
  type PlayerId,
  type TeamId,
} from "@redoubt/core";

export interface MatchOptions {
  seed: number;
  playersPerTeam?: number;
  laneName?: string;
}

/** How far behind real time the loop may fall before it stops trying to catch up. */
const MAX_CATCHUP_TICKS = 10;

export class Match {
  private sim: Simulation;
  private world: World;
  private botMemory: DriverMemory;
  private readonly options: MatchOptions;

  /** Slots a human has claimed. Bots skip these. */
  private readonly humans = new Set<PlayerId>();

  /** Commands submitted by humans for the tick currently being assembled. */
  private pending: Command[] = [];

  constructor(options: MatchOptions) {
    this.options = options;
    this.sim = Simulation.create(options);
    this.world = new World(this.sim.state);
    this.botMemory = createDriverMemory(options.seed ^ BOT_SEED_SALT);
  }

  get state(): GameState {
    return this.sim.state;
  }

  get view(): World {
    return this.world;
  }

  get finished(): boolean {
    return this.sim.finished;
  }

  hash(): number {
    return this.sim.hash();
  }

  /**
   * Claim a soldier for a human.
   *
   * Prefers a rifleman: handing a newcomer the squad leader slot would put the
   * team's rally points and FOBs in the hands of someone who has not chosen to
   * take that on. Falls back to any free slot on the emptier team.
   */
  claimSlot(): PlayerId | null {
    const counts: Record<TeamId, number> = { 0: 0, 1: 0 };
    for (const id of this.humans) {
      const player = this.world.player(id);
      if (player !== undefined) counts[player.team]++;
    }
    const preferredTeam: TeamId = counts[0] <= counts[1] ? 0 : 1;

    const candidates = this.state.players.filter((p) => !this.humans.has(p.id));
    const pick =
      candidates.find((p) => p.team === preferredTeam && p.role === "rifleman") ??
      candidates.find((p) => p.team === preferredTeam) ??
      candidates[0];

    if (pick === undefined) return null;
    this.humans.add(pick.id);
    return pick.id;
  }

  /** Hand a slot back to the bots. */
  releaseSlot(playerId: PlayerId): void {
    this.humans.delete(playerId);
  }

  isHuman(playerId: PlayerId): boolean {
    return this.humans.has(playerId);
  }

  get humanCount(): number {
    return this.humans.size;
  }

  /**
   * Queue commands for the next tick.
   *
   * Callers must have already bound each command to the connection's own
   * player id — see `intentToCommand`. Nothing here re-checks ownership,
   * because nothing upstream is allowed to produce a command for anyone else.
   */
  submit(commands: readonly Command[]): void {
    for (const command of commands) this.pending.push(command);
  }

  /** Advance exactly one tick. Returns the events it produced. */
  step(): GameEvent[] {
    const botCommands = decide(this.state, this.world, this.botMemory, {
      skip: this.humans,
    });

    // Human commands go in first. Where both a human and a bot could touch the
    // same shared object in one tick the human's intent is the one that lands,
    // and ordering is fixed so a replay of the same inputs reproduces exactly.
    const commands = this.pending.concat(botCommands);
    this.pending = [];

    return this.sim.step(commands);
  }

  /**
   * Advance as many whole ticks as `elapsedMs` has earned.
   *
   * Fixed timestep with an accumulator, not one tick per timer callback: timers
   * drift, and a simulation whose step size follows wall-clock jitter is not
   * deterministic and cannot be replayed. If the process stalls, the
   * accumulator is capped rather than repaid — a server that has fallen a
   * second behind should skip that second, not spiral trying to catch up.
   */
  private accumulatorMs = 0;

  advance(elapsedMs: number, onTick: (events: GameEvent[]) => void): number {
    const stepMs = 1000 / rules.TICK_RATE_HZ;
    this.accumulatorMs += elapsedMs;

    let ticks = 0;
    while (this.accumulatorMs >= stepMs && ticks < MAX_CATCHUP_TICKS) {
      this.accumulatorMs -= stepMs;
      onTick(this.step());
      ticks++;
    }
    if (this.accumulatorMs > stepMs * MAX_CATCHUP_TICKS) {
      this.accumulatorMs = 0;
    }
    return ticks;
  }

  /**
   * Start a fresh match on a new seed.
   *
   * Every slot is released: entity ids do not survive a restart, so the caller
   * must re-claim a slot for each connected session and re-welcome it. Doing
   * that here would leave sessions holding ids that no longer mean anything.
   */
  restart(seed: number): void {
    this.sim = Simulation.create({ ...this.options, seed });
    this.world = new World(this.sim.state);
    this.botMemory = createDriverMemory(seed ^ BOT_SEED_SALT);
    this.humans.clear();
    this.pending = [];
    this.accumulatorMs = 0;
  }
}

/** Keeps the bots' RNG stream clear of the simulation's. */
const BOT_SEED_SALT = 0x9e3779b9;
