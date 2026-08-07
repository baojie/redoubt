/**
 * End-to-end server behaviour, over a real socket.
 *
 * These test the things that only exist once there is a network: that a human
 * takes over a bot slot rather than being bolted on, that authority actually
 * holds, that snapshots are culled and diffed, and that the bandwidth stays
 * inside PLAN §4's budget.
 */

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { rules } from "@redoubt/core";
import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeClientMessage,
  measure,
  type Intent,
  type ServerMessage,
  type Snapshot,
  type WelcomePayload,
} from "@redoubt/protocol";
import { GameServer } from "../src/gameServer.js";

/** Ports are picked high and per-suite to avoid colliding with anything real. */
let nextPort = 18800;

interface Harness {
  server: GameServer;
  port: number;
}

const running: GameServer[] = [];

function startServer(options: Partial<{ seed: number; playersPerTeam: number }> = {}): Harness {
  const port = nextPort++;
  const server = new GameServer({
    port,
    seed: options.seed ?? 42,
    playersPerTeam: options.playersPerTeam ?? rules.SQUAD_MAX_SIZE,
  });
  server.listen();
  running.push(server);
  return { server, port };
}

afterEach(() => {
  for (const server of running.splice(0)) server.close();
});

/** A test client that records everything the server says. */
class TestClient {
  readonly received: ServerMessage[] = [];
  bytesReceived = 0;
  private socket: WebSocket;
  private seq = 0;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw) => {
      const text = raw.toString();
      this.bytesReceived += measure(text);
      const message = decodeServerMessage(text);
      if (message !== null) this.received.push(message);
    });
  }

  static async connect(port: number, name = "tester"): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const client = new TestClient(socket);
    client.send({ t: "join", protocol: PROTOCOL_VERSION, name });
    return client;
  }

  send(message: Parameters<typeof encodeClientMessage>[0]): void {
    this.socket.send(encodeClientMessage(message));
  }

  input(intents: Intent[]): number {
    this.seq++;
    this.send({ t: "input", seq: this.seq, intents });
    return this.seq;
  }

  close(): void {
    this.socket.close();
  }

  welcome(): WelcomePayload | undefined {
    return this.received.find((m) => m.t === "welcome") as WelcomePayload | undefined;
  }

  snapshots(): Snapshot[] {
    return this.received
      .filter((m): m is { t: "snapshot"; snapshot: Snapshot } => m.t === "snapshot")
      .map((m) => m.snapshot);
  }

  latestSnapshot(): Snapshot | undefined {
    return this.snapshots().at(-1);
  }
}

/** Let the event loop deliver socket traffic. */
function settle(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Advance the simulation by a number of ticks without waiting in real time.
 *
 * Fed in small chunks because a single `advance` deliberately refuses to catch
 * up more than a few ticks at once — that cap is the anti-spiral guard, and
 * tests should exercise the loop the way real timer callbacks do, not around it.
 */
function advanceTicks(server: GameServer, ticks: number): void {
  const stepMs = 1000 / rules.TICK_RATE_HZ;
  for (let i = 0; i < ticks; i++) server.advanceForTest(stepMs);
}

describe("joining", () => {
  it("hands a human a soldier that a bot was already playing", async () => {
    const { server, port } = startServer();
    const rosterBefore = server.match.state.players.length;

    const client = await TestClient.connect(port);
    await settle();

    const welcome = client.welcome();
    expect(welcome).toBeDefined();
    expect(welcome!.protocol).toBe(PROTOCOL_VERSION);
    // The roster is fixed at match start — nobody is added, a slot is taken.
    expect(server.match.state.players.length).toBe(rosterBefore);
    expect(server.match.humanCount).toBe(1);
    expect(server.match.isHuman(welcome!.playerId)).toBe(true);
  });

  it("does not hand a newcomer the squad leader's responsibilities", async () => {
    const { server, port } = startServer();
    const client = await TestClient.connect(port);
    await settle();

    const welcome = client.welcome()!;
    const player = server.match.view.player(welcome.playerId)!;
    expect(player.role).not.toBe("squadLeader");
  });

  it("gives the slot back to the bots on disconnect", async () => {
    const { server, port } = startServer();
    const client = await TestClient.connect(port);
    await settle();
    expect(server.match.humanCount).toBe(1);

    client.close();
    await settle();
    expect(server.match.humanCount).toBe(0);
  });

  it("refuses a protocol mismatch instead of guessing", async () => {
    const { port } = startServer();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));

    const messages: ServerMessage[] = [];
    socket.on("message", (raw) => {
      const decoded = decodeServerMessage(raw.toString());
      if (decoded !== null) messages.push(decoded);
    });
    socket.send(encodeClientMessage({ t: "join", protocol: 999, name: "old" }));
    await settle();

    expect(messages[0]?.t).toBe("rejected");
    socket.close();
  });
});

describe("authority", () => {
  it("applies a client's steer to the client's own soldier", async () => {
    const { server, port } = startServer();
    const client = await TestClient.connect(port);
    await settle();
    const welcome = client.welcome()!;
    const player = server.match.view.player(welcome.playerId)!;
    const startX = player.pos.x;

    client.input([{ t: "steer", dir: { x: 1, y: 0 } }]);
    await settle();
    advanceTicks(server, rules.secondsToTicks(2));

    expect(player.pos.x).toBeGreaterThan(startX);
  });

  it("never lets a client name a different actor", async () => {
    const { server, port } = startServer();
    const attacker = await TestClient.connect(port, "attacker");
    // The victim is a second *human* slot: bots leave those alone, so if this
    // soldier moves at all it is because someone commanded them to.
    const victimClient = await TestClient.connect(port, "victim");
    await settle();

    const victim = server.match.view.player(victimClient.welcome()!.playerId)!;
    victim.pos = { x: 500, y: 500 };
    const victimStart = { ...victim.pos };

    // No field on the wire can carry another player's id, so this is the
    // closest a hostile client can get: smuggle one in and hope.
    attacker.send({
      t: "input",
      seq: 99,
      intents: [{ t: "steer", dir: { x: 1, y: 0 }, player: victim.id } as unknown as Intent],
    });
    await settle();
    advanceTicks(server, rules.secondsToTicks(2));

    // The victim has not moved; the attacker has moved themselves, because the
    // server bound the intent to the connection that sent it.
    expect(victim.pos).toEqual(victimStart);
    const self = server.match.view.player(attacker.welcome()!.playerId)!;
    expect(self.steer).not.toBeNull();
  });

  it("drops a malformed intent without dropping the rest of the frame", async () => {
    const { server, port } = startServer();
    const client = await TestClient.connect(port);
    await settle();
    const player = server.match.view.player(client.welcome()!.playerId)!;
    const startX = player.pos.x;

    client.input([
      { t: "steer", dir: { x: Number.NaN, y: 0 } } as Intent,
      { t: "steer", dir: { x: 1, y: 0 } },
    ]);
    await settle();
    advanceTicks(server, rules.secondsToTicks(2));

    expect(Number.isFinite(player.pos.x)).toBe(true);
    expect(player.pos.x).toBeGreaterThan(startX);
  });

  it("gives no advantage to a client that spams input frames", async () => {
    const { server, port } = startServer();
    const fast = await TestClient.connect(port);
    const slow = await TestClient.connect(port);
    await settle();

    const fastPlayer = server.match.view.player(fast.welcome()!.playerId)!;
    const slowPlayer = server.match.view.player(slow.welcome()!.playerId)!;
    const origin = { x: 500, y: 500 };
    fastPlayer.pos = { ...origin };
    slowPlayer.pos = { ...origin };

    // One frame of steering each — then the spammer sends it twenty more times.
    slow.input([{ t: "steer", dir: { x: 1, y: 0 } }]);
    for (let i = 0; i < 20; i++) fast.input([{ t: "steer", dir: { x: 1, y: 0 } }]);
    await settle();
    advanceTicks(server, rules.secondsToTicks(3));

    expect(fastPlayer.pos.x).toBeCloseTo(slowPlayer.pos.x, 3);
  });
});

describe("snapshots", () => {
  it("acknowledges the input sequence it consumed", async () => {
    const { server, port } = startServer();
    const client = await TestClient.connect(port);
    await settle();

    const seq = client.input([{ t: "steer", dir: { x: 0, y: 1 } }]);
    await settle();
    advanceTicks(server, 4);
    await settle();

    const acked = client.snapshots().some((s) => s.ackSeq === seq);
    expect(acked).toBe(true);
  });

  it("sends one full snapshot first, then diffs", async () => {
    const { server, port } = startServer();
    const client = await TestClient.connect(port);
    await settle();
    advanceTicks(server, 1);
    await settle();

    const snapshots = client.snapshots();
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]!.full).toBe(true);

    // A tick in which nothing moved should carry almost nothing.
    advanceTicks(server, 1);
    await settle();
    const later = client.latestSnapshot()!;
    expect(later.full).toBe(false);
  });

  it("culls by distance and names what left the view", async () => {
    const { server, port } = startServer({ playersPerTeam: rules.SQUAD_MAX_SIZE });
    const client = await TestClient.connect(port);
    await settle();

    const self = server.match.view.player(client.welcome()!.playerId)!;
    // Park the viewer alone in a corner; everyone not in their squad is far away.
    self.pos = { x: 20, y: 980 };
    const outsider = server.match.state.players.find(
      (p) => p.squad !== self.squad && p.id !== self.id,
    )!;
    outsider.pos = { x: 980, y: 20 };

    advanceTicks(server, rules.secondsToTicks(11)); // forces a full resync
    await settle();

    const latest = client.snapshots().filter((s) => s.full).at(-1)!;
    const ids = latest.players.map((p) => p.id);
    expect(ids).not.toContain(outsider.id);
    expect(ids).toContain(self.id);
  });

  it("always shows your own squad, however far away they are", async () => {
    const { server, port } = startServer();
    const client = await TestClient.connect(port);
    await settle();

    const self = server.match.view.player(client.welcome()!.playerId)!;
    self.pos = { x: 20, y: 980 };
    const squadmate = server.match.state.players.find(
      (p) => p.squad === self.squad && p.id !== self.id,
    )!;
    squadmate.pos = { x: 980, y: 20 };

    advanceTicks(server, rules.secondsToTicks(11));
    await settle();

    const latest = client.snapshots().filter((s) => s.full).at(-1)!;
    expect(latest.players.map((p) => p.id)).toContain(squadmate.id);
  });

  it("keeps another squad's rally point private", async () => {
    const { server, port } = startServer({ playersPerTeam: rules.SQUAD_MAX_SIZE * 2 });
    const client = await TestClient.connect(port);
    await settle();

    const self = server.match.view.player(client.welcome()!.playerId)!;
    // A different squad on our *own* team, so team visibility is not the
    // reason it stays hidden — squad privacy is.
    const otherSquad = server.match.state.squads.find(
      (s) => s.id !== self.squad && s.team === self.team,
    )!;
    const leader = server.match.view.player(otherSquad.leader!)!;
    const mate = server.match.view.player(otherSquad.members[1]!)!;

    // Open ground, clear of both mains, and right next to us — so neither
    // distance nor the main-base exclusion is doing the hiding.
    const spot = { x: 500, y: 500 };
    self.pos = { ...spot };
    leader.pos = { ...spot };
    mate.pos = { ...spot };
    server.match.submit([{ t: "placeRally", player: leader.id }]);

    advanceTicks(server, rules.secondsToTicks(11));
    await settle();

    expect(server.match.state.rallyPoints.length).toBe(1);
    const latest = client.snapshots().filter((s) => s.full).at(-1)!;
    expect(latest.rallies).toHaveLength(0);
  });

  it("stays inside the per-client bandwidth budget", async () => {
    const { server, port } = startServer({ playersPerTeam: rules.PLAYERS_PER_TEAM });
    const client = await TestClient.connect(port);
    await settle();

    // Let the match get going so people are actually moving and fighting.
    advanceTicks(server, rules.STAGING_TICKS + rules.secondsToTicks(20));
    await settle(120);

    const before = client.bytesReceived;
    const seconds = 10;
    advanceTicks(server, rules.secondsToTicks(seconds));
    await settle(200);

    const kbPerSecond = (client.bytesReceived - before) / seconds / 1024;
    // PLAN §4 budgets under 30 KB/s per client at this scale. We currently sit
    // near 13, so the assertion is set at 20 rather than 30: the point is to
    // notice the day something eats the headroom, not the day it runs out.
    expect(kbPerSecond).toBeLessThan(20);
  });
});

describe("match lifecycle", () => {
  it("keeps ticking with nobody connected", () => {
    const { server } = startServer();
    const before = server.match.state.tick;
    advanceTicks(server, 100);
    expect(server.match.state.tick).toBe(before + 100);
  });

  it("advances by whole ticks only, whatever the timer does", () => {
    const { server } = startServer();
    const before = server.match.state.tick;
    // Three ragged callbacks totalling 100ms — exactly two ticks' worth.
    server.advanceForTest(17);
    server.advanceForTest(61);
    server.advanceForTest(22);
    expect(server.match.state.tick).toBe(before + 2);
  });

  it("skips time rather than spiralling after a long stall", () => {
    const { server } = startServer();
    const before = server.match.state.tick;
    server.advanceForTest(60_000); // a minute-long freeze
    // It catches up a little and then gives up on the rest, as it should.
    expect(server.match.state.tick - before).toBeLessThan(rules.secondsToTicks(2));
  });
});
