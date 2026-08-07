/**
 * Rally points — PLAN §2.3. Cheap, squad-only, wave-limited, and immune to
 * everything except an enemy physically walking onto it.
 */

import { describe, expect, it } from "vitest";
import { World, rallyIsLive, rules, validateRallyPlacement } from "../src/index.js";
import { firstEvent, harness } from "./helpers.js";

const OPEN_GROUND = { x: 500, y: 500 };

function leaderWithSquadmate(h: ReturnType<typeof harness>) {
  const team = h.team(0);
  const leader = team[0]!;
  const mate = team[1]!;
  h.place(leader.id, OPEN_GROUND);
  h.place(mate.id, OPEN_GROUND);
  return { leader, mate };
}

describe("rally placement", () => {
  it("needs a squad leader and one squadmate within 8 m", () => {
    const h = harness();
    const { leader, mate } = leaderWithSquadmate(h);

    expect(validateRallyPlacement(new World(h.state), leader)).toBeNull();

    h.place(mate.id, {
      x: OPEN_GROUND.x + rules.RALLY_PLACE_SQUADMATE_RADIUS_M + 1,
      y: OPEN_GROUND.y,
    });
    expect(validateRallyPlacement(new World(h.state), leader)).toBe("notEnoughSquadmates");
  });

  it("costs 50 rounds out of the leader's own pouch", () => {
    const h = harness();
    const { leader } = leaderWithSquadmate(h);
    const before = leader.ammo;

    h.tick([{ t: "placeRally", player: leader.id }]);

    expect(leader.ammo).toBe(before - rules.RALLY_AMMO_COST);
    expect(h.state.rallyPoints).toHaveLength(1);
  });

  it("is refused when the leader cannot pay", () => {
    const h = harness();
    const { leader } = leaderWithSquadmate(h);
    leader.ammo = rules.RALLY_AMMO_COST - 1;

    const events = h.tick([{ t: "placeRally", player: leader.id }]);

    expect(h.state.rallyPoints).toHaveLength(0);
    expect(firstEvent(events, "commandRejected")?.reason).toBe("notEnoughAmmo");
  });

  it("is refused with enemies nearby", () => {
    const h = harness();
    const { leader } = leaderWithSquadmate(h);
    h.place(h.team(1)[0]!.id, {
      x: OPEN_GROUND.x + rules.RALLY_ENEMY_BLOCK_RADIUS_M - 1,
      y: OPEN_GROUND.y,
    });

    expect(validateRallyPlacement(new World(h.state), leader)).toBe("enemiesTooClose");
  });

  it("replaces the squad's previous rally rather than stacking", () => {
    const h = harness();
    const { leader, mate } = leaderWithSquadmate(h);
    h.tick([{ t: "placeRally", player: leader.id }]);
    const first = h.state.rallyPoints[0]!;

    const moved = { x: OPEN_GROUND.x + 100, y: OPEN_GROUND.y };
    h.place(leader.id, moved);
    h.place(mate.id, moved);
    h.tick([{ t: "placeRally", player: leader.id }]);

    expect(first.destroyed).toBe(true);
    const live = h.state.rallyPoints.filter((r) => !r.destroyed);
    expect(live).toHaveLength(1);
    expect(h.state.squads.find((s) => s.id === leader.squad)?.rally).toBe(live[0]!.id);
  });
});

describe("rally survivability", () => {
  it("cannot be shot: only presence kills it", () => {
    const h = harness();
    const { leader } = leaderWithSquadmate(h);
    h.tick([{ t: "placeRally", player: leader.id }]);
    const rally = h.state.rallyPoints[0]!;

    // An enemy well inside weapon range but nowhere near the rally itself.
    const shooter = h.team(1)[0]!;
    h.place(shooter.id, {
      x: OPEN_GROUND.x + rules.RALLY_ENEMY_BLOCK_RADIUS_M + 10,
      y: OPEN_GROUND.y,
    });
    h.run(rules.secondsToTicks(60), () => [
      { t: "engage", player: shooter.id, target: leader.id },
    ]);

    expect(rally.destroyed).toBe(false);
  });

  it("is overrun by an enemy standing on it", () => {
    const h = harness();
    const { leader } = leaderWithSquadmate(h);
    h.tick([{ t: "placeRally", player: leader.id }]);
    const rally = h.state.rallyPoints[0]!;

    h.place(h.team(1)[0]!.id, rally.pos);
    const events = h.run(rules.OVERRUN_EVAL_INTERVAL_TICKS * 2);

    expect(rally.destroyed).toBe(true);
    expect(firstEvent(events, "rallyDestroyed")?.byEnemy).toBe(true);
    expect(h.state.squads.find((s) => s.id === leader.squad)?.rally).toBeNull();
  });

  it("blocks spawning while enemies are within 50 m, without dying", () => {
    const h = harness();
    const { leader } = leaderWithSquadmate(h);
    h.tick([{ t: "placeRally", player: leader.id }]);
    const rally = h.state.rallyPoints[0]!;

    const enemy = h.team(1)[0]!;
    h.place(enemy.id, {
      x: rally.pos.x + rules.RALLY_ENEMY_BLOCK_RADIUS_M - 1,
      y: rally.pos.y,
    });
    h.run(rules.OVERRUN_EVAL_INTERVAL_TICKS * 2);

    expect(rally.destroyed).toBe(false);
    expect(rallyIsLive(new World(h.state), rally)).toBe(false);

    h.place(enemy.id, { x: 0, y: 0 });
    expect(rallyIsLive(new World(h.state), rally)).toBe(true);
  });
});

describe("rally waves", () => {
  it("releases a wave then locks for the cooldown", () => {
    const h = harness({ playersPerTeam: rules.SQUAD_MAX_SIZE });
    const { leader } = leaderWithSquadmate(h);
    h.tick([{ t: "placeRally", player: leader.id }]);
    const rally = h.state.rallyPoints[0]!;

    // Kill two squadmates so they have to come back through the rally.
    const [first, second] = h.team(0).slice(2);
    for (const casualty of [first!, second!]) {
      casualty.status = "deploying";
      casualty.deployingSinceTick = h.state.tick;
    }
    h.run(rules.RALLY_SPAWN_DELAY_TICKS + 1);

    const spawn = h.tick([
      { t: "spawn", player: first!.id, source: { kind: "rally", rally: rally.id } },
    ]);
    expect(firstEvent(spawn, "playerSpawned")?.source).toBe("rally");

    // Same wave: the second body gets through too.
    const sameWave = h.tick([
      { t: "spawn", player: second!.id, source: { kind: "rally", rally: rally.id } },
    ]);
    expect(firstEvent(sameWave, "playerSpawned")).toBeDefined();

    // Wave closes, and the rally locks out.
    h.run(rules.RALLY_WAVE_WINDOW_TICKS + 1);
    expect(rallyIsLive(new World(h.state), rally)).toBe(false);

    h.run(rules.RALLY_WAVE_COOLDOWN_TICKS + 1);
    expect(rallyIsLive(new World(h.state), rally)).toBe(true);
  });

  it("only serves its own squad", () => {
    const h = harness({ playersPerTeam: rules.SQUAD_MAX_SIZE * 2 });
    const { leader } = leaderWithSquadmate(h);
    h.tick([{ t: "placeRally", player: leader.id }]);
    const rally = h.state.rallyPoints[0]!;

    const otherSquad = h.team(0).find((p) => p.squad !== leader.squad)!;
    otherSquad.status = "deploying";
    otherSquad.deployingSinceTick = h.state.tick;
    h.run(rules.RALLY_SPAWN_DELAY_TICKS + 1);

    const events = h.tick([
      { t: "spawn", player: otherSquad.id, source: { kind: "rally", rally: rally.id } },
    ]);
    expect(firstEvent(events, "commandRejected")?.reason).toBe("rallyNotYours");
  });
});
