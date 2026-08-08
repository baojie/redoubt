/**
 * Camera-relative steering.
 *
 * In the map view WASD means compass directions; in first person it means
 * directions relative to where you are looking, which is the only thing that
 * makes sense once you can turn. Both produce the same `steer` intent and the
 * rules engine has no idea which view produced it.
 *
 * Worth pinning to the compass rather than to itself: a strafe vector that is
 * merely *consistent* can still be consistently backwards, and nothing throws.
 * A and D were inverted for exactly that reason — `right` was built by rotating
 * forward a quarter turn the wrong way, which is the left-hand direction.
 *
 * Conventions, from core: x runs east, y runs north, and yaw is measured from
 * +x toward +y. So facing north is yaw = π/2, and a soldier facing north has
 * east on their right.
 */

import { describe, expect, it } from "vitest";
import { steerFromCamera } from "../src/firstPerson.js";

const NORTH = Math.PI / 2;
const EAST = 0;

/** The input vector for a set of held keys. Screen axes: y grows down. */
const KEY = {
  W: { x: 0, y: -1 },
  S: { x: 0, y: 1 },
  A: { x: -1, y: 0 },
  D: { x: 1, y: 0 },
  WD: { x: 1, y: -1 },
} as const;

function expectDirection(
  actual: { x: number; y: number } | null,
  expected: { x: number; y: number },
): void {
  expect(actual).not.toBeNull();
  expect(actual!.x).toBeCloseTo(expected.x, 6);
  expect(actual!.y).toBeCloseTo(expected.y, 6);
}

describe("steering relative to the camera", () => {
  it("sends W where the camera is looking", () => {
    expectDirection(steerFromCamera(KEY.W, NORTH), { x: 0, y: 1 });
    expectDirection(steerFromCamera(KEY.W, EAST), { x: 1, y: 0 });
  });

  it("sends S the opposite way", () => {
    expectDirection(steerFromCamera(KEY.S, NORTH), { x: 0, y: -1 });
    expectDirection(steerFromCamera(KEY.S, EAST), { x: -1, y: 0 });
  });

  it("strafes D to the soldier's right, which facing north is east", () => {
    // The assertion that catches the inversion. Facing north, your right hand
    // points east — so D has to produce +x, and it produced -x.
    expectDirection(steerFromCamera(KEY.D, NORTH), { x: 1, y: 0 });
    // Facing east, right is south.
    expectDirection(steerFromCamera(KEY.D, EAST), { x: 0, y: -1 });
  });

  it("strafes A to the soldier's left, which facing north is west", () => {
    expectDirection(steerFromCamera(KEY.A, NORTH), { x: -1, y: 0 });
    expectDirection(steerFromCamera(KEY.A, EAST), { x: 0, y: 1 });
  });

  it("puts A and D on exactly opposite sides", () => {
    const left = steerFromCamera(KEY.A, 0.7)!;
    const right = steerFromCamera(KEY.D, 0.7)!;
    expect(left.x).toBeCloseTo(-right.x, 6);
    expect(left.y).toBeCloseTo(-right.y, 6);
  });

  it("normalises a diagonal, so W+D is not faster than W", () => {
    const diagonal = steerFromCamera(KEY.WD, NORTH)!;
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1, 6);
    // Facing north, forward-and-right is north-east: both components positive.
    expect(diagonal.x).toBeGreaterThan(0);
    expect(diagonal.y).toBeGreaterThan(0);
  });

  it("treats no keys as no direction rather than as a zero-length steer", () => {
    expect(steerFromCamera({ x: 0, y: 0 }, NORTH)).toBeNull();
  });
});
