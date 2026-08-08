/**
 * Cover: the hand-placed half of the map.
 *
 * PLAN §1 calls the map the most expensive asset in the genre and settles on
 * procedural terrain plus a few hand-placed landmarks. terrain.ts is the
 * procedural half; this is the landmarks.
 *
 * It matters more than scenery. Until cover existed, the only thing that could
 * stop a round was a fold in the ground, so "take cover" meant "find a hill",
 * and a raiding party crossing open ground died every time — measured, in
 * M1, as a raid success rate near zero.
 *
 * Volumes are axis-aligned boxes, deliberately. A rotated box needs a
 * transform per ray test, and this test runs on every round fired by every
 * player; a slab test against an AABB is a handful of comparisons. Buildings
 * that all face the same way is a small aesthetic price for a hit-registration
 * path that stays cheap enough to run a thousand headless matches through.
 *
 * Everything here is *data plus geometry* — no rules, no randomness, no state.
 */

import type { Vec3 } from "./math.js";

/**
 * A solid volume standing on the ground.
 *
 * Position is the centre of the footprint; `height` rises from the terrain
 * beneath that centre. Buildings therefore sit level even on a slope, which is
 * what a foundation does.
 */
export interface CoverVolume {
  /** Centre of the footprint, in map metres. */
  x: number;
  y: number;
  /** Footprint half-extents. */
  halfWidth: number;
  halfDepth: number;
  /** How far it stands above the ground at its centre. */
  height: number;
  /** Purely for the renderer to pick a look. */
  kind: "building" | "wall" | "container";
}

/** Resolved bounds in world space, with the ground height already applied. */
export interface CoverBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  kind: CoverVolume["kind"];
}

/** Bind a volume to the ground under it. */
export function resolveCover(volume: CoverVolume, groundZ: number): CoverBox {
  return {
    minX: volume.x - volume.halfWidth,
    maxX: volume.x + volume.halfWidth,
    minY: volume.y - volume.halfDepth,
    maxY: volume.y + volume.halfDepth,
    minZ: groundZ,
    maxZ: groundZ + volume.height,
    kind: volume.kind,
  };
}

/**
 * Where a segment first enters a box, as a fraction along it, or null.
 *
 * Standard slab method. Returns the entry point only — a round that reaches a
 * wall has stopped, and what happens on the far side is not this function's
 * problem.
 */
export function segmentHitsBox(a: Vec3, b: Vec3, box: CoverBox): number | null {
  let tMin = 0;
  let tMax = 1;

  const axes: Array<[number, number, number, number]> = [
    [a.x, b.x - a.x, box.minX, box.maxX],
    [a.y, b.y - a.y, box.minY, box.maxY],
    [a.z, b.z - a.z, box.minZ, box.maxZ],
  ];

  for (const [origin, delta, low, high] of axes) {
    if (Math.abs(delta) < 1e-9) {
      // Parallel to this pair of planes: either inside them or never crossing.
      if (origin < low || origin > high) return null;
      continue;
    }
    const inverse = 1 / delta;
    let near = (low - origin) * inverse;
    let far = (high - origin) * inverse;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    if (near > tMin) tMin = near;
    if (far < tMax) tMax = far;
    if (tMin > tMax) return null;
  }

  return tMin;
}

/** Is a ground position inside a box's footprint, at standing height? */
export function insideFootprint(x: number, y: number, box: CoverBox): boolean {
  return x > box.minX && x < box.maxX && y > box.minY && y < box.maxY;
}

/**
 * Push a position out of a box by the shortest horizontal distance.
 *
 * Only horizontal: a soldier cannot climb, so being "inside" a building is
 * always resolved by stepping out of a wall rather than by popping onto the
 * roof. Choosing the smallest of the four exits means walking into a wall
 * slides you along it instead of stopping you dead, which is what makes
 * buildings feel like buildings rather than glue.
 */
export function pushOutOfBox(
  x: number,
  y: number,
  box: CoverBox,
  radius: number,
): { x: number; y: number } {
  const minX = box.minX - radius;
  const maxX = box.maxX + radius;
  const minY = box.minY - radius;
  const maxY = box.maxY + radius;
  if (x <= minX || x >= maxX || y <= minY || y >= maxY) return { x, y };

  const exitLeft = x - minX;
  const exitRight = maxX - x;
  const exitDown = y - minY;
  const exitUp = maxY - y;
  const smallest = Math.min(exitLeft, exitRight, exitDown, exitUp);

  if (smallest === exitLeft) return { x: minX, y };
  if (smallest === exitRight) return { x: maxX, y };
  if (smallest === exitDown) return { x, y: minY };
  return { x, y: maxY };
}

/**
 * A coarse uniform grid over the cover volumes.
 *
 * Cover is tested twice on the hot path: once per soldier per tick for
 * collision, and once per trajectory segment per shot for occlusion. Scanning
 * every volume both times is quadratic in map detail, and it showed —
 * adding forty-odd buildings took a headless match from 236 ms to 583 ms, and
 * that number is the project's iteration speed, not a vanity metric.
 *
 * A grid is the cheapest thing that fixes it: bucket the boxes once at match
 * start, then look at only the cells a query actually touches. No trees, no
 * rebalancing, and nothing to maintain — cover never moves.
 */
export class CoverGrid {
  private readonly cells: number[][];
  private readonly columns: number;
  private readonly cellSizeM: number;
  readonly boxes: readonly CoverBox[];

  constructor(boxes: readonly CoverBox[], mapSizeM: number, cellSizeM = 64) {
    this.boxes = boxes;
    this.cellSizeM = cellSizeM;
    this.columns = Math.max(1, Math.ceil(mapSizeM / cellSizeM));
    this.cells = Array.from({ length: this.columns * this.columns }, () => []);

    for (let index = 0; index < boxes.length; index++) {
      const box = boxes[index];
      if (box === undefined) continue;
      const minCol = this.cellIndex(box.minX);
      const maxCol = this.cellIndex(box.maxX);
      const minRow = this.cellIndex(box.minY);
      const maxRow = this.cellIndex(box.maxY);
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          this.cells[row * this.columns + col]?.push(index);
        }
      }
    }
  }

  private cellIndex(v: number): number {
    return Math.max(0, Math.min(this.columns - 1, Math.floor(v / this.cellSizeM)));
  }

  /** Boxes that could contain a point within `radius` of (x, y). */
  near(x: number, y: number, radius: number, out: CoverBox[]): CoverBox[] {
    out.length = 0;
    const minCol = this.cellIndex(x - radius);
    const maxCol = this.cellIndex(x + radius);
    const minRow = this.cellIndex(y - radius);
    const maxRow = this.cellIndex(y + radius);
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        for (const index of this.cells[row * this.columns + col] ?? []) {
          const box = this.boxes[index];
          if (box !== undefined && !out.includes(box)) out.push(box);
        }
      }
    }
    return out;
  }

  /** Boxes whose cells the segment from a to b passes through. */
  alongSegment(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    out: CoverBox[],
  ): CoverBox[] {
    const centreX = (ax + bx) / 2;
    const centreY = (ay + by) / 2;
    const radius = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) / 2;
    return this.near(centreX, centreY, radius, out);
  }
}

/**
 * Mirror a list of volumes about the map's centre line and return both halves.
 *
 * Map fairness is a hard constraint (see maps/riverbend.ts), and the reliable
 * way to hold it is to make asymmetry unrepresentable: cover is authored for
 * one side only and the other side is generated. A volume sitting on the
 * centre line is its own mirror and is not duplicated.
 */
export function mirrorCover(
  volumes: readonly CoverVolume[],
  mapSizeM: number,
): CoverVolume[] {
  const all: CoverVolume[] = [];
  for (const volume of volumes) {
    all.push(volume);
    const mirroredX = mapSizeM - volume.x;
    if (Math.abs(mirroredX - volume.x) < 1e-6) continue;
    all.push({ ...volume, x: mirroredX });
  }
  return all;
}
