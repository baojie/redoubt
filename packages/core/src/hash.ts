/**
 * Deterministic state hashing.
 *
 * CLAUDE.md invariant #5: the same seed and the same command stream must
 * produce bit-identical state, tick for tick. A 32-bit hash per tick makes
 * that assertable in a test and makes a desync reproducible from a seed rather
 * than from a bug report.
 *
 * Floats are quantised before hashing. Positions and supply pools accumulate
 * tiny representation differences that are meaningless to gameplay, and a hash
 * that trips on the last mantissa bit is a hash nobody will keep green.
 * Quantisation is deliberately coarse enough to ignore that and fine enough to
 * catch any real divergence.
 *
 * FNV-1a constants below are part of the algorithm, not game balance, so they
 * live here rather than in rules.ts (see CLAUDE.md).
 */

import type { GameState } from "./types.js";

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Sub-centimetre for positions; well below any radius the rules care about. */
const POSITION_QUANTUM = 1000;
/** Supply pools and health quantise to a thousandth of a point. */
const SCALAR_QUANTUM = 1000;

export class Hasher {
  private h = FNV_OFFSET_BASIS;

  int(value: number): this {
    let v = value | 0;
    for (let i = 0; i < 4; i++) {
      this.h ^= v & 0xff;
      this.h = Math.imul(this.h, FNV_PRIME) >>> 0;
      v >>>= 8;
    }
    return this;
  }

  /** Quantise then hash. NaN and Infinity fold to distinct fixed values. */
  float(value: number, quantum: number): this {
    if (!Number.isFinite(value)) return this.int(value !== value ? 0x7fffffff : 0x7ffffffe);
    return this.int(Math.round(value * quantum));
  }

  pos(value: number): this {
    return this.float(value, POSITION_QUANTUM);
  }

  scalar(value: number): this {
    return this.float(value, SCALAR_QUANTUM);
  }

  bool(value: boolean): this {
    return this.int(value ? 1 : 0);
  }

  /** Hash a nullable id, distinguishing "absent" from id 0. */
  maybeId(value: number | null): this {
    return this.int(value === null ? -1 : value);
  }

  str(value: string): this {
    for (let i = 0; i < value.length; i++) this.int(value.charCodeAt(i));
    return this;
  }

  get value(): number {
    return this.h >>> 0;
  }
}

/**
 * Hash everything that can affect future evolution of the match. Presentation-
 * only fields (names) are included too — they are constant, so they cost
 * nothing and catch a mismatched map.
 */
export function hashState(state: GameState): number {
  const h = new Hasher();

  h.int(state.tick);
  h.str(state.phase);
  h.str(state.outcome.kind);
  h.int(state.rng.seed);
  h.str(state.lane.name);
  h.int(state.nextEntityId);
  h.bool(state.doubleNeutral);

  for (const teamId of [0, 1] as const) {
    const team = state.teams[teamId];
    h.int(team.tickets);
    h.maybeId(team.commander);
    h.maybeId(team.mercyBleedStartedAtTick);
    h.scalar(state.bleedFraction[teamId]);
  }

  for (const p of state.players) {
    h.int(p.id).int(p.team).int(p.squad).str(p.role).str(p.status);
    h.pos(p.pos.x).pos(p.pos.y);
    h.bool(p.waypoint !== null);
    if (p.waypoint !== null) h.pos(p.waypoint.x).pos(p.waypoint.y);
    h.bool(p.steer !== null);
    if (p.steer !== null) h.pos(p.steer.x).pos(p.steer.y);
    h.scalar(p.health).scalar(p.ammo);
    h.int(p.bleedoutAtTick).int(p.deployingSinceTick);
    h.maybeId(p.vehicle).int(p.reviveProgressTicks).int(p.nextShotAtTick);
    h.int(p.kills).int(p.deaths);
  }

  for (const s of state.squads) {
    h.int(s.id).int(s.team).maybeId(s.leader).maybeId(s.rally);
    for (const m of s.members) h.int(m);
  }

  for (const c of state.controlPoints) {
    h.int(c.id).maybeId(c.owner).maybeId(c.contestingTeam);
    h.float(c.progress, SCALAR_QUANTUM);
    for (const t of c.everOwnedBy) h.int(t);
  }

  for (const f of state.fobs) {
    h.int(f.id).int(f.team).pos(f.pos.x).pos(f.pos.y);
    h.scalar(f.radioHealth).scalar(f.constructionPoints).scalar(f.ammoPoints);
    h.bool(f.destroyed).int(f.createdAtTick);
  }

  for (const d of state.deployables) {
    h.int(d.id).int(d.fob).int(d.team).str(d.type);
    h.pos(d.pos.x).pos(d.pos.y);
    h.scalar(d.buildProgressWork).scalar(d.health);
    h.bool(d.built).bool(d.overrun).bool(d.destroyed);
    h.scalar(d.constructionPointsSpent).scalar(d.ammoPointsSpent);
    h.int(d.placedAtTick).maybeId(d.builtAtTick);
  }

  for (const r of state.rallyPoints) {
    h.int(r.id).int(r.squad).int(r.team).pos(r.pos.x).pos(r.pos.y);
    h.int(r.createdAtTick).maybeId(r.waveOpenedAtTick).int(r.availableAtTick);
    h.bool(r.destroyed);
  }

  for (const v of state.vehicles) {
    h.int(v.id).int(v.team).str(v.type).pos(v.pos.x).pos(v.pos.y);
    h.bool(v.waypoint !== null);
    if (v.waypoint !== null) h.pos(v.waypoint.x).pos(v.waypoint.y);
    h.scalar(v.speedMps).scalar(v.health);
    h.scalar(v.cargoConstructionPoints).scalar(v.cargoAmmoPoints);
    h.bool(v.destroyed).int(v.respawnAtTick);
    for (const o of v.occupants) h.int(o);
    h.bool(v.transfer !== null);
    if (v.transfer !== null) {
      h.str(v.transfer.kind).maybeId(v.transfer.fob);
      h.scalar(v.transfer.constructionPoints).scalar(v.transfer.ammoPoints);
      h.bool(v.transfer.activeThisTick);
    }
  }

  return h.value;
}
