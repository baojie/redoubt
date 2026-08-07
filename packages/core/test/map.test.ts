/**
 * Map fairness.
 *
 * These exist because an aggregate win rate cannot detect an unfair map. The
 * original Riverbend measured 49.8% / 50.2% across a thousand matches while
 * every individual lane was lopsided — Ridge went 13/87 and Valley 79/21, and
 * the biases cancelled. Symmetry is checked structurally here so that a future
 * edit to the layout fails a test rather than quietly costing one side the
 * match.
 */

import { describe, expect, it } from "vitest";
import { RIVERBEND, distance, rules } from "../src/index.js";
import type { MapDefinition, Vec2 } from "../src/index.js";

/** Reflect a position across the map's vertical centre line. */
function mirror(map: MapDefinition, p: Vec2): Vec2 {
  return { x: map.sizeM - p.x, y: p.y };
}

function pointById(map: MapDefinition, id: number): Vec2 {
  const found = map.controlPoints.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no control point ${id}`);
  return found.pos;
}

/** Positions are authored by hand, so compare with a tolerance of a metre. */
const TOLERANCE_M = 1;

describe("Riverbend is fair by construction", () => {
  it("mirrors the two main bases", () => {
    const reflected = mirror(RIVERBEND, RIVERBEND.mainBases[0]);
    expect(distance(reflected, RIVERBEND.mainBases[1])).toBeLessThan(TOLERANCE_M);
  });

  it("mirrors the two vehicle spawns", () => {
    const reflected = mirror(RIVERBEND, RIVERBEND.vehicleSpawns[0]);
    expect(distance(reflected, RIVERBEND.vehicleSpawns[1])).toBeLessThan(TOLERANCE_M);
  });

  it("gives every control point a mirror twin", () => {
    for (const point of RIVERBEND.controlPoints) {
      const reflected = mirror(RIVERBEND, point.pos);
      const twin = RIVERBEND.controlPoints.find(
        (c) => distance(c.pos, reflected) < TOLERANCE_M,
      );
      expect(twin, `${point.name} has no mirror twin`).toBeDefined();
    }
  });

  it("maps every lane onto itself when mirrored", () => {
    // Point i from team 0's end must mirror onto point i from team 1's end.
    // This is the property that guarantees neither side has a shorter walk to
    // any flag in the chain.
    for (const lane of RIVERBEND.lanes) {
      const n = lane.points.length;
      for (let i = 0; i < n; i++) {
        const near = pointById(RIVERBEND, lane.points[i]!);
        const far = pointById(RIVERBEND, lane.points[n - 1 - i]!);
        const reflected = mirror(RIVERBEND, near);
        expect(
          distance(reflected, far),
          `lane ${lane.name}: position ${i} does not mirror position ${n - 1 - i}`,
        ).toBeLessThan(TOLERANCE_M);
      }
    }
  });

  it("gives both sides the same walk from main to their home flag", () => {
    for (const lane of RIVERBEND.lanes) {
      const first = pointById(RIVERBEND, lane.points[0]!);
      const last = pointById(RIVERBEND, lane.points[lane.points.length - 1]!);
      const blueWalk = distance(RIVERBEND.mainBases[0], first);
      const redWalk = distance(RIVERBEND.mainBases[1], last);
      expect(Math.abs(blueWalk - redWalk), `lane ${lane.name}`).toBeLessThan(TOLERANCE_M);
    }
  });

  it("spaces lane points far enough apart to be separate fights", () => {
    // Two flags inside one capture radius of each other are one flag.
    for (const lane of RIVERBEND.lanes) {
      for (let i = 1; i < lane.points.length; i++) {
        const a = pointById(RIVERBEND, lane.points[i - 1]!);
        const b = pointById(RIVERBEND, lane.points[i]!);
        expect(distance(a, b), `lane ${lane.name} leg ${i}`).toBeGreaterThan(
          rules.CAPTURE_RADIUS_M,
        );
      }
    }
  });

  it("leaves room to seat a FOB behind every flag", () => {
    // A flag closer to main than the main-base exclusion would leave a squad
    // leader nowhere legal to plant a radio behind it.
    for (const lane of RIVERBEND.lanes) {
      const first = pointById(RIVERBEND, lane.points[0]!);
      expect(distance(RIVERBEND.mainBases[0], first)).toBeGreaterThan(
        rules.FOB_MIN_DISTANCE_FROM_MAIN_BASE_M,
      );
    }
  });

  it("keeps every flag inside the playable area", () => {
    for (const point of RIVERBEND.controlPoints) {
      expect(point.pos.x).toBeGreaterThanOrEqual(rules.CAPTURE_RADIUS_M);
      expect(point.pos.x).toBeLessThanOrEqual(RIVERBEND.sizeM - rules.CAPTURE_RADIUS_M);
      expect(point.pos.y).toBeGreaterThanOrEqual(0);
      expect(point.pos.y).toBeLessThanOrEqual(RIVERBEND.sizeM);
    }
  });

  it("offers more than one lane, or RAAS is not RAAS", () => {
    expect(RIVERBEND.lanes.length).toBeGreaterThan(1);
    const signatures = new Set(RIVERBEND.lanes.map((l) => l.points.join(",")));
    expect(signatures.size).toBe(RIVERBEND.lanes.length);
  });
});
