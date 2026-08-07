/**
 * The number table itself. These tests pin the design anchors from PLAN §2 so
 * that a balance tweak that breaks a documented rule fails loudly.
 */

import { describe, expect, it } from "vitest";
import { rules } from "../src/index.js";

describe("build speed curve", () => {
  it("takes 40 seconds for one soldier to build a habitat", () => {
    const spec = rules.DEPLOYABLE_SPECS.habitat;
    const seconds = spec.buildWorkSeconds / rules.buildSpeedMultiplier(1);
    expect(seconds).toBe(40);
  });

  it("takes 4 seconds for five soldiers — the whole point of the rule", () => {
    const spec = rules.DEPLOYABLE_SPECS.habitat;
    const seconds = spec.buildWorkSeconds / rules.buildSpeedMultiplier(5);
    expect(seconds).toBe(4);
  });

  it("is strictly super-linear, so bringing friends always pays", () => {
    for (let n = 1; n < 5; n++) {
      const slower = rules.buildSpeedMultiplier(n);
      const faster = rules.buildSpeedMultiplier(n + 1);
      expect(faster).toBeGreaterThan(slower + 1);
    }
  });

  it("stops rewarding builders past the end of the curve", () => {
    const capped = rules.buildSpeedMultiplier(rules.BUILD_SPEED_BY_BUILDER_COUNT.length);
    expect(rules.buildSpeedMultiplier(50)).toBe(capped);
  });

  it("gives nobody nothing", () => {
    expect(rules.buildSpeedMultiplier(0)).toBe(0);
    expect(rules.buildSpeedMultiplier(-3)).toBe(0);
  });
});

describe("capture speed", () => {
  it("is a flat rate for a lone attacker", () => {
    expect(rules.captureSpeedMultiplier(1)).toBe(1);
  });

  it("accelerates with numeric advantage but is capped", () => {
    expect(rules.captureSpeedMultiplier(2)).toBeGreaterThan(1);
    expect(rules.captureSpeedMultiplier(100)).toBe(rules.CAPTURE_MAX_SPEED_MULTIPLIER);
  });

  it("is zero without an advantage — a contested flag does not tick over", () => {
    expect(rules.captureSpeedMultiplier(0)).toBe(0);
    expect(rules.captureSpeedMultiplier(-4)).toBe(0);
  });
});

describe("a usable FOB costs 600 construction points", () => {
  it("matches the habitat + ammo crate figure in the design", () => {
    const cost =
      rules.DEPLOYABLE_SPECS.habitat.constructionCost +
      rules.DEPLOYABLE_SPECS.ammoCrate.constructionCost;
    expect(cost).toBe(600);
  });

  it("is well inside one logistics truck's construction capacity", () => {
    expect(rules.VEHICLE_SPECS.logistics.maxCargoConstructionPoints).toBeGreaterThan(600);
  });
});

describe("hit chance falloff", () => {
  it("decreases monotonically with range", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let r = 0; r <= rules.ENGAGEMENT_MAX_RANGE_M; r += 10) {
      const chance = rules.hitChanceAtRange(r);
      expect(chance).toBeLessThan(previous);
      previous = chance;
    }
  });

  it("is zero beyond engagement range", () => {
    expect(rules.hitChanceAtRange(rules.ENGAGEMENT_MAX_RANGE_M)).toBe(0);
    expect(rules.hitChanceAtRange(rules.ENGAGEMENT_MAX_RANGE_M + 1)).toBe(0);
  });
});

describe("tick conversion", () => {
  it("never rounds a duration short", () => {
    expect(rules.secondsToTicks(1)).toBe(rules.TICK_RATE_HZ);
    expect(rules.secondsToTicks(0.01)).toBeGreaterThanOrEqual(1);
    expect(rules.ticksToSeconds(rules.secondsToTicks(3))).toBeGreaterThanOrEqual(3);
  });
});
