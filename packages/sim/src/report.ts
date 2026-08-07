/**
 * Battle report.
 *
 * The entire point of M0 is that this file tells you whether the rules are
 * right without anyone having to look at a screen. Read the ticket curve, the
 * FOB lifetimes and the spawn mix, and you can tell whether the economy is
 * behaving like the design says it should.
 */

import { rules, type GameEvent, type TeamId } from "@redoubt/core";

export interface TeamStats {
  finalTickets: number;
  deaths: number;
  gaveUp: number;
  revives: number;
  fobsPlaced: number;
  fobsLostToEnemy: number;
  fobsSelfDismantled: number;
  fobLifetimeTicks: number[];
  habitatsBuilt: number;
  ralliesPlaced: number;
  ralliesOverrun: number;
  spawnsFromMain: number;
  spawnsFromRally: number;
  spawnsFromHabitat: number;
  constructionPointsDelivered: number;
  ammoPointsDelivered: number;
  firstCaptureBonuses: number;
  ticketsLostToBleed: number;
  ticketsLostToDeaths: number;
  ticketsLostToFobs: number;
}

export interface FlagEvent {
  tick: number;
  kind: "neutralised" | "captured";
  point: number;
  by: TeamId;
}

export interface MatchStats {
  seed: number;
  map: string;
  lane: string;
  pointNames: Map<number, string>;
  durationTicks: number;
  winner: TeamId | null;
  endReason: string;
  ticketTimeline: Array<{ minute: number; tickets: [number, number]; flags: [number, number] }>;
  flagEvents: FlagEvent[];
  habitatBuilds: Array<{ tick: number; team: TeamId; builders: number; buildSeconds: number }>;
  teams: [TeamStats, TeamStats];
  doubleNeutralTicks: number;
  mercyBleedTicks: number;
  rejections: Map<string, number>;
  finalHash: number;
}

export function emptyTeamStats(): TeamStats {
  return {
    finalTickets: 0,
    deaths: 0,
    gaveUp: 0,
    revives: 0,
    fobsPlaced: 0,
    fobsLostToEnemy: 0,
    fobsSelfDismantled: 0,
    fobLifetimeTicks: [],
    habitatsBuilt: 0,
    ralliesPlaced: 0,
    ralliesOverrun: 0,
    spawnsFromMain: 0,
    spawnsFromRally: 0,
    spawnsFromHabitat: 0,
    constructionPointsDelivered: 0,
    ammoPointsDelivered: 0,
    firstCaptureBonuses: 0,
    ticketsLostToBleed: 0,
    ticketsLostToDeaths: 0,
    ticketsLostToFobs: 0,
  };
}

/** Fold one tick's events into the running stats. */
export function accumulate(stats: MatchStats, events: readonly GameEvent[]): void {
  for (const event of events) {
    switch (event.t) {
      case "ticketChange": {
        const team = stats.teams[event.team];
        if (event.reason === "firstCapture") team.firstCaptureBonuses += event.delta;
        else if (event.reason === "positionalBleed" || event.reason === "mercyBleed") {
          team.ticketsLostToBleed -= event.delta;
        } else if (event.reason === "fobRadioDestroyed") team.ticketsLostToFobs -= event.delta;
        else team.ticketsLostToDeaths -= event.delta;
        break;
      }
      case "playerDied": {
        const team = stats.teams[event.team];
        team.deaths++;
        if (event.cause === "gaveUp") team.gaveUp++;
        break;
      }
      case "playerRevived":
        stats.teams[event.team].revives++;
        break;
      case "playerSpawned": {
        const team = stats.teams[event.team];
        if (event.source === "main") team.spawnsFromMain++;
        else if (event.source === "rally") team.spawnsFromRally++;
        else team.spawnsFromHabitat++;
        break;
      }
      case "fobPlaced":
        stats.teams[event.team].fobsPlaced++;
        break;
      case "fobDestroyed": {
        const team = stats.teams[event.team];
        if (event.selfDismantled) team.fobsSelfDismantled++;
        else team.fobsLostToEnemy++;
        team.fobLifetimeTicks.push(event.lifetimeTicks);
        break;
      }
      case "deployableBuilt":
        if (event.kind === "habitat") {
          stats.teams[event.team].habitatsBuilt++;
          stats.habitatBuilds.push({
            tick: event.tick,
            team: event.team,
            builders: event.builders,
            buildSeconds: rules.ticksToSeconds(event.buildTicks),
          });
        }
        break;
      case "rallyPlaced":
        stats.teams[event.team].ralliesPlaced++;
        break;
      case "rallyDestroyed":
        if (event.byEnemy) stats.teams[event.team].ralliesOverrun++;
        break;
      case "supplyUnloaded": {
        const team = stats.teams[event.team];
        team.constructionPointsDelivered += event.constructionPoints;
        team.ammoPointsDelivered += event.ammoPoints;
        break;
      }
      case "controlPointNeutralised":
        stats.flagEvents.push({
          tick: event.tick,
          kind: "neutralised",
          point: event.point,
          by: event.by,
        });
        break;
      case "controlPointCaptured":
        stats.flagEvents.push({
          tick: event.tick,
          kind: "captured",
          point: event.point,
          by: event.by,
        });
        break;
      case "matchEnded":
        stats.winner = event.winner;
        stats.endReason = event.reason;
        break;
      case "commandRejected":
        stats.rejections.set(event.reason, (stats.rejections.get(event.reason) ?? 0) + 1);
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function clock(ticks: number): string {
  const total = Math.floor(rules.ticksToSeconds(ticks));
  const minutes = Math.floor(total / rules.SECONDS_PER_MINUTE);
  const seconds = total % rules.SECONDS_PER_MINUTE;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function bar(value: number, max: number, width: number): string {
  if (max <= 0) return "";
  const filled = Math.round((value / max) * width);
  return "#".repeat(Math.max(0, Math.min(width, filled)));
}

const TIMELINE_BAR_WIDTH = 28;

export function formatReport(stats: MatchStats): string {
  const lines: string[] = [];
  const teamName = (t: TeamId): string => (t === 0 ? "BLUE" : "RED");

  lines.push("=".repeat(72));
  lines.push(`  MATCH REPORT   map=${stats.map}  lane=${stats.lane}  seed=${stats.seed}`);
  lines.push("=".repeat(72));
  lines.push("");

  const winner = stats.winner === null ? "DRAW" : teamName(stats.winner);
  lines.push(
    `Result      ${winner} (${stats.endReason}) after ${clock(stats.durationTicks)}`,
  );
  lines.push(
    `Tickets     BLUE ${stats.teams[0].finalTickets}   RED ${stats.teams[1].finalTickets}` +
      `   (start ${rules.START_TICKETS})`,
  );
  lines.push(`State hash  0x${stats.finalHash.toString(16).padStart(8, "0")}`);
  lines.push("");

  lines.push("-- Ticket curve ------------------------------------------------------");
  lines.push("  min   BLUE  RED   flags        blue bar / red bar");
  for (const row of stats.ticketTimeline) {
    const b = bar(row.tickets[0], rules.START_TICKETS, TIMELINE_BAR_WIDTH);
    const r = bar(row.tickets[1], rules.START_TICKETS, TIMELINE_BAR_WIDTH);
    lines.push(
      `  ${String(row.minute).padStart(3)}  ${String(row.tickets[0]).padStart(5)}` +
        `${String(row.tickets[1]).padStart(5)}   ${row.flags[0]}-${row.flags[1]}` +
        `        ${b.padEnd(TIMELINE_BAR_WIDTH)}|${r}`,
    );
  }
  lines.push("");

  lines.push("-- Objectives --------------------------------------------------------");
  if (stats.flagEvents.length === 0) {
    lines.push("  (no flag ever changed hands)");
  }
  for (const event of stats.flagEvents) {
    const name = stats.pointNames.get(event.point) ?? `#${event.point}`;
    const verb = event.kind === "captured" ? "captured" : "neutralised";
    lines.push(`  ${clock(event.tick)}  ${teamName(event.by).padEnd(4)} ${verb} ${name}`);
  }
  lines.push("");

  lines.push("-- Logistics and spawn economy ---------------------------------------");
  lines.push(
    `  ${"".padEnd(26)}${teamName(0).padStart(9)}${teamName(1).padStart(9)}`,
  );
  const row = (label: string, a: number | string, b: number | string): void => {
    lines.push(`  ${label.padEnd(26)}${String(a).padStart(9)}${String(b).padStart(9)}`);
  };
  const t0 = stats.teams[0];
  const t1 = stats.teams[1];
  const lifetime = (ticks: readonly number[]): string =>
    ticks.length === 0 ? "still up" : clock(Math.round(mean(ticks)));
  row("FOBs placed", t0.fobsPlaced, t1.fobsPlaced);
  row("FOBs lost to enemy", t0.fobsLostToEnemy, t1.fobsLostToEnemy);
  row("avg FOB lifetime", lifetime(t0.fobLifetimeTicks), lifetime(t1.fobLifetimeTicks));
  row("habitats built", t0.habitatsBuilt, t1.habitatsBuilt);
  row("rallies placed", t0.ralliesPlaced, t1.ralliesPlaced);
  row("rallies overrun", t0.ralliesOverrun, t1.ralliesOverrun);
  row("construction pts delivered", Math.round(t0.constructionPointsDelivered), Math.round(t1.constructionPointsDelivered));
  row("ammo pts delivered", Math.round(t0.ammoPointsDelivered), Math.round(t1.ammoPointsDelivered));
  lines.push("");
  row("spawns @ main", t0.spawnsFromMain, t1.spawnsFromMain);
  row("spawns @ rally", t0.spawnsFromRally, t1.spawnsFromRally);
  row("spawns @ habitat", t0.spawnsFromHabitat, t1.spawnsFromHabitat);
  lines.push("");

  lines.push("-- Attrition ---------------------------------------------------------");
  row("deaths", t0.deaths, t1.deaths);
  row("  of which gave up", t0.gaveUp, t1.gaveUp);
  row("revives", t0.revives, t1.revives);
  row("tickets: deaths", t0.ticketsLostToDeaths, t1.ticketsLostToDeaths);
  row("tickets: FOB radios", t0.ticketsLostToFobs, t1.ticketsLostToFobs);
  row("tickets: bleed", t0.ticketsLostToBleed, t1.ticketsLostToBleed);
  row("tickets: capture bonus", `+${t0.firstCaptureBonuses}`, `+${t1.firstCaptureBonuses}`);
  lines.push("");

  lines.push("-- Rules telemetry ---------------------------------------------------");
  lines.push(`  double-neutral time   ${clock(stats.doubleNeutralTicks)}`);
  lines.push(`  mercy-bleed time      ${clock(stats.mercyBleedTicks)}`);
  if (stats.habitatBuilds.length > 0) {
    // Wall time from staking the site out to the habitat going live. Includes
    // waiting for a truck, so it is a logistics measure, not a build-rate one:
    // the build-rate curve itself is pinned down by unit test.
    const times = stats.habitatBuilds.map(
      (h) => `${h.buildSeconds.toFixed(0)}s/${h.builders}p`,
    );
    lines.push(`  habitat stake-to-live ${times.join(", ")}`);
  }
  const topRejections = [...stats.rejections.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (topRejections.length > 0) {
    lines.push(
      `  top rejected commands ${topRejections.map(([r, n]) => `${r}×${n}`).join(", ")}`,
    );
  }
  lines.push("");

  return lines.join("\n");
}
