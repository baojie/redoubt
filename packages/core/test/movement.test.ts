/**
 * Movement, and the two mutually exclusive ways to issue it.
 *
 * `move` walks to a place and is what a bot issues. `steer` holds a direction
 * and is what a human on WASD issues. They must never both apply, and a client
 * must not be able to travel faster by sending a longer vector.
 */

import { describe, expect, it } from "vitest";
import { distance, rules } from "../src/index.js";
import { firstEvent, harness } from "./helpers.js";

/**
 * Genuinely open ground: clear of every hand-placed volume on the map, so
 * these tests measure movement rather than collision. Cover has its own tests.
 */
const OPEN_GROUND = { x: 150, y: 150 };

describe("steering", () => {
  it("walks at exactly the soldier's speed along the direction", () => {
    const h = harness();
    const player = h.team(0)[0]!;
    h.place(player.id, OPEN_GROUND);

    h.tick([{ t: "steer", player: player.id, dir: { x: 1, y: 0 } }]);
    const seconds = 3;
    h.run(rules.secondsToTicks(seconds) - 1);

    const travelled = distance(player.pos, OPEN_GROUND);
    expect(travelled).toBeCloseTo(rules.PLAYER_SPEED_MPS * seconds, 1);
    expect(player.pos.y).toBeCloseTo(OPEN_GROUND.y, 6);
  });

  it("normalises, so a longer vector is not a speed hack", () => {
    const h = harness();
    const cheat = h.team(0)[0]!;
    const honest = h.team(0)[1]!;
    h.place(cheat.id, OPEN_GROUND);
    h.place(honest.id, OPEN_GROUND);

    h.tick([
      { t: "steer", player: cheat.id, dir: { x: 1000, y: 0 } },
      { t: "steer", player: honest.id, dir: { x: 1, y: 0 } },
    ]);
    h.run(rules.secondsToTicks(2));

    expect(cheat.pos.x).toBeCloseTo(honest.pos.x, 6);
  });

  it("keeps going until told otherwise, so a dropped packet does not stutter", () => {
    const h = harness();
    const player = h.team(0)[0]!;
    h.place(player.id, OPEN_GROUND);

    h.tick([{ t: "steer", player: player.id, dir: { x: 0, y: 1 } }]);
    // Not one further command for ten seconds.
    h.run(rules.secondsToTicks(10));

    expect(player.pos.y).toBeGreaterThan(OPEN_GROUND.y + 30);
  });

  it("stops on a zero vector and on halt", () => {
    const h = harness();
    const player = h.team(0)[0]!;
    h.place(player.id, OPEN_GROUND);

    h.tick([{ t: "steer", player: player.id, dir: { x: 1, y: 0 } }]);
    h.run(rules.secondsToTicks(1));
    const afterWalking = { ...player.pos };

    h.tick([{ t: "steer", player: player.id, dir: { x: 0, y: 0 } }]);
    h.run(rules.secondsToTicks(2));
    expect(player.pos).toEqual(afterWalking);

    h.tick([{ t: "steer", player: player.id, dir: { x: -1, y: 0 } }]);
    h.tick([{ t: "halt", player: player.id }]);
    const afterHalt = { ...player.pos };
    h.run(rules.secondsToTicks(2));
    expect(player.pos).toEqual(afterHalt);
  });

  it("is exclusive with a waypoint, last command winning", () => {
    const h = harness();
    const player = h.team(0)[0]!;
    h.place(player.id, OPEN_GROUND);

    h.tick([{ t: "move", player: player.id, to: { x: 600, y: 500 } }]);
    expect(player.waypoint).not.toBeNull();

    h.tick([{ t: "steer", player: player.id, dir: { x: 0, y: -1 } }]);
    expect(player.waypoint).toBeNull();
    expect(player.steer).not.toBeNull();

    h.tick([{ t: "move", player: player.id, to: { x: 600, y: 500 } }]);
    expect(player.steer).toBeNull();
    expect(player.waypoint).not.toBeNull();
  });

  it("is cleared by death, so a corpse does not drift", () => {
    const h = harness();
    const player = h.team(0)[0]!;
    h.place(player.id, OPEN_GROUND);
    h.tick([{ t: "steer", player: player.id, dir: { x: 1, y: 0 } }]);

    player.status = "downed";
    player.bleedoutAtTick = h.state.tick;
    h.run(2);
    const restingPlace = { ...player.pos };

    h.run(rules.secondsToTicks(5));
    expect(player.steer).toBeNull();
    expect(player.pos).toEqual(restingPlace);
  });

  it("is refused while mounted — the driver steers, not the passenger", () => {
    const h = harness();
    const player = h.team(0)[0]!;
    const truck = h.state.vehicles.find((v) => v.team === 0)!;
    h.place(player.id, truck.pos);
    h.tick([{ t: "enterVehicle", player: player.id, vehicle: truck.id }]);

    const events = h.tick([{ t: "steer", player: player.id, dir: { x: 1, y: 0 } }]);
    expect(firstEvent(events, "commandRejected")?.reason).toBe("mounted");
    expect(player.steer).toBeNull();
  });
});

describe("waypoints", () => {
  it("stop exactly on arrival without overshooting", () => {
    const h = harness();
    const player = h.team(0)[0]!;
    h.place(player.id, OPEN_GROUND);
    const target = { x: OPEN_GROUND.x + 7, y: OPEN_GROUND.y };

    h.tick([{ t: "move", player: player.id, to: target }]);
    h.run(rules.secondsToTicks(10));

    expect(player.pos).toEqual(target);
    expect(player.waypoint).toBeNull();
  });
});

describe("aiming down the sights", () => {
  it("costs mobility, which is what makes taking the shot a decision", () => {
    const h = harness();
    const hip = h.team(0)[0]!;
    const aimed = h.team(0)[1]!;
    h.place(hip.id, OPEN_GROUND);
    h.place(aimed.id, OPEN_GROUND);

    h.tick([
      { t: "steer", player: hip.id, dir: { x: 1, y: 0 } },
      { t: "steer", player: aimed.id, dir: { x: 1, y: 0 } },
      { t: "aim", player: aimed.id, aiming: true },
    ]);
    h.run(rules.secondsToTicks(4));

    const hipTravel = hip.pos.x - OPEN_GROUND.x;
    const aimedTravel = aimed.pos.x - OPEN_GROUND.x;
    expect(aimedTravel).toBeGreaterThan(0);
    expect(aimedTravel).toBeCloseTo(hipTravel * rules.ADS_MOVE_SPEED_MULTIPLIER, 1);
  });

  it("is dropped by a reload — both hands are on the magazine", () => {
    const h = harness();
    const player = h.team(0)[0]!;
    h.place(player.id, OPEN_GROUND);
    h.tick([{ t: "aim", player: player.id, aiming: true }]);
    expect(player.aiming).toBe(true);

    player.magazine = 1;
    h.tick([{ t: "reload", player: player.id }]);
    expect(player.aiming).toBe(false);
  });
});

describe("cover", () => {
  it("stops a soldier walking into a wall", () => {
    const h = harness();
    const player = h.team(0)[0]!;
    const wall = h.state.map.cover.find((c) => c.kind === "wall")!;

    // Start clear of the wall on its south side and walk north into it.
    h.place(player.id, { x: wall.x, y: wall.y - wall.halfDepth - 8 });
    h.tick([{ t: "steer", player: player.id, dir: { x: 0, y: 1 } }]);
    h.run(rules.secondsToTicks(10));

    expect(player.pos.y).toBeLessThan(wall.y - wall.halfDepth);
  });

  it("lets a soldier slide along a wall rather than sticking to it", () => {
    const h = harness();
    const player = h.team(0)[0]!;
    const wall = h.state.map.cover.find((c) => c.kind === "wall" && c.halfWidth > 10)!;

    h.place(player.id, { x: wall.x, y: wall.y - wall.halfDepth - 1 });
    // Into the wall and along it at the same time.
    h.tick([{ t: "steer", player: player.id, dir: { x: 1, y: 1 } }]);
    const startX = player.pos.x;
    h.run(rules.secondsToTicks(5));

    expect(player.pos.x).toBeGreaterThan(startX + 5);
    expect(player.pos.y).toBeLessThan(wall.y - wall.halfDepth);
  });

  it("never leaves a soldier inside a building", () => {
    const h = harness();
    const player = h.team(0)[0]!;
    const building = h.state.map.cover.find((c) => c.kind === "building")!;

    // Shove them into the middle of it, then let a tick resolve.
    h.place(player.id, { x: building.x, y: building.y });
    h.tick([{ t: "steer", player: player.id, dir: { x: 0.2, y: 0.1 } }]);
    h.run(2);

    const insideX = Math.abs(player.pos.x - building.x) < building.halfWidth;
    const insideY = Math.abs(player.pos.y - building.y) < building.halfDepth;
    expect(insideX && insideY).toBe(false);
  });
});

describe("map bounds", () => {
  it("clamp a soldier steering off the edge", () => {
    const h = harness();
    const player = h.team(0)[0]!;
    h.place(player.id, { x: 5, y: 5 });

    h.tick([{ t: "steer", player: player.id, dir: { x: -1, y: -1 } }]);
    h.run(rules.secondsToTicks(30));

    expect(player.pos.x).toBeGreaterThanOrEqual(0);
    expect(player.pos.y).toBeGreaterThanOrEqual(0);
  });
});
