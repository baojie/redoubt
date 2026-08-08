/**
 * What the wheel does, in both views.
 *
 * The listener itself needs a DOM and is not tested here. What is tested is
 * what was wrong: the wheel was bound to the map canvas, which is hidden
 * whenever the first-person view is up, and it did nothing at all while the
 * whole-map view was on because overview ignores the zoom entirely — plus the
 * bound on the optic that replaced the dead control in 3D.
 */

import { describe, expect, it } from "vitest";
import { rules } from "@redoubt/core";
import { stepMagnification } from "../src/firstPerson.js";
import { applyZoom, effectiveScale, type Camera } from "../src/input.js";

const DEFAULT_METRES_PER_PIXEL = 0.55;

function camera(overrides: Partial<Camera> = {}): Camera {
  return {
    metresPerPixel: DEFAULT_METRES_PER_PIXEL,
    centre: { x: 500, y: 500 },
    overview: false,
    ...overrides,
  };
}

/** effectiveScale only reads width/height, so a stub is the honest fixture. */
const CANVAS = { width: 800, height: 600 } as HTMLCanvasElement;

describe("map zoom", () => {
  it("zooms in when the wheel goes up and out when it goes down", () => {
    const inward = camera();
    applyZoom(inward, -1);
    expect(inward.metresPerPixel).toBeLessThan(DEFAULT_METRES_PER_PIXEL);

    const outward = camera();
    applyZoom(outward, 1);
    expect(outward.metresPerPixel).toBeGreaterThan(DEFAULT_METRES_PER_PIXEL);
  });

  it("clamps at both ends however long the wheel is spun", () => {
    const close = camera();
    for (let i = 0; i < 100; i++) applyZoom(close, -1);
    expect(close.metresPerPixel).toBeCloseTo(0.2);

    const far = camera();
    for (let i = 0; i < 100; i++) applyZoom(far, 1);
    expect(far.metresPerPixel).toBeCloseTo(2.0);
  });

  it("treats a zero delta as no input", () => {
    const still = camera({ overview: true });
    applyZoom(still, 0);
    expect(still.metresPerPixel).toBe(DEFAULT_METRES_PER_PIXEL);
    expect(still.overview).toBe(true);
  });

  it("drops the whole-map view, so the wheel is never a dead control", () => {
    // Overview fits the map to the window and ignores metresPerPixel, so a
    // wheel that left the mode alone would visibly do nothing.
    const wide = camera({ overview: true });
    const fitted = effectiveScale(wide, CANVAS, 1000);

    applyZoom(wide, -1);

    expect(wide.overview).toBe(false);
    expect(effectiveScale(wide, CANVAS, 1000)).not.toBe(fitted);
    expect(effectiveScale(wide, CANVAS, 1000)).toBe(wide.metresPerPixel);
  });
});

describe("optic magnification", () => {
  it("magnifies on wheel up, matching the map view's direction", () => {
    expect(stepMagnification(1, -1)).toBeGreaterThan(1);
    expect(stepMagnification(2, 1)).toBeLessThan(2);
  });

  it("never exceeds the bound the rules set", () => {
    // The whole reason the bound lives in rules.ts: this is the number that
    // decides how much of the map a player can read at range.
    let magnification = rules.OPTIC_MIN_MAGNIFICATION;
    for (let i = 0; i < 100; i++) magnification = stepMagnification(magnification, -1);
    expect(magnification).toBe(rules.OPTIC_MAX_MAGNIFICATION);
  });

  it("never drops below 1x, so the wheel cannot shrink the world", () => {
    let magnification = rules.OPTIC_MAX_MAGNIFICATION;
    for (let i = 0; i < 100; i++) magnification = stepMagnification(magnification, 1);
    expect(magnification).toBe(rules.OPTIC_MIN_MAGNIFICATION);
  });

  it("treats a zero delta as no input", () => {
    expect(stepMagnification(2.5, 0)).toBe(2.5);
  });
});
