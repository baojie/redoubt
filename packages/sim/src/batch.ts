/**
 * Batch balance statistics.
 *
 * This is the instrument PLAN §5 M1 sets its acceptance gate on: 1000 matches,
 * no crashes, no deadlocks, 30-60 minute average length, 45-55% win split.
 * It is wired up now so M0's numbers are visible from day one and the gate has
 * something to measure against.
 */

import { rules, type TeamId } from "@redoubt/core";
import { runMatch } from "./runMatch.js";
import type { MatchStats } from "./report.js";

export interface BatchSummary {
  matches: number;
  wins: [number, number];
  draws: number;
  durationMinutes: { mean: number; min: number; max: number; withinTarget: number };
  meanFinalTickets: [number, number];
  meanFobsPlaced: [number, number];
  meanFobLifetimeMinutes: [number, number];
  /** How many matches saw a FOB die at all — the denominator for the above. */
  matchesWithAFobLost: [number, number];
  meanRalliesPlaced: [number, number];
  spawnMix: { main: number; rally: number; habitat: number };
  meanConstructionDelivered: [number, number];
  endedByTickets: number;
  endedByTimeLimit: number;
}

const TARGET_MIN_MINUTES = 30;
const TARGET_MAX_MINUTES = 60;

export function runBatch(firstSeed: number, matches: number): BatchSummary {
  const results: MatchStats[] = [];
  for (let i = 0; i < matches; i++) {
    results.push(runMatch({ seed: firstSeed + i }).stats);
  }
  return summarise(results);
}

function avg(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function perTeam(results: readonly MatchStats[], pick: (s: MatchStats, t: TeamId) => number): [number, number] {
  return [avg(results.map((r) => pick(r, 0))), avg(results.map((r) => pick(r, 1)))];
}

export function summarise(results: readonly MatchStats[]): BatchSummary {
  const minutes = results.map(
    (r) => rules.ticksToSeconds(r.durationTicks) / rules.SECONDS_PER_MINUTE,
  );
  const wins: [number, number] = [0, 0];
  let draws = 0;
  let endedByTickets = 0;
  let endedByTimeLimit = 0;
  for (const r of results) {
    if (r.winner === null) draws++;
    else wins[r.winner]++;
    if (r.endReason.startsWith("tickets")) endedByTickets++;
    else endedByTimeLimit++;
  }

  const spawnMain = results.reduce(
    (n, r) => n + r.teams[0].spawnsFromMain + r.teams[1].spawnsFromMain,
    0,
  );
  const spawnRally = results.reduce(
    (n, r) => n + r.teams[0].spawnsFromRally + r.teams[1].spawnsFromRally,
    0,
  );
  const spawnHab = results.reduce(
    (n, r) => n + r.teams[0].spawnsFromHabitat + r.teams[1].spawnsFromHabitat,
    0,
  );
  const spawnTotal = Math.max(1, spawnMain + spawnRally + spawnHab);

  // Average only over matches where a FOB actually died. Folding in a zero for
  // every FOB that survived would report "0 minutes" for a FOB that lived the
  // whole match — the exact opposite of the truth.
  const endedLifetimes = (t: TeamId): number[] =>
    results
      .filter((r) => r.teams[t].fobLifetimeTicks.length > 0)
      .map(
        (r) =>
          rules.ticksToSeconds(avg(r.teams[t].fobLifetimeTicks)) /
          rules.SECONDS_PER_MINUTE,
      );
  const fobsDestroyed: [number, number] = [
    endedLifetimes(0).length,
    endedLifetimes(1).length,
  ];

  return {
    matches: results.length,
    wins,
    draws,
    durationMinutes: {
      mean: avg(minutes),
      min: minutes.length === 0 ? 0 : Math.min(...minutes),
      max: minutes.length === 0 ? 0 : Math.max(...minutes),
      withinTarget: minutes.filter(
        (m) => m >= TARGET_MIN_MINUTES && m <= TARGET_MAX_MINUTES,
      ).length,
    },
    meanFinalTickets: perTeam(results, (r, t) => r.teams[t].finalTickets),
    meanFobsPlaced: perTeam(results, (r, t) => r.teams[t].fobsPlaced),
    meanFobLifetimeMinutes: [avg(endedLifetimes(0)), avg(endedLifetimes(1))],
    matchesWithAFobLost: fobsDestroyed,
    meanRalliesPlaced: perTeam(results, (r, t) => r.teams[t].ralliesPlaced),
    spawnMix: {
      main: spawnMain / spawnTotal,
      rally: spawnRally / spawnTotal,
      habitat: spawnHab / spawnTotal,
    },
    meanConstructionDelivered: perTeam(
      results,
      (r, t) => r.teams[t].constructionPointsDelivered,
    ),
    endedByTickets,
    endedByTimeLimit,
  };
}

export function formatBatch(summary: BatchSummary): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];
  const total = Math.max(1, summary.matches);

  lines.push("=".repeat(72));
  lines.push(`  BATCH SUMMARY   ${summary.matches} matches`);
  lines.push("=".repeat(72));
  lines.push("");
  lines.push(
    `Win split       BLUE ${pct(summary.wins[0] / total)}   ` +
      `RED ${pct(summary.wins[1] / total)}   draws ${summary.draws}`,
  );
  lines.push(
    `Match length    mean ${summary.durationMinutes.mean.toFixed(1)} min   ` +
      `min ${summary.durationMinutes.min.toFixed(1)}   ` +
      `max ${summary.durationMinutes.max.toFixed(1)}`,
  );
  lines.push(
    `  in 30-60 min  ${summary.durationMinutes.withinTarget}/${summary.matches}` +
      ` (${pct(summary.durationMinutes.withinTarget / total)})`,
  );
  lines.push(
    `Ended by        tickets ${summary.endedByTickets}   time limit ${summary.endedByTimeLimit}`,
  );
  lines.push("");
  lines.push(
    `Final tickets   BLUE ${summary.meanFinalTickets[0].toFixed(0)}   ` +
      `RED ${summary.meanFinalTickets[1].toFixed(0)}`,
  );
  lines.push(
    `FOBs placed     BLUE ${summary.meanFobsPlaced[0].toFixed(1)}   ` +
      `RED ${summary.meanFobsPlaced[1].toFixed(1)}`,
  );
  const lifetime = (team: 0 | 1): string =>
    summary.matchesWithAFobLost[team] === 0
      ? "never lost"
      : `${summary.meanFobLifetimeMinutes[team].toFixed(1)} min ` +
        `(in ${summary.matchesWithAFobLost[team]} matches)`;
  lines.push(`FOB lifetime    BLUE ${lifetime(0)}   RED ${lifetime(1)}`);
  lines.push(
    `Rallies placed  BLUE ${summary.meanRalliesPlaced[0].toFixed(1)}   ` +
      `RED ${summary.meanRalliesPlaced[1].toFixed(1)}`,
  );
  lines.push(
    `Supply run      BLUE ${summary.meanConstructionDelivered[0].toFixed(0)} CP   ` +
      `RED ${summary.meanConstructionDelivered[1].toFixed(0)} CP`,
  );
  lines.push(
    `Spawn mix       main ${pct(summary.spawnMix.main)}   ` +
      `rally ${pct(summary.spawnMix.rally)}   habitat ${pct(summary.spawnMix.habitat)}`,
  );
  lines.push("");
  return lines.join("\n");
}
