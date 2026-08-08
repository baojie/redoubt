/**
 * The grass field's placement rules.
 *
 * The field is re-laid every couple of metres the player walks, which is only
 * invisible if two things hold: a clump's position depends on its cell and not
 * on when the field was laid, and clumps at the edge are drawn at nothing. Both
 * are pure functions, and both are the kind of thing that fails silently — the
 * symptom is grass crawling underfoot or popping into existence, neither of
 * which any assertion elsewhere would catch.
 */

import { describe, expect, it } from "vitest";
import { clumpAt, fadeScale } from "../src/grassField.js";
import { groundTint, patchNoise } from "../src/groundTexture.js";

const CELL_M = 2;

describe("clumpAt", () => {
  it("is a pure function of cell, index and seed", () => {
    const first = clumpAt(12, -7, 2, 99);
    const again = clumpAt(12, -7, 2, 99);
    expect(again).toEqual(first);
  });

  it("puts every clump inside its own cell", () => {
    for (let cx = -3; cx <= 3; cx++) {
      for (let cy = -3; cy <= 3; cy++) {
        for (let k = 0; k < 4; k++) {
          const clump = clumpAt(cx, cy, k, 7);
          expect(clump.x).toBeGreaterThanOrEqual(cx * CELL_M);
          expect(clump.x).toBeLessThan((cx + 1) * CELL_M);
          expect(clump.y).toBeGreaterThanOrEqual(cy * CELL_M);
          expect(clump.y).toBeLessThan((cy + 1) * CELL_M);
        }
      }
    }
  });

  it("does not stack the clumps of one cell on top of each other", () => {
    const places = new Set<string>();
    for (let k = 0; k < 4; k++) {
      const clump = clumpAt(5, 5, k, 1);
      places.add(`${clump.x.toFixed(4)},${clump.y.toFixed(4)}`);
    }
    expect(places.size).toBe(4);
  });

  it("gives different cells different layouts", () => {
    expect(clumpAt(0, 0, 0, 1)).not.toEqual(clumpAt(1, 0, 0, 1));
    // The same cell on a different map is a different field.
    expect(clumpAt(0, 0, 0, 1).yaw).not.toBeCloseTo(clumpAt(0, 0, 0, 2).yaw, 5);
  });

  it("keeps yaw and size in usable ranges", () => {
    for (let k = 0; k < 200; k++) {
      const clump = clumpAt(k, k * 3, k % 4, 42);
      expect(clump.yaw).toBeGreaterThanOrEqual(0);
      expect(clump.yaw).toBeLessThan(Math.PI * 2);
      expect(clump.size).toBeGreaterThan(0.5);
      expect(clump.size).toBeLessThan(1.5);
      expect(clump.shade).toBeGreaterThan(0.7);
      expect(clump.shade).toBeLessThan(1.3);
    }
  });
});

describe("fadeScale", () => {
  it("is full size underfoot and nothing at the edge", () => {
    expect(fadeScale(0)).toBe(1);
    expect(fadeScale(10)).toBe(1);
    expect(fadeScale(30)).toBe(0);
    expect(fadeScale(1000)).toBe(0);
  });

  it("shrinks monotonically across the fade band", () => {
    let previous = 1;
    for (let d = 20; d <= 31; d += 0.5) {
      const scale = fadeScale(d);
      expect(scale).toBeLessThanOrEqual(previous);
      expect(scale).toBeGreaterThanOrEqual(0);
      previous = scale;
    }
  });
});

describe("groundTint", () => {
  it("is deterministic, so the mesh and the clumps on it agree", () => {
    expect(groundTint(123.5, 44.25, 1, 9)).toEqual(groundTint(123.5, 44.25, 1, 9));
  });

  it("stays a sane multiplier everywhere on a map", () => {
    for (let x = 0; x < 1000; x += 37) {
      for (let y = 0; y < 1000; y += 41) {
        const tint = groundTint(x, y, 0.95, 3);
        for (const channel of [tint.r, tint.g, tint.b]) {
          expect(channel).toBeGreaterThan(0.4);
          expect(channel).toBeLessThan(1.8);
        }
      }
    }
  });

  it("takes the green out of a steep face", () => {
    const flat = groundTint(200, 200, 1, 3);
    const cliff = groundTint(200, 200, 0.5, 3);
    // Bare earth: redder than the grass it replaced, and much less blue.
    expect(cliff.r / cliff.g).toBeGreaterThan(flat.r / flat.g);
    expect(cliff.b).toBeLessThan(flat.b);
  });

  it("varies over tens of metres, not metres", () => {
    const here = groundTint(500, 500, 1, 5);
    const stride = groundTint(502, 500, 1, 5);
    // Somewhere within a few patch widths there has to be a different field, or
    // the "variation" is a constant with extra steps.
    const far = [500, 525, 550, 575, 600, 625, 650].map((x) => groundTint(x, 500, 1, 5).r);
    const spread = Math.max(...far) - Math.min(...far);
    expect(spread).toBeGreaterThan(0.08);
    // A pace has to be small against that, or the ground shimmers as you walk.
    expect(Math.abs(stride.r - here.r)).toBeLessThan(spread / 4);
  });
});

describe("patchNoise", () => {
  it("stays in [0, 1]", () => {
    for (let i = 0; i < 500; i++) {
      const value = patchNoise(i * 0.37, i * -0.11, 17);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("is continuous — no lattice creases", () => {
    let previous = patchNoise(0, 0, 4);
    for (let x = 0.01; x < 6; x += 0.01) {
      const value = patchNoise(x, 0, 4);
      expect(Math.abs(value - previous)).toBeLessThan(0.05);
      previous = value;
    }
  });
});
