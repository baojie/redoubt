/**
 * The connection.
 *
 * Owns the socket, the input sequence counter, the ping probe and the
 * bandwidth meter. Everything it learns goes into `ClientWorld` and
 * `Predictor`; it holds no game state of its own.
 */

import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeClientMessage,
  measure,
  type Intent,
  type WelcomePayload,
} from "@redoubt/protocol";
import type { GameEvent } from "@redoubt/core";
import { ClientWorld } from "./world.js";
import { Predictor } from "./prediction.js";

/** How often to probe round-trip time. */
const PING_INTERVAL_MS = 1000;
/** Window over which received bytes are averaged for the HUD. */
const BANDWIDTH_WINDOW_MS = 2000;

export interface NetStats {
  pingMs: number;
  /** Received kilobytes per second, averaged over the window. */
  kbPerSecond: number;
  /** Server tick minus the tick we are rendering — how stale the view is. */
  tickDrift: number;
  /** Metres the last server correction moved us. */
  predictionErrorM: number;
  pendingInputs: number;
  connected: boolean;
}

export class Connection {
  readonly world = new ClientWorld();
  readonly predictor = new Predictor();

  welcome: WelcomePayload | null = null;
  /** Recent gameplay events, newest last. Drawn as a feed. */
  readonly feed: Array<{ tick: number; event: GameEvent }> = [];

  /**
   * Rounds fired nearby since the renderer last looked. Drained rather than
   * accumulated: a tracer is a one-frame instruction to start an animation,
   * not a piece of world state.
   */
  private shots: Array<Extract<GameEvent, { t: "shotFired" }>> = [];

  pingMs = 0;
  connected = false;

  private socket: WebSocket | null = null;
  private seq = 0;
  private pingTimer: number | null = null;
  private byteSamples: Array<{ at: number; bytes: number }> = [];
  private onWelcome: (() => void) | null = null;

  connect(url: string, name: string, onWelcome?: () => void): void {
    this.onWelcome = onWelcome ?? null;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.connected = true;
      this.send({ t: "join", protocol: PROTOCOL_VERSION, name });
      this.pingTimer = window.setInterval(() => {
        this.send({ t: "ping", sent: performance.now() });
      }, PING_INTERVAL_MS);
    });

    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      this.noteBytes(measure(raw));
      this.handle(raw);
    });

    socket.addEventListener("close", () => this.teardown());
    socket.addEventListener("error", () => this.teardown());
  }

  disconnect(): void {
    this.socket?.close();
    this.teardown();
  }

  private teardown(): void {
    this.connected = false;
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.socket = null;
  }

  private handle(raw: string): void {
    const message = decodeServerMessage(raw);
    if (message === null) return;

    switch (message.t) {
      case "welcome": {
        this.welcome = message;
        // Ids do not survive a match restart, and a restart re-welcomes us —
        // so a welcome always means "throw away what you knew".
        this.predictor.reset({ x: 0, y: 0 });
        this.feed.length = 0;
        this.onWelcome?.();
        return;
      }

      case "snapshot": {
        const snapshot = message.snapshot;
        this.world.apply(snapshot);

        const self = snapshot.self;
        if (self === null) return;
        // Prediction only applies while we are the one moving ourselves.
        // Dead, or riding in someone else's truck, the server's word is simply
        // the truth and there is nothing to replay.
        if (self.status !== "alive" || self.vehicle !== null) {
          this.predictor.snapTo({ x: self.x, y: self.y });
        } else {
          this.predictor.reconcile({ x: self.x, y: self.y }, snapshot.ackSeq);
        }
        return;
      }

      case "events": {
        for (const event of message.events) {
          if (event.t === "shotFired") {
            if (this.shots.length < MAX_QUEUED_SHOTS) this.shots.push(event);
            continue;
          }
          this.feed.push({ tick: message.tick, event });
        }
        while (this.feed.length > MAX_FEED) this.feed.shift();
        return;
      }

      case "pong": {
        this.pingMs = Math.max(0, performance.now() - message.sent);
        return;
      }

      case "rejected": {
        this.feed.push({
          tick: this.world.tick,
          event: { t: "matchEnded", tick: 0, winner: null, reason: message.reason },
        });
        return;
      }
    }
  }

  /** Take the tracers accumulated since the last frame. */
  takeShots(): Array<Extract<GameEvent, { t: "shotFired" }>> {
    const shots = this.shots;
    this.shots = [];
    return shots;
  }

  /** Send one input frame and predict it locally. Returns its sequence number. */
  sendInput(steer: { x: number; y: number } | null, extra: readonly Intent[]): number {
    this.seq++;
    const intents: Intent[] = [{ t: "steer", dir: steer ?? { x: 0, y: 0 } }, ...extra];
    this.send({ t: "input", seq: this.seq, intents });
    this.predictor.predict({ seq: this.seq, steer });
    return this.seq;
  }

  /** Send an action without a movement frame — used by menus and buttons. */
  sendAction(intent: Intent): void {
    this.seq++;
    this.send({ t: "input", seq: this.seq, intents: [intent] });
  }

  private send(message: Parameters<typeof encodeClientMessage>[0]): void {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeClientMessage(message));
  }

  private noteBytes(bytes: number): void {
    const now = performance.now();
    this.byteSamples.push({ at: now, bytes });
    const cutoff = now - BANDWIDTH_WINDOW_MS;
    while (this.byteSamples.length > 0 && (this.byteSamples[0]?.at ?? 0) < cutoff) {
      this.byteSamples.shift();
    }
  }

  stats(renderTick: number): NetStats {
    let bytes = 0;
    for (const sample of this.byteSamples) bytes += sample.bytes;
    return {
      pingMs: this.pingMs,
      kbPerSecond: bytes / (BANDWIDTH_WINDOW_MS / 1000) / 1024,
      tickDrift: this.world.tick - renderTick,
      predictionErrorM: this.predictor.lastErrorM,
      pendingInputs: this.predictor.pendingCount,
      connected: this.connected,
    };
  }
}

const MAX_FEED = 8;
/** A frame's worth of gunfire. Anything beyond this is not readable anyway. */
const MAX_QUEUED_SHOTS = 128;
