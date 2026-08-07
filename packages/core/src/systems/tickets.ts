/**
 * The ticket ledger.
 *
 * Every ticket movement in the game funnels through `adjustTickets`, which is
 * the only place allowed to write `team.tickets`. That is what makes CLAUDE.md
 * invariant #1 — tickets stay in range and only ever rise via an explicit gain
 * event — checkable rather than hopeful.
 */

import type { TicketReason } from "../events.js";
import type { TeamId } from "../types.js";
import type { World } from "../world.js";

/** Reasons that are allowed to increase a team's ticket count. */
const GAIN_REASONS: ReadonlySet<TicketReason> = new Set<TicketReason>(["firstCapture"]);

export function adjustTickets(
  world: World,
  team: TeamId,
  delta: number,
  reason: TicketReason,
): void {
  if (delta === 0) return;
  if (delta > 0 && !GAIN_REASONS.has(reason)) {
    // A non-gain reason producing a gain is a bug in the caller, not a
    // gameplay event. Swallow it rather than corrupting the ledger.
    return;
  }

  const t = world.state.teams[team];
  const before = t.tickets;
  const after = Math.max(0, before + delta);
  if (after === before) return;

  t.tickets = after;
  world.emit({
    t: "ticketChange",
    tick: world.state.tick,
    team,
    delta: after - before,
    total: after,
    reason,
  });
}

/**
 * Apply fractional bleed without ever writing a fractional ticket count.
 * The remainder is carried in `state.bleedFraction` so slow bleed rates still
 * accumulate exactly.
 */
export function applyFractionalBleed(
  world: World,
  team: TeamId,
  amount: number,
  reason: TicketReason,
): void {
  if (amount <= 0) return;
  const carried = world.state.bleedFraction[team] + amount;
  const whole = Math.floor(carried);
  world.state.bleedFraction[team] = carried - whole;
  if (whole > 0) {
    adjustTickets(world, team, -whole, reason);
  }
}
