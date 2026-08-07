/**
 * FOB lifecycle: placement constraints, supply, construction, overrun and the
 * destruction cascade. PLAN §2.4.
 */

import { describe, expect, it } from "vitest";
import { Simulation, World, rules, validateFobPlacement } from "../src/index.js";
import { eventsOfType, firstEvent, harness, stockFob } from "./helpers.js";

/** Somewhere in open ground, clear of both main bases and any other FOB. */
const OPEN_GROUND = { x: 500, y: 500 };

function squadAt(h: ReturnType<typeof harness>, pos: { x: number; y: number }, count: number) {
  const team = h.team(0);
  for (let i = 0; i < count; i++) {
    const player = team[i];
    if (player !== undefined) h.place(player.id, pos);
  }
  return team;
}

describe("FOB placement", () => {
  it("requires a squad leader", () => {
    const h = harness();
    const members = squadAt(h, OPEN_GROUND, 3);
    const rifleman = members.find((p) => p.role !== "squadLeader");
    expect(rifleman).toBeDefined();
    const world = new World(h.state);
    expect(validateFobPlacement(world, rifleman!)).toBe("notSquadLeader");
  });

  it("requires two squadmates within 15 m", () => {
    const h = harness();
    const members = squadAt(h, OPEN_GROUND, 2); // leader + one only
    const leader = members[0]!;
    const world = new World(h.state);
    expect(validateFobPlacement(world, leader)).toBe("notEnoughSquadmates");

    h.place(members[2]!.id, OPEN_GROUND);
    expect(validateFobPlacement(new World(h.state), leader)).toBeNull();
  });

  it("counts only squadmates inside the radius", () => {
    const h = harness();
    const members = squadAt(h, OPEN_GROUND, 3);
    h.place(members[2]!.id, {
      x: OPEN_GROUND.x + rules.FOB_PLACE_SQUADMATE_RADIUS_M + 1,
      y: OPEN_GROUND.y,
    });
    const world = new World(h.state);
    expect(validateFobPlacement(world, members[0]!)).toBe("notEnoughSquadmates");
  });

  it("refuses to sit within 150 m of a main base", () => {
    const h = harness();
    const main = h.state.teams[0].mainBase;
    const tooClose = { x: main.x + rules.FOB_MIN_DISTANCE_FROM_MAIN_BASE_M - 1, y: main.y };
    squadAt(h, tooClose, 3);
    const world = new World(h.state);
    expect(validateFobPlacement(world, h.team(0)[0]!)).toBe("tooCloseToMainBase");
  });

  it("refuses to sit within 400 m of a friendly FOB", () => {
    const h = harness();
    const members = squadAt(h, OPEN_GROUND, 3);
    h.tick([{ t: "placeFob", player: members[0]!.id }]);
    expect(h.state.fobs).toHaveLength(1);

    const nearby = {
      x: OPEN_GROUND.x + rules.FOB_MIN_DISTANCE_FROM_FRIENDLY_FOB_M - 1,
      y: OPEN_GROUND.y,
    };
    squadAt(h, nearby, 3);
    expect(validateFobPlacement(new World(h.state), h.team(0)[0]!)).toBe(
      "tooCloseToFriendlyFob",
    );
  });

  it("allows a second FOB at exactly the spacing limit", () => {
    const h = harness();
    const members = squadAt(h, OPEN_GROUND, 3);
    h.tick([{ t: "placeFob", player: members[0]!.id }]);

    // Straight up the map, so the second site stays clear of both mains.
    const far = {
      x: OPEN_GROUND.x,
      y: OPEN_GROUND.y + rules.FOB_MIN_DISTANCE_FROM_FRIENDLY_FOB_M,
    };
    squadAt(h, far, 3);
    expect(validateFobPlacement(new World(h.state), h.team(0)[0]!)).toBeNull();
  });

  it("ignores enemy FOBs when checking spacing", () => {
    const h = harness();
    // Enemy plants first, right where we want to be.
    const red = h.team(1);
    for (let i = 0; i < 3; i++) h.place(red[i]!.id, OPEN_GROUND);
    h.tick([{ t: "placeFob", player: red[0]!.id }]);
    expect(h.state.fobs).toHaveLength(1);

    squadAt(h, OPEN_GROUND, 3);
    expect(validateFobPlacement(new World(h.state), h.team(0)[0]!)).toBeNull();
  });
});

describe("construction", () => {
  it("spends the FOB's construction points as progress accrues", () => {
    const h = harness();
    const members = squadAt(h, OPEN_GROUND, 3);
    h.tick([{ t: "placeFob", player: members[0]!.id }]);
    const fob = h.state.fobs[0]!;
    stockFob(h.state, fob.id, 1000, 0);

    h.tick([
      {
        t: "placeDeployable",
        player: members[0]!.id,
        fob: fob.id,
        kind: "habitat",
        pos: OPEN_GROUND,
      },
    ]);
    const habitat = h.state.deployables[0]!;

    const before = fob.constructionPoints;
    h.run(rules.secondsToTicks(1), () => [
      { t: "build", player: members[0]!.id, deployable: habitat.id },
    ]);

    expect(fob.constructionPoints).toBeLessThan(before);
    expect(habitat.buildProgressWork).toBeGreaterThan(0);
    expect(habitat.built).toBe(false);
  });

  it("builds a habitat in 40 s with one soldier and 4 s with five", () => {
    const solo = timeToBuildHabitat(1);
    const squad = timeToBuildHabitat(5);
    expect(solo).toBeCloseTo(40, 0);
    expect(squad).toBeCloseTo(4, 0);
  });

  it("stalls when the FOB runs out of construction points", () => {
    const h = harness();
    const members = squadAt(h, OPEN_GROUND, 3);
    h.tick([{ t: "placeFob", player: members[0]!.id }]);
    const fob = h.state.fobs[0]!;
    // Half of what a habitat costs.
    stockFob(h.state, fob.id, rules.DEPLOYABLE_SPECS.habitat.constructionCost / 2, 0);

    h.tick([
      {
        t: "placeDeployable",
        player: members[0]!.id,
        fob: fob.id,
        kind: "habitat",
        pos: OPEN_GROUND,
      },
    ]);
    const habitat = h.state.deployables[0]!;

    h.run(rules.secondsToTicks(120), () => [
      { t: "build", player: members[0]!.id, deployable: habitat.id },
    ]);

    expect(habitat.built).toBe(false);
    expect(fob.constructionPoints).toBeCloseTo(0, 3);
    // Progress got exactly as far as the supply paid for.
    expect(habitat.buildProgressWork).toBeCloseTo(habitat.buildWorkRequired / 2, 1);
  });

  it("enforces one habitat per FOB", () => {
    const h = harness();
    const members = squadAt(h, OPEN_GROUND, 3);
    h.tick([{ t: "placeFob", player: members[0]!.id }]);
    const fob = h.state.fobs[0]!;
    stockFob(h.state, fob.id, rules.FOB_MAX_CONSTRUCTION_POINTS, 0);

    const place = {
      t: "placeDeployable" as const,
      player: members[0]!.id,
      fob: fob.id,
      kind: "habitat" as const,
      pos: OPEN_GROUND,
    };
    h.tick([place]);
    const rejected = h.tick([place]);

    expect(h.state.deployables.filter((d) => d.type === "habitat")).toHaveLength(1);
    expect(firstEvent(rejected, "commandRejected")?.reason).toBe("typeLimitReached");
  });

  it("refuses build sites outside the 150 m build radius", () => {
    const h = harness();
    const members = squadAt(h, OPEN_GROUND, 3);
    h.tick([{ t: "placeFob", player: members[0]!.id }]);
    const fob = h.state.fobs[0]!;

    const far = { x: OPEN_GROUND.x + rules.FOB_BUILD_RADIUS_M + 1, y: OPEN_GROUND.y };
    h.place(members[0]!.id, far);
    const events = h.tick([
      { t: "placeDeployable", player: members[0]!.id, fob: fob.id, kind: "ammoCrate", pos: far },
    ]);
    expect(firstEvent(events, "commandRejected")?.reason).toBe("outsideBuildRadius");
  });
});

describe("overrun", () => {
  it("goes red with two enemies within 20 m", () => {
    const { h, habitat } = builtHabitat();
    const red = h.team(1);
    h.place(red[0]!.id, habitat.pos);
    h.run(rules.OVERRUN_EVAL_INTERVAL_TICKS * 2);
    expect(habitat.overrun).toBe(false);

    h.place(red[1]!.id, habitat.pos);
    h.run(rules.OVERRUN_EVAL_INTERVAL_TICKS * 2);
    expect(habitat.overrun).toBe(true);
  });

  it("goes red with eight enemies within 80 m even if none are close", () => {
    const { h, habitat } = builtHabitat({ playersPerTeam: 12 });
    const red = h.team(1);
    const ring = rules.OVERRUN_FAR_RADIUS_M - 5;
    for (let i = 0; i < rules.OVERRUN_FAR_ENEMY_COUNT; i++) {
      const angle = (i / rules.OVERRUN_FAR_ENEMY_COUNT) * Math.PI * 2;
      h.place(red[i]!.id, {
        x: habitat.pos.x + Math.cos(angle) * ring,
        y: habitat.pos.y + Math.sin(angle) * ring,
      });
    }
    h.run(rules.OVERRUN_EVAL_INTERVAL_TICKS * 2);
    expect(habitat.overrun).toBe(true);
  });

  it("clears once the enemy is driven off", () => {
    const { h, habitat } = builtHabitat();
    const red = h.team(1);
    h.place(red[0]!.id, habitat.pos);
    h.place(red[1]!.id, habitat.pos);
    h.run(rules.OVERRUN_EVAL_INTERVAL_TICKS * 2);
    expect(habitat.overrun).toBe(true);

    h.place(red[0]!.id, { x: 0, y: 0 });
    h.place(red[1]!.id, { x: 0, y: 0 });
    h.run(rules.OVERRUN_EVAL_INTERVAL_TICKS * 2);
    expect(habitat.overrun).toBe(false);
  });
});

describe("radio destruction", () => {
  it("costs 20 tickets and vaporises every tech structure in the radius", () => {
    const { h, habitat, fob, team } = builtHabitat();
    stockFob(h.state, fob.id, rules.FOB_MAX_CONSTRUCTION_POINTS, 0);

    // Earthworks are supposed to survive their radio. Put it on the far side
    // so nothing but the cascade can reach it.
    const sandbag = buildAt(h, team[0]!.id, fob.id, "sandbag", {
      x: OPEN_GROUND.x - STRUCTURE_OFFSET_M,
      y: OPEN_GROUND.y,
    });
    h.place(team[0]!.id, { x: 100, y: 900 });

    const ticketsBefore = h.state.teams[0].tickets;
    // Walk the whole enemy team onto the radio itself — not onto the buildings.
    for (const enemy of h.team(1)) h.place(enemy.id, fob.pos);
    const events = h.run(rules.secondsToTicks(30));

    expect(fob.destroyed).toBe(true);
    expect(habitat.destroyed).toBe(true);
    expect(sandbag.destroyed).toBe(false);
    expect(
      eventsOfType(events, "deployableDestroyed").find((e) => e.deployable === habitat.id)
        ?.cascaded,
    ).toBe(true);
    expect(h.state.teams[0].tickets).toBe(
      ticketsBefore - rules.TICKET_COST_FOB_RADIO_DESTROYED,
    );
  });

  it("costs nothing when you pull your own radio", () => {
    const { h, habitat, fob } = builtHabitat();
    const ticketsBefore = h.state.teams[0].tickets;

    const events = h.tick([
      { t: "dismantleFob", player: h.team(0)[0]!.id, fob: fob.id },
    ]);

    expect(fob.destroyed).toBe(true);
    expect(habitat.destroyed).toBe(true);
    expect(h.state.teams[0].tickets).toBe(ticketsBefore);
    expect(firstEvent(events, "fobDestroyed")?.selfDismantled).toBe(true);
    expect(eventsOfType(events, "ticketChange")).toHaveLength(0);
  });
});

describe("supply pools", () => {
  it("never exceed their ceilings", () => {
    const h = harness();
    const members = squadAt(h, OPEN_GROUND, 3);
    h.tick([{ t: "placeFob", player: members[0]!.id }]);
    const fob = h.state.fobs[0]!;
    stockFob(h.state, fob.id, rules.FOB_MAX_CONSTRUCTION_POINTS, rules.FOB_MAX_AMMO_POINTS);

    expect(fob.constructionPoints).toBe(rules.FOB_MAX_CONSTRUCTION_POINTS);
    expect(fob.ammoPoints).toBe(rules.FOB_MAX_AMMO_POINTS);
  });
});

// ---------------------------------------------------------------------------

function timeToBuildHabitat(builders: number): number {
  const h = harness({ playersPerTeam: Math.max(builders, 3) });
  const team = h.team(0);
  for (let i = 0; i < team.length; i++) h.place(team[i]!.id, OPEN_GROUND);

  h.tick([{ t: "placeFob", player: team[0]!.id }]);
  const fob = h.state.fobs[0]!;
  stockFob(h.state, fob.id, rules.FOB_MAX_CONSTRUCTION_POINTS, rules.FOB_MAX_AMMO_POINTS);
  h.tick([
    { t: "placeDeployable", player: team[0]!.id, fob: fob.id, kind: "habitat", pos: OPEN_GROUND },
  ]);
  const habitat = h.state.deployables[0]!;

  const startTick = h.state.tick;
  const events = h.run(rules.secondsToTicks(120), () =>
    team.slice(0, builders).map((p) => ({
      t: "build" as const,
      player: p.id,
      deployable: habitat.id,
    })),
  );
  const built = firstEvent(events, "deployableBuilt");
  expect(built).toBeDefined();
  return rules.ticksToSeconds(built!.tick - startTick);
}

/** Offset from the radio, so structures can be attacked independently of it. */
const STRUCTURE_OFFSET_M = 60;

/** Build one structure of the given kind, offset from the radio, and return it. */
function buildAt(
  h: ReturnType<typeof harness>,
  builderId: number,
  fobId: number,
  kind: "habitat" | "sandbag" | "ammoCrate",
  pos: { x: number; y: number },
) {
  h.place(builderId, pos);
  h.tick([{ t: "placeDeployable", player: builderId, fob: fobId, kind, pos }]);
  const deployable = h.state.deployables[h.state.deployables.length - 1]!;
  h.run(rules.secondsToTicks(rules.DEPLOYABLE_SPECS[kind].buildWorkSeconds) + 2, () => [
    { t: "build", player: builderId, deployable: deployable.id },
  ]);
  expect(deployable.built).toBe(true);
  return deployable;
}

function builtHabitat(options: { playersPerTeam?: number } = {}) {
  const h = harness({ playersPerTeam: options.playersPerTeam ?? rules.SQUAD_MAX_SIZE });
  const team = h.team(0);
  for (let i = 0; i < 3; i++) h.place(team[i]!.id, OPEN_GROUND);

  h.tick([{ t: "placeFob", player: team[0]!.id }]);
  const fob = h.state.fobs[0]!;
  stockFob(h.state, fob.id, rules.FOB_MAX_CONSTRUCTION_POINTS, rules.FOB_MAX_AMMO_POINTS);

  const habitat = buildAt(h, team[0]!.id, fob.id, "habitat", {
    x: OPEN_GROUND.x + STRUCTURE_OFFSET_M,
    y: OPEN_GROUND.y,
  });

  // Clear the builders off the position so they do not skew overrun counts.
  for (let i = 0; i < 3; i++) h.place(team[i]!.id, { x: 100, y: 900 });

  return { h, fob, habitat, team };
}

describe("simulation construction", () => {
  it("draws a lane and only instantiates that lane's points", () => {
    const sim = Simulation.create({ seed: 7 });
    expect(sim.state.controlPoints).toHaveLength(sim.state.lane.points.length);
    for (const point of sim.state.controlPoints) {
      expect(sim.state.lane.points).toContain(point.id);
    }
  });
});
