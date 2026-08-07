/**
 * Control points, the RAAS lane ordering rule, and ticket bleed. PLAN §2.1/§2.2.
 */

import { describe, expect, it } from "vitest";
import { World, canTeamContest, flagCounts, rules } from "../src/index.js";
import type { Command, ControlPoint, TeamId } from "../src/index.js";
import { eventsOfType, firstEvent, harness } from "./helpers.js";

/** Park `count` players of a team on a point and hold them there. */
function occupy(
  h: ReturnType<typeof harness>,
  team: TeamId,
  point: ControlPoint,
  count: number,
): void {
  const roster = h.team(team);
  for (let i = 0; i < count; i++) {
    const player = roster[i];
    if (player !== undefined) h.place(player.id, point.pos);
  }
}

/** Move everyone else far away so they cannot contest anything. */
function clearMap(h: ReturnType<typeof harness>): void {
  for (const player of h.state.players) {
    h.place(player.id, { x: 0, y: 0 });
  }
}

const HOLD: (tick: number) => Command[] = () => [];

describe("lane ordering", () => {
  it("lets team 0 attack only the first point it does not hold", () => {
    const h = harness();
    const points = h.state.controlPoints;
    expect(canTeamContest(points, 1, 0)).toBe(true); // point 0 is theirs at kick-off
    expect(canTeamContest(points, 2, 0)).toBe(false); // point 1 is still neutral
    expect(canTeamContest(points, points.length - 1, 0)).toBe(false);
  });

  it("mirrors the rule for team 1", () => {
    const h = harness();
    const points = h.state.controlPoints;
    const last = points.length - 1;
    expect(canTeamContest(points, last - 1, 1)).toBe(true);
    expect(canTeamContest(points, last - 2, 1)).toBe(false);
  });

  it("refuses to advance the front while a point behind is only neutral", () => {
    const h = harness();
    clearMap(h);
    const points = h.state.controlPoints;
    const second = points[1]!;
    const third = points[2]!;

    // Sit on the third point without ever taking the second.
    occupy(h, 0, third, 3);
    h.run(rules.secondsToTicks(rules.CAPTURE_DURATION_S * 3), HOLD);

    expect(third.owner).toBeNull();
    expect(third.progress).toBe(0);
    expect(second.owner).toBeNull();
  });
});

describe("capture mechanics", () => {
  it("takes a neutral point in 30 seconds with one attacker", () => {
    const h = harness();
    clearMap(h);
    const target = h.state.controlPoints[1]!;
    occupy(h, 0, target, 1);

    const events = h.run(rules.CAPTURE_TICKS + rules.CAPTURE_EVAL_INTERVAL_TICKS, HOLD);
    const captured = firstEvent(events, "controlPointCaptured");

    expect(captured?.point).toBe(target.id);
    expect(captured?.by).toBe(0);
    expect(target.owner).toBe(0);
  });

  it("needs two passes to take an owned point: neutralise, then capture", () => {
    const h = harness();
    clearMap(h);
    const points = h.state.controlPoints;
    const contested = points[points.length - 1]!; // team 1 starts holding this
    occupy(h, 1, points[points.length - 2]!, 0);
    occupy(h, 0, contested, 3);

    // Team 0 cannot even reach it yet — everything behind must be theirs.
    expect(canTeamContest(points, points.length - 1, 0)).toBe(false);

    // Hand team 0 the whole lane behind the last point.
    for (let i = 0; i < points.length - 1; i++) {
      points[i]!.owner = 0;
    }

    const events = h.run(
      rules.NEUTRALISE_TICKS + rules.CAPTURE_TICKS + rules.CAPTURE_EVAL_INTERVAL_TICKS * 2,
      HOLD,
    );

    const neutralised = firstEvent(events, "controlPointNeutralised");
    const captured = firstEvent(events, "controlPointCaptured");
    expect(neutralised?.formerOwner).toBe(1);
    expect(captured?.by).toBe(0);
    expect(neutralised!.tick).toBeLessThan(captured!.tick);
  });

  it("goes faster with a numeric advantage", () => {
    const soloTicks = ticksToCapture(1);
    const squadTicks = ticksToCapture(4);
    expect(squadTicks).toBeLessThan(soloTicks);
  });

  it("does not move while the flag is evenly contested", () => {
    const h = harness();
    clearMap(h);
    const target = h.state.controlPoints[1]!;
    occupy(h, 0, target, 3);
    occupy(h, 1, target, 3);

    h.run(rules.CAPTURE_TICKS * 2, HOLD);

    expect(target.owner).toBeNull();
    expect(target.progress).toBe(0);
  });

  it("unwinds progress when the attackers leave", () => {
    const h = harness();
    clearMap(h);
    const target = h.state.controlPoints[1]!;
    occupy(h, 0, target, 1);
    h.run(Math.floor(rules.CAPTURE_TICKS / 2), HOLD);
    const peak = target.progress;
    expect(peak).toBeGreaterThan(0);

    clearMap(h);
    h.run(rules.CAPTURE_TICKS * 2, HOLD);
    expect(target.progress).toBe(0);
    expect(target.owner).toBeNull();
  });
});

describe("tickets", () => {
  it("pays 20 tickets the first time a point is ever taken, once only", () => {
    const h = harness();
    clearMap(h);
    const target = h.state.controlPoints[1]!;
    const before = h.state.teams[0].tickets;

    occupy(h, 0, target, 3);
    h.run(rules.CAPTURE_TICKS + rules.CAPTURE_EVAL_INTERVAL_TICKS, HOLD);
    expect(h.state.teams[0].tickets).toBe(before + rules.TICKET_GAIN_FIRST_CAPTURE);

    // Lose it and take it back: no second payout.
    clearMap(h);
    occupy(h, 1, target, 3);
    h.run(rules.NEUTRALISE_TICKS + rules.CAPTURE_TICKS + rules.CAPTURE_EVAL_INTERVAL_TICKS * 2, HOLD);
    clearMap(h);
    occupy(h, 0, target, 3);
    const events = h.run(
      rules.NEUTRALISE_TICKS + rules.CAPTURE_TICKS + rules.CAPTURE_EVAL_INTERVAL_TICKS * 2,
      HOLD,
    );

    const bonuses = eventsOfType(events, "ticketChange").filter(
      (e) => e.reason === "firstCapture",
    );
    expect(bonuses).toHaveLength(0);
  });

  it("bleeds the team that is behind on flags", () => {
    const h = harness();
    clearMap(h);
    const points = h.state.controlPoints;
    points[1]!.owner = 0;
    points[2]!.owner = 0;

    const counts = flagCounts(new World(h.state));
    const lead = counts[0] - counts[1];
    const minutes = 4;

    const before = h.state.teams[1].tickets;
    h.run(rules.secondsToTicks(rules.SECONDS_PER_MINUTE * minutes), HOLD);

    // Bleed accrues fractionally and only ever spends whole tickets, so the
    // count trails the exact rate by up to one ticket at any instant. The
    // remainder is carried, so the error does not compound.
    const lost = before - h.state.teams[1].tickets;
    const expected = rules.BLEED_TICKETS_PER_FLAG_LEAD_PER_MINUTE * lead * minutes;
    expect(lost).toBeGreaterThan(expected - 2);
    expect(lost).toBeLessThanOrEqual(expected);
  });

  it("drains 60 tickets a minute once one team owns the whole lane", () => {
    const h = harness();
    clearMap(h);
    for (const point of h.state.controlPoints) point.owner = 0;

    const before = h.state.teams[1].tickets;
    const events = h.run(rules.secondsToTicks(rules.MERCY_BLEED_DURATION_S), HOLD);

    expect(firstEvent(events, "mercyBleedStarted")?.bleeding).toBe(1);
    const lost = before - h.state.teams[1].tickets;
    expect(lost).toBeCloseTo(rules.MERCY_BLEED_TOTAL_TICKETS, -1);
  });

  it("pauses all bleed during a double neutral", () => {
    const h = harness();
    clearMap(h);
    const points = h.state.controlPoints;
    // Team 0 leads on flags, but two points sit neutral: the front is unclear.
    points[0]!.owner = 0;
    points[1]!.owner = 0;
    points[2]!.owner = null;
    points[3]!.owner = null;
    points[4]!.owner = 1;

    h.run(rules.CAPTURE_EVAL_INTERVAL_TICKS * 2, HOLD);
    expect(h.state.doubleNeutral).toBe(true);

    const before = h.state.teams[1].tickets;
    h.run(rules.secondsToTicks(rules.SECONDS_PER_MINUTE * 2), HOLD);
    expect(h.state.teams[1].tickets).toBe(before);
  });

  it("resumes bleed when the stalemate resolves", () => {
    const h = harness();
    clearMap(h);
    const points = h.state.controlPoints;
    points[0]!.owner = 0;
    points[1]!.owner = 0;
    points[2]!.owner = null;
    points[3]!.owner = null;
    points[4]!.owner = 1;
    h.run(rules.CAPTURE_EVAL_INTERVAL_TICKS * 2, HOLD);
    expect(h.state.doubleNeutral).toBe(true);

    points[2]!.owner = 0;
    h.run(rules.CAPTURE_EVAL_INTERVAL_TICKS * 2, HOLD);
    expect(h.state.doubleNeutral).toBe(false);

    const before = h.state.teams[1].tickets;
    h.run(rules.secondsToTicks(rules.SECONDS_PER_MINUTE), HOLD);
    expect(h.state.teams[1].tickets).toBeLessThan(before);
  });
});

describe("match end", () => {
  it("ends the moment a team runs out of tickets", () => {
    const h = harness();
    clearMap(h);
    h.state.teams[1].tickets = 1;
    for (const point of h.state.controlPoints) point.owner = 0;

    const events = h.run(rules.secondsToTicks(rules.SECONDS_PER_MINUTE), HOLD);
    const ended = firstEvent(events, "matchEnded");

    expect(ended?.winner).toBe(0);
    expect(h.state.phase).toBe("finished");
    expect(h.state.teams[1].tickets).toBe(0);
  });

  it("stops evolving once finished", () => {
    const h = harness();
    h.state.teams[1].tickets = 0;
    h.run(1, HOLD);
    expect(h.state.phase).toBe("finished");

    const tickBefore = h.state.tick;
    const events = h.run(100, HOLD);
    expect(h.state.tick).toBe(tickBefore);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

function ticksToCapture(attackers: number): number {
  const h = harness({ playersPerTeam: Math.max(attackers, 3) });
  for (const player of h.state.players) h.place(player.id, { x: 0, y: 0 });
  const target = h.state.controlPoints[1]!;
  for (let i = 0; i < attackers; i++) {
    h.place(h.team(0)[i]!.id, target.pos);
  }
  const start = h.state.tick;
  const events = h.run(rules.CAPTURE_TICKS * 2, HOLD);
  const captured = firstEvent(events, "controlPointCaptured");
  expect(captured).toBeDefined();
  return captured!.tick - start;
}
