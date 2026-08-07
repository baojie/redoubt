/**
 * Where the round went.
 *
 * This replaces the M0/M1 hit-probability stand-in. The old model asked "what
 * are the odds of a hit at this range" and rolled dice. This one points the
 * rifle, adds the shooter's dispersion, and follows the round until it hits
 * somebody, hits the ground, or runs out of range. Nothing about the layers
 * above changed to accommodate it — that separation was the point of building
 * the rules engine first.
 *
 * ## Why it is a march and not a projectile
 *
 * The obvious implementation is a projectile entity integrated every tick.
 * That costs a hit test per bullet per tick, and with a full server firing it
 * would make the thousand-match balance harness — the instrument this whole
 * project's iteration speed rests on — roughly an order of magnitude slower.
 *
 * A round's flight is a parabola with a known closed form, and at 780 m/s it
 * crosses the entire map in just over a second. So the whole flight is
 * resolved at the instant of firing, by marching the parabola in a dozen
 * segments and testing each against the terrain and the bodies. Same answer,
 * one march per shot instead of thousands of per-tick steps.
 *
 * Travel time is not discarded: the resolved impact carries the time of
 * flight, so the client can draw a tracer that arrives when it should.
 */

import {
  addScaled3,
  distance3,
  normalise3,
  pointToSegment3,
  sub3,
  type Vec3,
} from "../math.js";
import {
  BULLET_MAX_RANGE_M,
  GRAVITY_MPS2,
  MUZZLE_VELOCITY_MPS,
  SUPPRESSION_RADIUS_M,
  TRAJECTORY_SEGMENTS,
} from "../rules.js";
import { BODY_HALF_HEIGHT_M, BODY_RADIUS_M, type Terrain } from "../terrain.js";
import { segmentHitsBox, type CoverBox } from "../cover.js";
import type { PlayerId } from "../types.js";

/** A body a round can hit, at the position it occupied when the shot was fired. */
export interface Target {
  id: PlayerId;
  /** Centre of mass, in world space. */
  torso: Vec3;
}

export type ImpactKind = "body" | "ground" | "cover" | "spent";

export interface Impact {
  kind: ImpactKind;
  /** Where the round stopped. */
  at: Vec3;
  /** Distance travelled, in metres. */
  rangeM: number;
  /** Time of flight, in seconds — what a tracer should take to get there. */
  flightSeconds: number;
  /** Who was hit, when `kind` is "body". */
  hit: PlayerId | null;
  /**
   * Everyone the round passed close enough to rattle, hit or not.
   * Computed during the same march, because it is the same geometry.
   */
  suppressed: PlayerId[];
}

/**
 * Position along the trajectory at time `t`, in seconds since firing.
 * Straight Newtonian flight: no drag, which at these ranges and velocities is
 * a smaller error than the dispersion cone already models.
 */
export function trajectoryAt(origin: Vec3, direction: Vec3, t: number): Vec3 {
  return {
    x: origin.x + direction.x * MUZZLE_VELOCITY_MPS * t,
    y: origin.y + direction.y * MUZZLE_VELOCITY_MPS * t,
    z: origin.z + direction.z * MUZZLE_VELOCITY_MPS * t - 0.5 * GRAVITY_MPS2 * t * t,
  };
}

/**
 * Fire one round and report what it did.
 *
 * `direction` must already include the shooter's dispersion — this function is
 * pure geometry and rolls no dice, which is what makes it directly testable
 * and keeps every random draw in one place upstream.
 */
export function resolveShot(
  terrain: Terrain,
  origin: Vec3,
  direction: Vec3,
  targets: readonly Target[],
  cover: readonly CoverBox[] = [],
  maxRangeM: number = BULLET_MAX_RANGE_M,
): Impact {
  const unit = normalise3(direction) ?? { x: 1, y: 0, z: 0 };
  const totalTime = maxRangeM / MUZZLE_VELOCITY_MPS;
  const step = totalTime / TRAJECTORY_SEGMENTS;

  const suppressed: PlayerId[] = [];
  const alreadySuppressed = new Set<PlayerId>();

  let segmentStart = origin;
  let travelled = 0;

  for (let i = 0; i < TRAJECTORY_SEGMENTS; i++) {
    const tEnd = step * (i + 1);
    const segmentEnd = trajectoryAt(origin, unit, tEnd);
    const segmentLength = distance3(segmentStart, segmentEnd);

    // Nearest body first, so a round cannot pass through someone to reach
    // someone further along the same segment.
    let bestTarget: Target | null = null;
    let bestT = Number.POSITIVE_INFINITY;

    for (const target of targets) {
      const { distance, t } = pointToSegment3(target.torso, segmentStart, segmentEnd);

      // Suppression is the same measurement with a wider threshold, so it
      // comes free with the hit test rather than costing a second pass.
      if (distance <= SUPPRESSION_RADIUS_M && !alreadySuppressed.has(target.id)) {
        alreadySuppressed.add(target.id);
        suppressed.push(target.id);
      }

      if (!withinBody(target.torso, segmentStart, segmentEnd, distance, t)) continue;
      if (t < bestT) {
        bestT = t;
        bestTarget = target;
      }
    }

    // The ground is checked at a finer resolution than the body test, because
    // a segment can pass under a crest that its endpoints both clear.
    const groundT = groundImpactT(terrain, segmentStart, segmentEnd);

    // Walls and buildings. Nearest wins, and a wall in front of a body means
    // the body is safe — which is the entire point of cover.
    let coverT: number | null = null;
    for (const box of cover) {
      const hit = segmentHitsBox(segmentStart, segmentEnd, box);
      if (hit === null) continue;
      if (coverT === null || hit < coverT) coverT = hit;
    }

    const solidT =
      groundT === null ? coverT : coverT === null ? groundT : Math.min(groundT, coverT);

    // Whichever came first along this segment wins.
    if (bestTarget !== null && (solidT === null || bestT <= solidT)) {
      const at = lerp3(segmentStart, segmentEnd, bestT);
      return {
        kind: "body",
        at,
        rangeM: travelled + segmentLength * bestT,
        flightSeconds: step * i + step * bestT,
        hit: bestTarget.id,
        suppressed,
      };
    }
    if (solidT !== null) {
      const at = lerp3(segmentStart, segmentEnd, solidT);
      const stoppedByCover = coverT !== null && (groundT === null || coverT <= groundT);
      return {
        kind: stoppedByCover ? "cover" : "ground",
        at,
        rangeM: travelled + segmentLength * solidT,
        flightSeconds: step * i + step * solidT,
        hit: null,
        suppressed,
      };
    }

    travelled += segmentLength;
    segmentStart = segmentEnd;
  }

  return {
    kind: "spent",
    at: segmentStart,
    rangeM: travelled,
    flightSeconds: totalTime,
    hit: null,
    suppressed,
  };
}

/**
 * Is the round actually inside the body cylinder, rather than merely close to
 * its centre line? The perpendicular distance test alone would let a round
 * pass a metre over someone's head and still count.
 */
function withinBody(
  torso: Vec3,
  a: Vec3,
  b: Vec3,
  perpendicular: number,
  t: number,
): boolean {
  if (perpendicular > Math.hypot(BODY_RADIUS_M, BODY_HALF_HEIGHT_M)) return false;
  const point = lerp3(a, b, t);
  const horizontal = Math.hypot(point.x - torso.x, point.y - torso.y);
  const vertical = Math.abs(point.z - torso.z);
  return horizontal <= BODY_RADIUS_M && vertical <= BODY_HALF_HEIGHT_M;
}

/** Sub-samples used per segment when looking for the ground. */
const GROUND_SAMPLES = 8;

/**
 * Where along the segment the round goes below the ground, or null.
 * Sub-sampled because a segment tens of metres long can dip under a rise and
 * come out the other side, and a round that does that has hit the hill.
 */
function groundImpactT(terrain: Terrain, a: Vec3, b: Vec3): number | null {
  let previousT = 0;
  let previousClearance = a.z - terrain.heightAt(a.x, a.y);

  for (let i = 1; i <= GROUND_SAMPLES; i++) {
    const t = i / GROUND_SAMPLES;
    const point = lerp3(a, b, t);
    const clearance = point.z - terrain.heightAt(point.x, point.y);
    if (clearance <= 0) {
      // Interpolate to where clearance crossed zero, so impacts land on the
      // surface rather than at whichever sample happened to be underground.
      const span = previousClearance - clearance;
      const crossing = span <= 0 ? t : previousT + (t - previousT) * (previousClearance / span);
      return Math.max(0, Math.min(1, crossing));
    }
    previousT = t;
    previousClearance = clearance;
  }
  return null;
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/**
 * Apply a dispersion cone to an aim direction.
 *
 * `u1` and `u2` are uniform draws in [0, 1). Taking the square root of the
 * first spreads shots uniformly over the *area* of the cone rather than
 * uniformly over its angle — without it, rounds cluster implausibly near the
 * centre and long-range hit rates come out far too high.
 */
export function applySpread(
  direction: Vec3,
  spreadRad: number,
  u1: number,
  u2: number,
): Vec3 {
  const unit = normalise3(direction);
  if (unit === null || spreadRad <= 0) return direction;

  const angle = spreadRad * Math.sqrt(u1);
  const azimuth = u2 * Math.PI * 2;

  // Any two vectors perpendicular to the aim will do; pick one that stays
  // well conditioned however the shooter is pointing.
  const helper: Vec3 = Math.abs(unit.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const right = normalise3(cross3(unit, helper));
  if (right === null) return direction;
  const up = cross3(right, unit);

  const lateral = Math.tan(angle);
  const offset = {
    x: right.x * Math.cos(azimuth) * lateral + up.x * Math.sin(azimuth) * lateral,
    y: right.y * Math.cos(azimuth) * lateral + up.y * Math.sin(azimuth) * lateral,
    z: right.z * Math.cos(azimuth) * lateral + up.z * Math.sin(azimuth) * lateral,
  };
  return normalise3(addScaled3(unit, offset, 1)) ?? unit;
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/**
 * Elevation needed to put a round on a target at a given range — the sight
 * picture a competent shooter would hold. Used by bots, who otherwise shoot
 * flat and miss everything past a hundred metres.
 */
export function aimWithDrop(origin: Vec3, target: Vec3): Vec3 {
  const flat = Math.hypot(target.x - origin.x, target.y - origin.y);
  const rise = target.z - origin.z;
  const t = flat / MUZZLE_VELOCITY_MPS;
  const compensated = rise + 0.5 * GRAVITY_MPS2 * t * t;
  return normalise3({ x: target.x - origin.x, y: target.y - origin.y, z: compensated })
    ?? normalise3(sub3(target, origin))
    ?? { x: 1, y: 0, z: 0 };
}
