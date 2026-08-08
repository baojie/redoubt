/**
 * The held weapon, in the parts that can be checked without a screen.
 *
 * Most of a viewmodel is a matter of taste and has to be looked at. Two things
 * are not: the rifle's proportions, which two different callers depend on, and
 * the reload timing, which is the one place the animation makes a claim about
 * the rules — that the weapon is back up exactly when the player can fire
 * again. Both are pure functions of numbers, so both get tested.
 */

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { rules } from "@redoubt/core";
import { buildRifle, muzzleOffset, sightHeight } from "../src/rifle.js";
import { reloadFraction } from "../src/viewmodel.js";

const MATERIAL = new THREE.MeshStandardMaterial();

function boundsOf(object: THREE.Object3D): THREE.Box3 {
  return new THREE.Box3().setFromObject(object);
}

describe("rifle geometry", () => {
  it("is exactly as long as it was asked to be", () => {
    // The callers place it by its length — the soldier scales it off their own
    // shoulders, the viewmodel sizes it against the field of view. A rifle that
    // is quietly 30% longer than its stated length would poke through cover on
    // one and fill the screen on the other.
    for (const length of [0.4, 0.6, 1.2]) {
      const bounds = boundsOf(buildRifle(length, MATERIAL, true));
      expect(bounds.max.z - bounds.min.z).toBeCloseTo(length, 6);
    }
  });

  it("scales linearly, so proportions cannot drift with size", () => {
    const small = boundsOf(buildRifle(0.5, MATERIAL, true));
    const large = boundsOf(buildRifle(1, MATERIAL, true));
    const smallSize = small.getSize(new THREE.Vector3());
    const largeSize = large.getSize(new THREE.Vector3());
    expect(largeSize.x).toBeCloseTo(smallSize.x * 2, 6);
    expect(largeSize.y).toBeCloseTo(smallSize.y * 2, 6);
    expect(largeSize.z).toBeCloseTo(smallSize.z * 2, 6);
  });

  it("points its muzzle along -z, which is what both callers assume", () => {
    // Documented in rifle.ts and relied on twice: the soldier turns the rifle
    // to face the way they do, and the viewmodel points it down the view axis.
    // If this flipped, every soldier on the map would carry their rifle
    // backwards and nothing would throw.
    const bounds = boundsOf(buildRifle(1, MATERIAL, true));
    expect(bounds.min.z).toBeLessThan(0);
    // The origin is the grip, so most of the weapon lies in front of it.
    expect(Math.abs(bounds.min.z)).toBeGreaterThan(Math.abs(bounds.max.z));
  });

  it("drops the close-up parts when they would not be visible", () => {
    const simple = buildRifle(1, MATERIAL, false).children.length;
    const detailed = buildRifle(1, MATERIAL, true).children.length;
    expect(simple).toBeLessThan(detailed);
    // Cheap enough for two dozen soldiers on screen at once.
    expect(simple).toBeLessThanOrEqual(3);
  });

  it("puts the muzzle at the end of the barrel", () => {
    // The flash hangs here and the player's own tracer starts here. If the two
    // ever drift apart, rounds appear to leave a point in mid-air — and nothing
    // would throw, because both numbers are individually reasonable.
    for (const length of [0.6, 1.4]) {
      const bounds = boundsOf(buildRifle(length, MATERIAL, true));
      expect(muzzleOffset(length)).toBeCloseTo(bounds.min.z, 6);
    }
  });

  it("puts the sights above the receiver", () => {
    // The aiming pose lowers the weapon by exactly this, so a wrong sign here
    // would raise the sights out of view instead of onto the crosshair.
    expect(sightHeight(1)).toBeGreaterThan(0);
    expect(sightHeight(2)).toBeCloseTo(sightHeight(1) * 2, 6);
  });
});

describe("reload dip", () => {
  const total = rules.RELOAD_TICKS;

  it("is flat when there is no reload to show", () => {
    expect(reloadFraction(0, 500)).toBe(0);
    expect(reloadFraction(100, 100)).toBe(0);
    expect(reloadFraction(100, 300)).toBe(0);
  });

  it("is level at both ends and dipped in between", () => {
    // Level at the start so the dip begins from the carry pose, and level at
    // the end so the weapon is up on the tick firing becomes legal again —
    // that is the whole claim the animation makes.
    const start = 0;
    expect(reloadFraction(total, start)).toBeCloseTo(0, 6);
    expect(reloadFraction(total, start + total)).toBe(0);
    expect(reloadFraction(total, start + Math.floor(total / 2))).toBeGreaterThan(0.9);
  });

  it("never leaves the range the pose blends across", () => {
    for (let tick = -5; tick <= total + 5; tick++) {
      const value = reloadFraction(total, tick);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("follows the rules table rather than a hard-coded duration", () => {
    // Half way through by the table's own reckoning should be the bottom of
    // the dip whatever the table says, so retuning the reload cannot silently
    // desynchronise the animation from the rule.
    const midpoint = reloadFraction(total, Math.round(total / 2));
    expect(midpoint).toBeGreaterThan(reloadFraction(total, Math.round(total * 0.9)));
    expect(midpoint).toBeGreaterThan(reloadFraction(total, Math.round(total * 0.1)));
  });
});
