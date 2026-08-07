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

// ---------------------------------------------------------------------------
// Three dimensions
// ---------------------------------------------------------------------------

/**
 * The rules engine reasons about position on the ground plane — capture
 * radii, FOB spacing, supply range are all flat measurements and stay that
 * way. Height enters in exactly one place: ballistics, which has to know
 * whether a hill is in the way and how far a round drops on the way there.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function addScaled3(a: Vec3, b: Vec3, scale: number): Vec3 {
  return { x: a.x + b.x * scale, y: a.y + b.y * scale, z: a.z + b.z * scale };
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function length3(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function distance3(a: Vec3, b: Vec3): number {
  return length3(sub3(a, b));
}

export function normalise3(v: Vec3): Vec3 | null {
  const length = length3(v);
  if (!Number.isFinite(length) || length <= 0) return null;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

export function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Aim angles to a unit direction. Yaw is measured from +x toward +y. */
export function directionFromAngles(yaw: number, pitch: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  return {
    x: Math.cos(yaw) * cosPitch,
    y: Math.sin(yaw) * cosPitch,
    z: Math.sin(pitch),
  };
}

/** Unit direction to aim angles. The inverse of `directionFromAngles`. */
export function anglesFromDirection(d: Vec3): { yaw: number; pitch: number } {
  const flat = Math.hypot(d.x, d.y);
  return { yaw: Math.atan2(d.y, d.x), pitch: Math.atan2(d.z, flat) };
}

/**
 * Shortest distance from a point to the segment a→b, and where along it.
 * Used for hit tests and for deciding who a round passed close enough to
 * suppress.
 */
export function pointToSegment3(
  point: Vec3,
  a: Vec3,
  b: Vec3,
): { distance: number; t: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const lengthSq = abx * abx + aby * aby + abz * abz;
  if (lengthSq <= 0) return { distance: distance3(point, a), t: 0 };
  let t =
    ((point.x - a.x) * abx + (point.y - a.y) * aby + (point.z - a.z) * abz) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const closest = { x: a.x + abx * t, y: a.y + aby * t, z: a.z + abz * t };
  return { distance: distance3(point, closest), t };
}
