/**
 * Minimal 2D vector maths. The rules engine reasons on a flat plane; terrain
 * height is a rendering and ballistics concern that arrives with M3 and never
 * enters the authoritative rule evaluation.
 *
 * All distances are metres.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

export function cloneVec2(v: Vec2): Vec2 {
  return { x: v.x, y: v.y };
}

export function distanceSquared(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.sqrt(distanceSquared(a, b));
}

/** Cheap radius test that avoids the square root. */
export function withinRange(a: Vec2, b: Vec2, radius: number): boolean {
  return distanceSquared(a, b) <= radius * radius;
}

/**
 * Move `from` toward `to` by at most `maxStep` metres. Returns a new vector
 * and never overshoots.
 */
export function stepToward(from: Vec2, to: Vec2, maxStep: number): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distSq = dx * dx + dy * dy;
  if (distSq <= maxStep * maxStep) {
    return { x: to.x, y: to.y };
  }
  const dist = Math.sqrt(distSq);
  const scale = maxStep / dist;
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

/**
 * Scale a vector to unit length. Returns null for a zero-ish vector rather
 * than dividing by zero — callers treat that as "no direction".
 */
export function normalise(v: Vec2): Vec2 | null {
  const length = Math.hypot(v.x, v.y);
  if (!Number.isFinite(length) || length <= 0) return null;
  return { x: v.x / length, y: v.y / length };
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Clamp a position into the square playable area. */
export function clampToMap(p: Vec2, mapSizeM: number): Vec2 {
  return { x: clamp(p.x, 0, mapSizeM), y: clamp(p.y, 0, mapSizeM) };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
