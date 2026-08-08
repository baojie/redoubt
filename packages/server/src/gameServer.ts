/**
 * Transport, wired to the match.
 *
 * Deliberately separate from `main.ts` so the whole server can be driven by a
 * test without opening a socket — the interesting behaviour here is the tick
 * loop and the snapshot cadence, and neither should need a network to verify.
 */

import { WebSocketServer, type WebSocket } from "ws";
import { rules, type GameEvent } from "@redoubt/core";
import {
  MAX_CLIENT_FRAME_BYTES,
  PROTOCOL_VERSION,
  decodeClientMessage,
  encodeServerMessage,
  measure,
  type ServerMessage,
} from "@redoubt/protocol";
import { Match } from "./match.js";
import { CULL_RADIUS_M } from "./snapshot.js";
import { Session } from "./session.js";

export interface GameServerOptions {
  port: number;
  seed: number;
  playersPerTeam?: number;
  laneName?: string;
  /** Seconds to wait after a match ends before starting the next one. */
  intermissionSeconds?: number;
  /**
   * Playtest: human-held soldiers take no damage. Off unless the process was
   * started with `--invulnerable`, and deliberately not reachable from the
   * wire — a client cannot turn this on for itself.
   */
  invulnerableHumans?: boolean;
  infiniteAmmoHumans?: boolean;
}

/** Events worth pushing to clients. The rest are telemetry and stay server-side. */
const BROADCAST_EVENTS: ReadonlySet<GameEvent["t"]> = new Set<GameEvent["t"]>([
  "matchStarted",
  "matchEnded",
  "controlPointCaptured",
  "controlPointNeutralised",
  "doubleNeutralStarted",
  "doubleNeutralEnded",
  "mercyBleedStarted",
  "fobPlaced",
  "fobDestroyed",
  "deployableBuilt",
  "deployableDestroyed",
  "rallyPlaced",
  "rallyDestroyed",
  "playerDowned",
  "playerRevived",
  "playerDied",
  "supplyUnloaded",
  "vehicleDestroyed",
]);

/**
 * Shots are handled separately from the broadcast list above.
 *
 * At 20 Hz with a full server they are by far the highest-volume event, and
 * they are also the most local: a tracer a kilometre away is not information,
 * it is bandwidth. Each one is sent only to clients near enough to have seen
 * it, which is why it cannot ride the same all-or-nothing path as a flag
 * capture.
 */
/** How far a grenade blast is worth telling a client about. */
const BLAST_VISIBILITY_M = 400;

const TRACER_VISIBILITY_M = CULL_RADIUS_M;

const DEFAULT_INTERMISSION_S = 15;

/**
 * Snapshots go out at half the tick rate.
 *
 * The simulation still advances at 20 Hz — that is the authority and it does
 * not change. But clients render 100 ms in the past and interpolate (PLAN §4),
 * so a 10 Hz stream gives them exactly the two frames they need while halving
 * the bandwidth. Sending state faster than the client can display it is pure
 * cost.
 */
const SNAPSHOT_INTERVAL_TICKS = 2;
export const SNAPSHOT_RATE_HZ = rules.TICK_RATE_HZ / SNAPSHOT_INTERVAL_TICKS;
/** How often to print a line of health to the console. */
const STATS_INTERVAL_TICKS = rules.secondsToTicks(30);

export class GameServer {
  readonly match: Match;
  private readonly options: GameServerOptions;
  private readonly sessions = new Map<WebSocket, Session>();
  private wss: WebSocketServer | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt = 0;
  private nextSessionId = 1;
  /**
   * Ticks left in the intermission, counted down by the loop rather than read
   * off the simulation clock.
   *
   * The simulation *stops* when a match finishes — `step` returns immediately
   * and `state.tick` freezes. An intermission scheduled as "restart at tick
   * N + 300" therefore never arrives, and the server sits on a finished match
   * forever. It did exactly that: found after a match ended and the next one
   * never started.
   */
  private intermissionLeft: number | null = null;

  /**
   * Ticks the *loop* has run, which is not the same as `state.tick`.
   *
   * The snapshot cadence is a transport concern and has to keep its own clock.
   * Keying it off the simulation clock breaks the moment that clock stops: a
   * match frozen on an even tick re-broadcasts every tick, and one frozen on an
   * odd tick broadcasts nothing at all, so a client that connects during the
   * intermission is told nothing and sits looking at an empty world.
   */
  private loopTicks = 0;
  private seed: number;

  /** Rolling bandwidth accounting, reset each stats window. */
  private windowBytes = 0;
  private windowTicks = 0;

  constructor(options: GameServerOptions) {
    this.options = options;
    this.seed = options.seed;
    this.match = new Match({
      seed: options.seed,
      playersPerTeam: options.playersPerTeam,
      laneName: options.laneName,
      invulnerableHumans: options.invulnerableHumans,
      infiniteAmmoHumans: options.infiniteAmmoHumans,
    });
  }

  listen(): void {
    const wss = new WebSocketServer({
      port: this.options.port,
      maxPayload: MAX_CLIENT_FRAME_BYTES,
    });
    this.wss = wss;

    wss.on("connection", (socket) => this.onConnection(socket));
    wss.on("error", (error) => {
      process.stderr.write(`websocket server error: ${String(error)}\n`);
    });

    this.lastTickAt = Date.now();
    // Fire faster than the tick rate and let the accumulator decide how many
    // ticks are actually due. Timers are late more often than early, and a
    // simulation whose step size follows timer jitter is not reproducible.
    this.timer = setInterval(() => this.pump(), 1000 / (rules.TICK_RATE_HZ * 2));

    process.stdout.write(
      `redoubt server listening on :${this.options.port}  ` +
        `seed=${this.options.seed} lane=${this.match.state.lane.name} ` +
        `tick=${rules.TICK_RATE_HZ}Hz` +
        // Said out loud on every start. A server where the humans cannot be
        // killed is not a server whose results mean anything, and finding that
        // out from the gameplay is far too late.
        `${this.options.invulnerableHumans === true ? "  PLAYTEST: humans invulnerable" : ""}` +
        `${this.options.infiniteAmmoHumans === true ? "  PLAYTEST: humans never run dry" : ""}\n`,
    );
  }

  close(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const socket of this.sessions.keys()) socket.close();
    this.sessions.clear();
    this.wss?.close();
    this.wss = null;
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  private onConnection(socket: WebSocket): void {
    const session = new Session(this.nextSessionId++);
    this.sessions.set(socket, session);

    socket.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString();
      session.bytesReceived += text.length;
      this.onMessage(socket, session, text);
    });
    socket.on("close", () => this.onClose(socket, session));
    socket.on("error", () => this.onClose(socket, session));
  }

  private onMessage(socket: WebSocket, session: Session, raw: string): void {
    const message = decodeClientMessage(raw);
    if (message === null) {
      // Unparseable frames are a protocol violation, not a gameplay mistake.
      this.send(socket, session, { t: "rejected", reason: "malformed" });
      socket.close();
      return;
    }

    switch (message.t) {
      case "join": {
        if (session.joined) return;
        if (message.protocol !== PROTOCOL_VERSION) {
          this.send(socket, session, {
            t: "rejected",
            reason: `protocol ${String(message.protocol)} != ${PROTOCOL_VERSION}`,
          });
          socket.close();
          return;
        }
        const slot = this.match.claimSlot();
        if (slot === null) {
          this.send(socket, session, { t: "rejected", reason: "server full" });
          socket.close();
          return;
        }
        session.joined = true;
        session.playerId = slot;
        session.name = typeof message.name === "string" ? message.name.slice(0, 32) : "";
        this.welcome(socket, session);
        return;
      }

      case "input": {
        if (!session.joined) return;
        session.enqueue(message.seq, message.intents);
        return;
      }

      case "ping": {
        this.send(socket, session, {
          t: "pong",
          sent: message.sent,
          serverTick: this.match.state.tick,
        });
        return;
      }
    }
  }

  private onClose(socket: WebSocket, session: Session): void {
    if (session.playerId !== null) this.match.releaseSlot(session.playerId);
    this.sessions.delete(socket);
  }

  private welcome(socket: WebSocket, session: Session): void {
    if (session.playerId === null) return;
    const player = this.match.view.player(session.playerId);
    if (player === undefined) return;

    session.view.reset();
    this.send(socket, session, {
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      playerId: player.id,
      team: player.team,
      squad: player.squad,
      tickRateHz: rules.TICK_RATE_HZ,
      terrainSeed: this.match.state.terrainSeed,
      snapshotRateHz: SNAPSHOT_RATE_HZ,
      tick: this.match.state.tick,
      map: this.match.state.map,
      lane: this.match.state.lane,
    });
  }

  // -------------------------------------------------------------------------
  // Tick loop
  // -------------------------------------------------------------------------

  private pump(): void {
    const now = Date.now();
    const elapsed = now - this.lastTickAt;
    this.lastTickAt = now;

    this.match.advance(elapsed, (events) => this.onTick(events));
  }

  /** Exposed for tests: run the loop by hand, with no timers involved. */
  advanceForTest(elapsedMs: number): void {
    this.match.advance(elapsedMs, (events) => this.onTick(events));
  }

  private onTick(events: GameEvent[]): void {
    // Drain one input frame per session per tick, so a client sending faster
    // than the tick rate gains no advantage over one sending slower.
    for (const session of this.sessions.values()) {
      if (!session.joined) continue;
      this.match.submit(session.drain());
    }

    if (this.loopTicks % SNAPSHOT_INTERVAL_TICKS === 0) this.broadcastSnapshots();
    this.loopTicks++;
    this.broadcastEvents(events);
    this.maybeRestart(events);
    this.reportStats();
  }

  private broadcastSnapshots(): void {
    const state = this.match.state;
    const world = this.match.view;

    for (const [socket, session] of this.sessions) {
      if (!session.joined || session.playerId === null) continue;
      const player = world.player(session.playerId) ?? null;
      const snapshot = session.view.build(state, world, player, session.ackSeq);
      this.send(socket, session, { t: "snapshot", snapshot });
    }
  }

  private broadcastEvents(events: readonly GameEvent[]): void {
    const worth = events.filter((e) => BROADCAST_EVENTS.has(e.t));
    // Shots and blasts are both positional: they are culled per client below
    // rather than whitelisted, because whether you should hear one depends on
    // where you are standing. `grenadeExploded` was missing from both lists
    // entirely, so the client could never draw a blast — the rule fired, the
    // event existed, and nothing downstream ever heard it.
    const positional = events.filter(
      (e) => e.t === "shotFired" || e.t === "grenadeExploded",
    );
    if (worth.length === 0 && positional.length === 0) return;

    const world = this.match.view;
    for (const [socket, session] of this.sessions) {
      if (!session.joined || session.playerId === null) continue;

      // Tracers are culled per client: a round fired across the map is not
      // something this player could have seen, and sending it to everyone
      // would make gunfire the single largest thing on the wire.
      const viewer = world.player(session.playerId);
      const near = (at: { x: number; y: number }, within: number): boolean =>
        viewer !== undefined &&
        Math.hypot(at.x - viewer.pos.x, at.y - viewer.pos.y) <= within;

      const nearby =
        viewer === undefined
          ? []
          : positional.filter((e) => {
              if (e.t === "shotFired") {
                return near(e.from, TRACER_VISIBILITY_M) || near(e.to, TRACER_VISIBILITY_M);
              }
              // A blast is a bigger, louder thing than a tracer, and one you
              // want to see from further away — it is the only warning that
              // somebody is throwing grenades at your position.
              return near(e.at, BLAST_VISIBILITY_M);
            });

      const payload = [...worth, ...nearby];
      if (payload.length === 0) continue;
      this.send(socket, session, {
        t: "events",
        tick: this.match.state.tick,
        events: payload,
      });
    }
  }

  private send(socket: WebSocket, session: Session, message: ServerMessage): void {
    if (socket.readyState !== socket.OPEN) return;
    const encoded = encodeServerMessage(message);
    const bytes = measure(encoded);
    session.bytesSent += bytes;
    this.windowBytes += bytes;
    socket.send(encoded);
  }

  // -------------------------------------------------------------------------
  // Match lifecycle
  // -------------------------------------------------------------------------

  private maybeRestart(events: readonly GameEvent[]): void {
    const intermissionTicks = rules.secondsToTicks(
      this.options.intermissionSeconds ?? DEFAULT_INTERMISSION_S,
    );

    if (events.some((e) => e.t === "matchEnded")) {
      this.intermissionLeft = intermissionTicks;
      return;
    }
    if (this.intermissionLeft === null) return;
    this.intermissionLeft--;
    if (this.intermissionLeft > 0) return;

    this.intermissionLeft = null;
    // Derive the next seed from the current one so a server's whole session
    // stays reproducible from the seed it was started with.
    this.seed = (this.seed * 1103515245 + 12345) >>> 0;
    this.match.restart(this.seed);

    // Entity ids do not survive a restart, so everyone is re-slotted and
    // re-welcomed rather than left holding stale ids.
    for (const [socket, session] of this.sessions) {
      if (!session.joined) continue;
      session.clearInput();
      session.playerId = this.match.claimSlot();
      this.welcome(socket, session);
    }
    process.stdout.write(
      `new match  seed=${this.seed} lane=${this.match.state.lane.name}\n`,
    );
  }

  private reportStats(): void {
    this.windowTicks++;
    if (this.windowTicks < STATS_INTERVAL_TICKS) return;

    const seconds = this.windowTicks / rules.TICK_RATE_HZ;
    const clients = Math.max(1, this.sessions.size);
    const perClientKbps = this.windowBytes / seconds / clients / 1024;
    const state = this.match.state;

    process.stdout.write(
      `tick=${state.tick} phase=${state.phase} ` +
        `tickets=${state.teams[0].tickets}/${state.teams[1].tickets} ` +
        `clients=${this.sessions.size} humans=${this.match.humanCount} ` +
        `bw=${perClientKbps.toFixed(1)}KB/s per client\n`,
    );

    this.windowBytes = 0;
    this.windowTicks = 0;
  }

  /** Test hook: current per-client bandwidth in the open window. */
  get windowBytesSent(): number {
    return this.windowBytes;
  }
}
