/**
 * The balance gate from CLAUDE.md, wired into `pnpm test`.
 *
 * PLAN §5 M1 sets the bar: a batch of matches with no crashes, no deadlocks,
 * average length in the 30-60 minute band, and a win split inside 45-55%. The
 * batch here is smaller than the 1000-match run so the suite stays fast; run
 * `pnpm sim --matches 1000` before believing a balance change.
 */

import { describe, expect, it } from "vitest";
import { RIVERBEND, rules } from "@redoubt/core";
import { runBatch, runPerLane } from "../src/batch.js";
import { runMatch } from "../src/runMatch.js";

const GATE_MATCHES = 120;
const FIRST_SEED = 1;
/**
 * Per lane, so the suite stays quick. Wide tolerances at this sample size —
 * this catches a broken map, not a two-point imbalance. Use
 * `pnpm sim --matches 250 --per-lane` when tuning.
 */
const LANE_GATE_MATCHES = 60;

describe("balance gate", () => {
  const summary = runBatch(FIRST_SEED, GATE_MATCHES);

  it("never crashes or deadlocks", () => {
    expect(summary.matches).toBe(GATE_MATCHES);
    // A match that hit the hard cap is a stalled economy, not a real draw.
    expect(summary.endedByTimeLimit).toBe(0);
    expect(summary.durationMinutes.min).toBeGreaterThan(0);
  });

  it("lands the average match length in the 30-60 minute band", () => {
    expect(summary.durationMinutes.mean).toBeGreaterThanOrEqual(30);
    expect(summary.durationMinutes.mean).toBeLessThanOrEqual(60);
  });

  it("is symmetric between the two sides", () => {
    const blueWinRate = summary.wins[0] / summary.matches;
    expect(blueWinRate).toBeGreaterThanOrEqual(0.4);
    expect(blueWinRate).toBeLessThanOrEqual(0.6);
  });

  it("actually exercises the spawn economy it is supposed to measure", () => {
    // If everyone walked from main all game, the numbers above would be
    // measuring a different game than the one the design describes.
    expect(summary.spawnMix.rally).toBeGreaterThan(0.1);
    expect(summary.spawnMix.habitat).toBeGreaterThan(0.1);
    expect(summary.meanConstructionDelivered[0]).toBeGreaterThan(
      rules.DEPLOYABLE_SPECS.habitat.constructionCost,
    );
  });
});

describe("per-lane fairness", () => {
  // The gate that actually matters, and the one this project learned the hard
  // way. An aggregate win rate cannot see an unfair map: the original layout
  // measured 49.8% / 50.2% over a thousand matches while its four lanes ran
  // 13/87, 79/21, 64/36 and 41/59 — every match unfair, the biases cancelling.
  // A layer is played one match at a time.
  const perLane = runPerLane(
    FIRST_SEED,
    LANE_GATE_MATCHES,
    RIVERBEND.lanes.map((l) => l.name),
  );

  it("gives neither side an edge on any single lane", () => {
    for (const { lane, summary } of perLane) {
      const blue = summary.wins[0] / summary.matches;
      expect(blue, `lane ${lane} favours BLUE`).toBeLessThan(0.65);
      expect(blue, `lane ${lane} favours RED`).toBeGreaterThan(0.35);
    }
  });

  it("keeps every lane inside the match-length band on average", () => {
    for (const { lane, summary } of perLane) {
      expect(summary.durationMinutes.mean, `lane ${lane}`).toBeGreaterThanOrEqual(25);
      expect(summary.durationMinutes.mean, `lane ${lane}`).toBeLessThanOrEqual(60);
    }
  });
});

describe("match reproducibility", () => {
  it("gives byte-identical results for a repeated seed", () => {
    const a = runMatch({ seed: 4242 }).stats;
    const b = runMatch({ seed: 4242 }).stats;
    expect(a.finalHash).toBe(b.finalHash);
    expect(a.durationTicks).toBe(b.durationTicks);
    expect(a.winner).toBe(b.winner);
    expect(a.teams[0].finalTickets).toBe(b.teams[0].finalTickets);
  });

  it("honours a forced lane", () => {
    const result = runMatch({ seed: 9, laneName: "Valley" });
    expect(result.stats.lane).toBe("Valley");
  });
});
