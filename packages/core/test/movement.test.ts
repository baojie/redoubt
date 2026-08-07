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

const OPEN_GROUND = { x: 500, y: 500 };

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
