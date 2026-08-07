/**
 * Casualties, revives and the spawn economy — the part of the design where a
 * body is only worth a ticket once nobody comes for it.
 */

import { describe, expect, it } from "vitest";
import { rules } from "../src/index.js";
import { eventsOfType, firstEvent, harness } from "./helpers.js";

/**
 * Open ground: clear of every hand-placed cover volume and far enough from
 * both main bases that a FOB may legally be planted here. Tests that are not
 * about cover should not accidentally be standing in a wall.
 */
const OPEN_GROUND = { x: 150, y: 150 };

describe("engagements", () => {
  it("spends a round from the magazine, and is rate limited", () => {
    const h = harness();
    const shooter = h.team(0)[0]!;
    const target = h.team(1)[0]!;
    h.place(shooter.id, OPEN_GROUND);
    h.place(target.id, OPEN_GROUND);

    // Rounds come out of the magazine; `ammo` is the reserve a reload draws on.
    const magazineBefore = shooter.magazine;
    const reserveBefore = shooter.ammo;
    h.tick([{ t: "engage", player: shooter.id, target: target.id }]);
    expect(shooter.magazine).toBe(magazineBefore - rules.AMMO_PER_ENGAGEMENT);
    expect(shooter.ammo).toBe(reserveBefore);

    const tooSoon = h.tick([{ t: "engage", player: shooter.id, target: target.id }]);
    expect(firstEvent(tooSoon, "commandRejected")?.reason).toBe("weaponCycling");
    expect(shooter.magazine).toBe(magazineBefore - rules.AMMO_PER_ENGAGEMENT);
  });

  it("lets rounds fly past the range a bot would bother shooting at", () => {
    // There is no "out of range" any more. A rifle fires; where the round ends
    // up is geometry. Distant targets are missed, not refused.
    const h = harness();
    const shooter = h.team(0)[0]!;
    const target = h.team(1)[0]!;
    h.place(shooter.id, OPEN_GROUND);
    h.place(target.id, {
      x: OPEN_GROUND.x + rules.ENGAGEMENT_MAX_RANGE_M + 100,
      y: OPEN_GROUND.y,
    });

    const events = h.tick([{ t: "engage", player: shooter.id, target: target.id }]);
    expect(firstEvent(events, "commandRejected")).toBeUndefined();
    expect(firstEvent(events, "shotFired")).toBeDefined();
  });

  it("empties a magazine and then reloads out of the reserve", () => {
    const h = harness();
    const shooter = h.team(0)[0]!;
    const target = h.team(1)[0]!;
    h.place(shooter.id, OPEN_GROUND);
    h.place(target.id, OPEN_GROUND);

    // Fire the magazine dry.
    h.run(rules.ENGAGEMENT_COOLDOWN_TICKS * rules.MAGAZINE_ROUNDS + 2, () => [
      { t: "engage", player: shooter.id, target: target.id },
    ]);
    expect(shooter.magazine).toBeLessThan(rules.MAGAZINE_ROUNDS);

    const reserveBefore = shooter.ammo;
    h.tick([{ t: "reload", player: shooter.id }]);
    expect(shooter.reloadingUntilTick).toBeGreaterThan(h.state.tick);

    // A reload takes real time, and the rounds come from somewhere.
    h.run(rules.RELOAD_TICKS + 2);
    expect(shooter.magazine).toBeGreaterThan(0);
    expect(shooter.ammo).toBeLessThan(reserveBefore);
  });

  it("puts a target down rather than killing outright", () => {
    const h = harness();
    const shooter = h.team(0)[0]!;
    const target = h.team(1)[0]!;
    h.place(shooter.id, OPEN_GROUND);
    h.place(target.id, OPEN_GROUND);

    const ticketsBefore = h.state.teams[1].tickets;
    const events = h.run(rules.secondsToTicks(60), () => [
      { t: "engage", player: shooter.id, target: target.id },
    ]);

    expect(firstEvent(events, "playerDowned")).toBeDefined();
    expect(target.status).not.toBe("alive");
    // No ticket is charged at the moment of going down.
    const downedAt = firstEvent(events, "playerDowned")!.tick;
    const ticketAtDown = eventsOfType(events, "ticketChange").find(
      (e) => e.tick === downedAt,
    );
    expect(ticketAtDown).toBeUndefined();
    expect(h.state.teams[1].tickets).toBeLessThanOrEqual(ticketsBefore);
  });
});

describe("downed soldiers", () => {
  it("costs a ticket only when they bleed out", () => {
    const h = harness();
    const casualty = h.team(1)[1]!;
    h.place(casualty.id, OPEN_GROUND);
    casualty.status = "downed";
    casualty.bleedoutAtTick = h.state.tick + rules.BLEEDOUT_TICKS;

    const before = h.state.teams[1].tickets;
    h.run(rules.BLEEDOUT_TICKS - 1);
    expect(h.state.teams[1].tickets).toBe(before);

    const events = h.run(2);
    expect(firstEvent(events, "playerDied")?.cause).toBe("bleedout");
    expect(h.state.teams[1].tickets).toBe(before - rules.TICKET_COST_INFANTRY_DEATH);
  });

  it("charges the commander double", () => {
    const h = harness();
    const commander = h.state.teams[1].commander;
    expect(commander).not.toBeNull();
    const casualty = h.player(commander!);
    casualty.status = "downed";
    casualty.bleedoutAtTick = h.state.tick;

    const before = h.state.teams[1].tickets;
    const events = h.run(2);

    expect(firstEvent(events, "ticketChange")?.reason).toBe("commanderDeath");
    expect(h.state.teams[1].tickets).toBe(before - rules.TICKET_COST_COMMANDER_DEATH);
  });

  it("charges immediately on giving up", () => {
    const h = harness();
    const casualty = h.team(1)[1]!;
    casualty.status = "downed";
    casualty.bleedoutAtTick = h.state.tick + rules.BLEEDOUT_TICKS;

    const before = h.state.teams[1].tickets;
    const events = h.tick([{ t: "giveUp", player: casualty.id }]);

    expect(firstEvent(events, "playerDied")?.cause).toBe("gaveUp");
    expect(h.state.teams[1].tickets).toBe(before - rules.TICKET_COST_INFANTRY_DEATH);
  });

  it("can be saved, and then costs nothing at all", () => {
    const h = harness();
    const medic = h.team(0)[1]!;
    const casualty = h.team(0)[2]!;
    h.place(medic.id, OPEN_GROUND);
    h.place(casualty.id, OPEN_GROUND);
    casualty.status = "downed";
    casualty.bleedoutAtTick = h.state.tick + rules.BLEEDOUT_TICKS;

    const before = h.state.teams[0].tickets;
    const events = h.run(rules.REVIVE_TICKS + 2, () => [
      { t: "revive", player: medic.id, target: casualty.id },
    ]);

    expect(firstEvent(events, "playerRevived")?.player).toBe(casualty.id);
    expect(casualty.status).toBe("alive");
    expect(casualty.health).toBe(rules.REVIVE_HEALTH);
    expect(h.state.teams[0].tickets).toBe(before);
  });

  it("loses revive progress the moment the medic stops working", () => {
    const h = harness();
    const medic = h.team(0)[1]!;
    const casualty = h.team(0)[2]!;
    h.place(medic.id, OPEN_GROUND);
    h.place(casualty.id, OPEN_GROUND);
    casualty.status = "downed";
    casualty.bleedoutAtTick = h.state.tick + rules.BLEEDOUT_TICKS;

    h.run(rules.REVIVE_TICKS - 5, () => [
      { t: "revive", player: medic.id, target: casualty.id },
    ]);
    expect(casualty.reviveProgressTicks).toBeGreaterThan(0);

    h.run(1);
    expect(casualty.reviveProgressTicks).toBe(0);
    expect(casualty.status).toBe("downed");
  });

  it("goes faster with more hands", () => {
    const h = harness();
    const casualty = h.team(0)[3]!;
    h.place(casualty.id, OPEN_GROUND);
    casualty.status = "downed";
    casualty.bleedoutAtTick = h.state.tick + rules.BLEEDOUT_TICKS;
    const helpers = [h.team(0)[1]!, h.team(0)[2]!];
    for (const helper of helpers) h.place(helper.id, OPEN_GROUND);

    const events = h.run(Math.ceil(rules.REVIVE_TICKS / 2) + 1, () =>
      helpers.map((p) => ({ t: "revive" as const, player: p.id, target: casualty.id })),
    );
    expect(firstEvent(events, "playerRevived")).toBeDefined();
  });
});

describe("dragging casualties", () => {
  function downedBeside(h: ReturnType<typeof harness>) {
    const carrier = h.team(0)[1]!;
    const casualty = h.team(0)[2]!;
    h.place(carrier.id, OPEN_GROUND);
    h.place(casualty.id, { x: OPEN_GROUND.x + 1, y: OPEN_GROUND.y });
    casualty.status = "downed";
    casualty.bleedoutAtTick = h.state.tick + rules.BLEEDOUT_TICKS;
    return { carrier, casualty };
  }

  it("hauls a body along behind you", () => {
    const h = harness();
    const { carrier, casualty } = downedBeside(h);

    h.tick([{ t: "drag", player: carrier.id, target: casualty.id }]);
    h.tick([{ t: "steer", player: carrier.id, dir: { x: 1, y: 0 } }]);
    h.run(rules.secondsToTicks(6));

    expect(carrier.pos.x).toBeGreaterThan(OPEN_GROUND.x + 2);
    // The body came too, trailing rather than riding on top of the carrier.
    expect(casualty.pos.x).toBeGreaterThan(OPEN_GROUND.x + 1);
    const gap = Math.hypot(casualty.pos.x - carrier.pos.x, casualty.pos.y - carrier.pos.y);
    expect(gap).toBeGreaterThan(0.5);
    expect(gap).toBeLessThan(2.5);
  });

  it("slows the carrier down", () => {
    const h = harness();
    const { carrier, casualty } = downedBeside(h);
    const free = h.team(0)[3]!;
    h.place(free.id, OPEN_GROUND);

    h.tick([{ t: "drag", player: carrier.id, target: casualty.id }]);
    h.tick([
      { t: "steer", player: carrier.id, dir: { x: 1, y: 0 } },
      { t: "steer", player: free.id, dir: { x: 1, y: 0 } },
    ]);
    h.run(rules.secondsToTicks(4));

    const hauled = carrier.pos.x - OPEN_GROUND.x;
    const unencumbered = free.pos.x - OPEN_GROUND.x;
    expect(hauled).toBeCloseTo(unencumbered * rules.DRAG_SPEED_MULTIPLIER, 1);
  });

  it("refuses a body out of reach", () => {
    const h = harness();
    const { carrier, casualty } = downedBeside(h);
    h.place(casualty.id, { x: OPEN_GROUND.x + rules.DRAG_REACH_M + 2, y: OPEN_GROUND.y });

    const events = h.tick([{ t: "drag", player: carrier.id, target: casualty.id }]);
    expect(firstEvent(events, "commandRejected")?.reason).toBe("outOfReach");
    expect(carrier.dragging).toBeNull();
  });

  it("lets only one pair of hands haul a body", () => {
    const h = harness();
    const { carrier, casualty } = downedBeside(h);
    const rival = h.team(0)[3]!;
    h.place(rival.id, OPEN_GROUND);

    h.tick([{ t: "drag", player: carrier.id, target: casualty.id }]);
    const events = h.tick([{ t: "drag", player: rival.id, target: casualty.id }]);

    expect(firstEvent(events, "commandRejected")?.reason).toBe("alreadyDragged");
    expect(rival.dragging).toBeNull();
    expect(carrier.dragging).toBe(casualty.id);
  });

  it("is dropped the moment the carrier goes down", () => {
    const h = harness();
    const { carrier, casualty } = downedBeside(h);
    h.tick([{ t: "drag", player: carrier.id, target: casualty.id }]);
    expect(carrier.dragging).toBe(casualty.id);

    carrier.health = 0;
    h.run(2);
    expect(carrier.dragging).toBeNull();
  });

  it("is dropped when the casualty is revived", () => {
    const h = harness();
    const { carrier, casualty } = downedBeside(h);
    h.tick([{ t: "drag", player: carrier.id, target: casualty.id }]);

    h.run(rules.REVIVE_TICKS + 2, () => [
      { t: "revive", player: carrier.id, target: casualty.id },
    ]);

    expect(casualty.status).toBe("alive");
    expect(carrier.dragging).toBeNull();
  });
});

describe("deploying", () => {
  it("makes you wait 45 s for a habitat and 15 s for main", () => {
    const h = harness();
    const player = h.team(0)[1]!;
    player.status = "deploying";
    player.deployingSinceTick = h.state.tick;

    const early = h.tick([
      { t: "spawn", player: player.id, source: { kind: "main" } },
    ]);
    expect(firstEvent(early, "commandRejected")?.reason).toBe("timerNotElapsed");

    h.run(rules.MAIN_BASE_SPAWN_DELAY_TICKS);
    const events = h.tick([
      { t: "spawn", player: player.id, source: { kind: "main" } },
    ]);
    expect(firstEvent(events, "playerSpawned")?.source).toBe("main");
    expect(player.status).toBe("alive");
    expect(player.pos).toEqual(h.state.teams[0].mainBase);
    expect(player.ammo).toBe(rules.PLAYER_MAX_AMMO);
  });

  it("refuses an overrun habitat", () => {
    const h = harness();
    const team = h.team(0);
    for (let i = 0; i < 3; i++) h.place(team[i]!.id, OPEN_GROUND);
    h.tick([{ t: "placeFob", player: team[0]!.id }]);
    const fob = h.state.fobs[0]!;
    fob.constructionPoints = rules.FOB_MAX_CONSTRUCTION_POINTS;
    h.tick([
      {
        t: "placeDeployable",
        player: team[0]!.id,
        fob: fob.id,
        kind: "habitat",
        pos: OPEN_GROUND,
      },
    ]);
    const habitat = h.state.deployables[0]!;
    h.run(rules.secondsToTicks(rules.DEPLOYABLE_SPECS.habitat.buildWorkSeconds) + 2, () => [
      { t: "build", player: team[0]!.id, deployable: habitat.id },
    ]);
    expect(habitat.built).toBe(true);

    for (let i = 0; i < rules.OVERRUN_CLOSE_ENEMY_COUNT; i++) {
      h.place(h.team(1)[i]!.id, habitat.pos);
    }
    h.run(rules.OVERRUN_EVAL_INTERVAL_TICKS * 2);
    expect(habitat.overrun).toBe(true);

    const casualty = team[4]!;
    casualty.status = "deploying";
    casualty.deployingSinceTick = h.state.tick;
    h.run(rules.HABITAT_SPAWN_DELAY_TICKS + 1);

    const events = h.tick([
      {
        t: "spawn",
        player: casualty.id,
        source: { kind: "habitat", deployable: habitat.id },
      },
    ]);
    expect(firstEvent(events, "commandRejected")?.reason).toBe("habitatNotLive");
  });
});

describe("resupply", () => {
  it("draws ammo out of the FOB's pool, and stops when it is dry", () => {
    const h = harness();
    const team = h.team(0);
    for (let i = 0; i < 3; i++) h.place(team[i]!.id, OPEN_GROUND);
    h.tick([{ t: "placeFob", player: team[0]!.id }]);
    const fob = h.state.fobs[0]!;
    fob.ammoPoints = rules.RESUPPLY_AMMO_PER_PULL;

    const soldier = team[1]!;
    soldier.ammo = 0;
    h.tick([{ t: "resupply", player: soldier.id }]);
    expect(soldier.ammo).toBe(rules.RESUPPLY_AMMO_PER_PULL);
    expect(fob.ammoPoints).toBe(0);

    soldier.ammo = 0;
    const events = h.tick([{ t: "resupply", player: soldier.id }]);
    expect(firstEvent(events, "commandRejected")?.reason).toBe("sourceEmpty");
    expect(soldier.ammo).toBe(0);
  });
});
