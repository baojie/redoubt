/**
 * Shared test scaffolding.
 *
 * Tests reach into state directly to set up a situation — that is fine, it is
 * plain data. What they must never do is reach in to *fix up* a result the
 * rules produced.
 */

import {
  Simulation,
  rules,
  type Command,
  type GameEvent,
  type GameState,
  type Player,
  type PlayerId,
  type TeamId,
  type Vec2,
} from "../src/index.js";

export interface HarnessOptions {
  seed?: number;
  laneName?: string;
  playersPerTeam?: number;
  /** Skip the staging phase so flags are live immediately. */
  startActive?: boolean;
}

export interface Harness {
  sim: Simulation;
  state: GameState;
  events: GameEvent[];
  /** Advance n ticks, collecting events. */
  run(ticks: number, commands?: (tick: number) => Command[]): GameEvent[];
  /** Advance one tick with a fixed command list. */
  tick(commands?: Command[]): GameEvent[];
  player(id: PlayerId): Player;
  /** Players of a team, in stable id order. */
  team(team: TeamId): Player[];
  place(id: PlayerId, pos: Vec2): Player;
}

export function harness(options: HarnessOptions = {}): Harness {
  const sim = Simulation.create({
    seed: options.seed ?? 1,
    laneName: options.laneName ?? "Ridge",
    playersPerTeam: options.playersPerTeam ?? rules.SQUAD_MAX_SIZE,
  });

  if (options.startActive !== false) {
    sim.state.tick = rules.STAGING_TICKS;
  }

  const events: GameEvent[] = [];

  const h: Harness = {
    sim,
    get state() {
      return sim.state;
    },
    events,
    tick(commands: Command[] = []) {
      const produced = sim.step(commands);
      events.push(...produced);
      return produced;
    },
    run(ticks: number, commands?: (tick: number) => Command[]) {
      const produced: GameEvent[] = [];
      for (let i = 0; i < ticks; i++) {
        produced.push(...h.tick(commands?.(sim.state.tick) ?? []));
      }
      return produced;
    },
    player(id: PlayerId) {
      const found = sim.state.players.find((p) => p.id === id);
      if (found === undefined) throw new Error(`no player ${id}`);
      return found;
    },
    team(team: TeamId) {
      return sim.state.players.filter((p) => p.team === team);
    },
    place(id: PlayerId, pos: Vec2) {
      const player = h.player(id);
      player.pos = { x: pos.x, y: pos.y };
      player.waypoint = null;
      return player;
    },
  };

  return h;
}

/** Find the first event of a given type, or undefined. */
export function firstEvent<T extends GameEvent["t"]>(
  events: readonly GameEvent[],
  type: T,
): Extract<GameEvent, { t: T }> | undefined {
  return events.find((e) => e.t === type) as Extract<GameEvent, { t: T }> | undefined;
}

export function eventsOfType<T extends GameEvent["t"]>(
  events: readonly GameEvent[],
  type: T,
): Array<Extract<GameEvent, { t: T }>> {
  return events.filter((e) => e.t === type) as Array<Extract<GameEvent, { t: T }>>;
}

/**
 * Fill a FOB's supply pools directly. Tests that are about construction should
 * not have to drive a truck across the map first.
 */
export function stockFob(state: GameState, fobId: number, cp: number, ap: number): void {
  const fob = state.fobs.find((f) => f.id === fobId);
  if (fob === undefined) throw new Error(`no fob ${fobId}`);
  fob.constructionPoints = cp;
  fob.ammoPoints = ap;
}
