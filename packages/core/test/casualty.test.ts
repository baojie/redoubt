/**
 * Casualties, revives and the spawn economy — the part of the design where a
 * body is only worth a ticket once nobody comes for it.
 */

import { describe, expect, it } from "vitest";
import { distance, rules, type Command, type GameEvent } from "../src/index.js";
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
    // Near the main base, not exactly on it: a wave that all arrives at one
    // coordinate stacks, and stacked bodies are hidden by the renderer's
    // don't-draw-the-inside-of-a-teammate's-head rule.
    const base = h.state.teams[0].mainBase;
    expect(distance(player.pos, base)).toBeLessThanOrEqual(rules.SPAWN_SCATTER_RADIUS_M);
    expect(player.ammo).toBe(rules.PLAYER_MAX_AMMO);
  });

  it("stops damage outright while invulnerable, and only while", () => {
    // A playtest affordance, so what matters is that it is genuinely the
    // damage that stops and nothing else: the command has to be what turns it
    // on, and an ordinary soldier under the same fire has to still go down —
    // otherwise the test would pass just as well against a broken rifle.
    const underFire = (invulnerable: boolean) => {
      const h = harness();
      const victim = h.team(0)[0]!;
      const shooter = h.team(1)[0]!;
      // Out on the open ground by a main base. The middle of the map is not
      // open — the first version of this stood both men inside a building, and
      // every round was stopped by the wall they were standing in: `from` and
      // `to` came back identical, and the control case looked invulnerable too.
      const base = h.state.teams[0].mainBase;
      h.place(victim.id, { x: base.x + 20, y: base.y });
      h.place(shooter.id, { x: base.x + 32, y: base.y });
      if (invulnerable) {
        h.tick([{ t: "setInvulnerable", player: victim.id, on: true }]);
        expect(victim.invulnerable).toBe(true);
      }
      h.run(rules.secondsToTicks(30), () => [
        { t: "look", player: shooter.id, yaw: Math.PI, pitch: 0 },
        { t: "fire", player: shooter.id },
      ]);
      return victim;
    };

    const protected_ = underFire(true);
    expect(protected_.health).toBe(rules.PLAYER_MAX_HEALTH);
    expect(protected_.status).toBe("alive");
    expect(protected_.lastHitBy).toBeNull();

    // The control: identical fire, no flag. If this one survived unhurt the
    // test above would prove nothing at all.
    const ordinary = underFire(false);
    expect(ordinary.health).toBeLessThan(rules.PLAYER_MAX_HEALTH);
    expect(ordinary.status).not.toBe("alive");
  });

  it("keeps a soldier firing while infiniteAmmo is set, and only then", () => {
    // The same shape of test as the invulnerability one above, and for the same
    // reason: "still has ammo after a minute" would pass just as well against a
    // rifle that never fired a round. So the control has to demonstrate both
    // that the rifle works and that it genuinely runs dry.
    const emptyMagazines = (infinite: boolean) => {
      const h = harness();
      const shooter = h.team(0)[0]!;
      const target = h.team(1)[0]!;
      // Open ground by a main base. Standing them in the middle of the map puts
      // both inside a building, and every round stops in the wall.
      const base = h.state.teams[0].mainBase;
      h.place(shooter.id, { x: base.x + 20, y: base.y });
      h.place(target.id, { x: base.x + 60, y: base.y });
      target.invulnerable = true; // Keep the target up, so firing never stops for want of one.

      if (infinite) {
        h.tick([{ t: "setInfiniteAmmo", player: shooter.id, on: true }]);
        expect(shooter.infiniteAmmo).toBe(true);
      }

      const fire = () => [
        { t: "look", player: shooter.id, yaw: 0, pitch: 0 } as Command,
        { t: "fire", player: shooter.id } as Command,
      ];
      const shotsBy = (events: GameEvent[]) =>
        events.filter((e) => e.t === "shotFired" && e.shooter === shooter.id).length;

      // Long enough that a full magazine and a full reserve are spent — a
      // soldier carries 130 rounds and fires them in a little over a minute —
      // then a final window to see whether anything is left.
      const early = shotsBy(h.run(rules.secondsToTicks(10), fire));
      h.run(rules.secondsToTicks(100), fire);
      const late = shotsBy(h.run(rules.secondsToTicks(20), fire));
      return { shooter, earlyShots: early, lateShots: late };
    };

    const supplied = emptyMagazines(true);
    expect(supplied.shooter.ammo).toBe(rules.PLAYER_MAX_AMMO);
    // Still shooting at the end of the run, which is the whole point.
    expect(supplied.lateShots).toBeGreaterThan(0);

    // The control: same fire, no flag. It has to have fired plenty at first —
    // otherwise this proves nothing about the rifle — and then stopped.
    const ordinary = emptyMagazines(false);
    expect(ordinary.earlyShots).toBeGreaterThan(0);
    expect(ordinary.shooter.ammo).toBe(0);
    expect(ordinary.lateShots).toBe(0);
  });

  it("kills with a grenade, and cover is the answer to one", () => {
    // Same discipline as the invulnerability and infinite-ammo tests: a blast
    // that "did damage" proves nothing unless a control shows what the damage
    // depends on. Here the control is a victim behind a wall — if that one also
    // died, the cover test would be passing against a grenade that ignores
    // geometry entirely.
    const blast = (behindCover: boolean) => {
      const h = harness();
      const thrower = h.team(0)[0]!;
      const victim = h.team(1)[0]!;
      const base = h.state.teams[0].mainBase;

      // A lofted throw carries about twenty metres — it is not a thing you drop
      // at your own feet — so both cases put the target at the range the throw
      // actually reaches. The first version stood them six metres apart and the
      // grenade sailed clean over the victim and exploded in empty ground.
      const THROW_REACH_M = 21;
      const FLAT_REACH_M = 10;
      if (behindCover) {
        // Thrown flat so it lands *short* of the wall, with the victim just
        // behind it. Lofted, the grenade clears the wall and goes off beside
        // them — which is the correct behaviour and the whole reason grenades
        // beat cover, but it means a lofted throw cannot test the shielding
        // rule. The first version of this did exactly that and the "sheltered"
        // victim was killed outright.
        const wall = h.state.map.cover.find((c) => c.kind === "wall" && c.halfWidth > 10)!;
        h.place(thrower.id, { x: wall.x, y: wall.y - wall.halfDepth - FLAT_REACH_M });
        h.place(victim.id, { x: wall.x, y: wall.y + wall.halfDepth + 2 });
      } else {
        h.place(thrower.id, { x: base.x + 20, y: base.y });
        h.place(victim.id, { x: base.x + 20 + THROW_REACH_M, y: base.y });
      }

      const before = victim.health;
      h.tick([
        {
          t: "look",
          player: thrower.id,
          yaw: Math.atan2(victim.pos.y - thrower.pos.y, victim.pos.x - thrower.pos.x),
          // Cancelling the throw's own loft gives a flat throw, which lands
          // about half as far.
          pitch: behindCover ? -rules.GRENADE_THROW_PITCH_RAD : 0,
        },
      ]);
      const thrown = h.tick([{ t: "throwGrenade", player: thrower.id }]);
      expect(firstEvent(thrown, "grenadeThrown")).toBeDefined();
      expect(thrower.grenades).toBe(rules.GRENADES_PER_SOLDIER - 1);

      // Long enough for the fuse, whatever it is set to.
      const events = h.run(rules.GRENADE_FUSE_TICKS + 5);
      const blastAt = firstEvent(events, "grenadeExploded");
      expect(blastAt).toBeDefined();
      return { victim, before, blastAt: blastAt!.at };
    };

    const open = blast(false);
    expect(open.victim.health).toBeLessThan(open.before);

    // Behind a wall: shaken, not killed.
    const sheltered = blast(true);
    // Assert the premise, not just the conclusion. If the grenade sailed over
    // and landed beside the victim, this test would be quietly proving nothing
    // about cover — so check the blast really was on the far side of the wall.
    expect(sheltered.blastAt.y).toBeLessThan(sheltered.victim.pos.y);
    expect(sheltered.victim.status).toBe("alive");
    expect(sheltered.victim.suppression).toBeGreaterThan(0);
  });

  it("runs out of grenades, and gets them back on resupply", () => {
    const h = harness();
    const thrower = h.team(0)[0]!;
    const base = h.state.teams[0].mainBase;
    h.place(thrower.id, { x: base.x + 20, y: base.y });

    for (let i = 0; i < rules.GRENADES_PER_SOLDIER; i++) {
      h.tick([{ t: "throwGrenade", player: thrower.id }]);
    }
    expect(thrower.grenades).toBe(0);

    // A fourth throw is refused rather than silently doing nothing.
    const denied = h.tick([{ t: "throwGrenade", player: thrower.id }]);
    expect(firstEvent(denied, "commandRejected")?.reason).toBe("noGrenades");

    // Standing in the main base and pulling supply puts them back.
    h.place(thrower.id, { x: base.x, y: base.y });
    h.tick([{ t: "resupply", player: thrower.id }]);
    expect(thrower.grenades).toBe(rules.GRENADES_PER_SOLDIER);
  });

  it("does not stack a whole wave on one coordinate", () => {
    // The renderer hides a body within about a metre of the camera, so that a
    // teammate walking onto you does not fill the screen with the inside of
    // their head. A wave that all arrives at the identical point is therefore a
    // wave that is not merely ugly but invisible: spawning at main next to
    // eleven teammates looked exactly like spawning alone.
    const h = harness();
    const wave = h.team(0).slice(0, 8);
    for (const player of wave) {
      player.status = "deploying";
      player.deployingSinceTick = h.state.tick;
    }
    h.run(rules.MAIN_BASE_SPAWN_DELAY_TICKS);
    h.tick(wave.map((p) => ({ t: "spawn" as const, player: p.id, source: { kind: "main" as const } })));

    const base = h.state.teams[0].mainBase;
    for (const player of wave) {
      expect(player.status).toBe("alive");
      expect(distance(player.pos, base)).toBeLessThanOrEqual(rules.SPAWN_SCATTER_RADIUS_M);
    }

    const places = new Set(wave.map((p) => `${p.pos.x},${p.pos.y}`));
    expect(places.size).toBe(wave.length);
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
