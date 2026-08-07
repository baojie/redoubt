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

describe("ballistics", () => {
  it("drops rounds measurably at range, and quadratically", () => {
    // Real drop, not a fudge factor: doubling the range quadruples the drop.
    const near = rules.bulletDropM(200);
    const far = rules.bulletDropM(400);
    expect(near).toBeGreaterThan(0.1);
    expect(far / near).toBeCloseTo(4, 1);
  });

  it("gives rounds a travel time worth leading a target for", () => {
    // A soldier crossing at walking pace moves several body widths in the
    // time a round takes to reach them at range.
    const flight = rules.flightTimeSeconds(300);
    expect(flight).toBeGreaterThan(0.3);
    expect(flight * rules.PLAYER_SPEED_MPS).toBeGreaterThan(1);
  });
});

describe("weapon spread", () => {
  it("is tightest standing still, unsuppressed, on the first round", () => {
    const best = rules.weaponSpreadRad({ moving: false, suppression: 0, recoilSteps: 0 });
    expect(best).toBe(rules.WEAPON_BASE_SPREAD_RAD);
  });

  it("is widened by movement, suppression and recoil independently", () => {
    const base = rules.weaponSpreadRad({ moving: false, suppression: 0, recoilSteps: 0 });
    const moving = rules.weaponSpreadRad({ moving: true, suppression: 0, recoilSteps: 0 });
    const suppressed = rules.weaponSpreadRad({ moving: false, suppression: 1, recoilSteps: 0 });
    const spraying = rules.weaponSpreadRad({ moving: false, suppression: 0, recoilSteps: 4 });

    expect(moving).toBeGreaterThan(base);
    expect(suppressed).toBeGreaterThan(base);
    expect(spraying).toBeGreaterThan(base);
  });

  it("compounds them, so doing everything wrong at once is worst", () => {
    const everything = rules.weaponSpreadRad({
      moving: true,
      suppression: 1,
      recoilSteps: rules.RECOIL_MAX_STEPS,
    });
    const justMoving = rules.weaponSpreadRad({ moving: true, suppression: 0, recoilSteps: 0 });
    expect(everything).toBeGreaterThan(justMoving);
  });

  it("is tightened by aiming, but cannot rescue a sprinting spray", () => {
    // Aiming scales the whole cone rather than subtracting a constant, so it
    // helps most when you are already steady — which is the behaviour that
    // makes standing still and aiming the *good* option rather than the only
    // option.
    const steady = { moving: false, suppression: 0, recoilSteps: 0 };
    const messy = { moving: true, suppression: 1, recoilSteps: rules.RECOIL_MAX_STEPS };

    const steadyGain =
      rules.weaponSpreadRad(steady) / rules.weaponSpreadRad({ ...steady, aiming: true });
    const messyGain =
      rules.weaponSpreadRad(messy) / rules.weaponSpreadRad({ ...messy, aiming: true });

    expect(rules.weaponSpreadRad({ ...steady, aiming: true })).toBeLessThan(
      rules.weaponSpreadRad(steady),
    );
    // Same proportional help, but from a far worse starting point.
    expect(steadyGain).toBeCloseTo(messyGain, 6);
    expect(rules.weaponSpreadRad({ ...messy, aiming: true })).toBeGreaterThan(
      rules.weaponSpreadRad(steady),
    );
  });

  it("saturates recoil rather than growing without bound", () => {
    const atCap = rules.weaponSpreadRad({
      moving: false,
      suppression: 0,
      recoilSteps: rules.RECOIL_MAX_STEPS,
    });
    const wayPast = rules.weaponSpreadRad({
      moving: false,
      suppression: 0,
      recoilSteps: rules.RECOIL_MAX_STEPS * 10,
    });
    expect(wayPast).toBe(atCap);
  });
});

describe("tick conversion", () => {
  it("never rounds a duration short", () => {
    expect(rules.secondsToTicks(1)).toBe(rules.TICK_RATE_HZ);
    expect(rules.secondsToTicks(0.01)).toBeGreaterThanOrEqual(1);
    expect(rules.ticksToSeconds(rules.secondsToTicks(3))).toBeGreaterThanOrEqual(3);
  });
});
