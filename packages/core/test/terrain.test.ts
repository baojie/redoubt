/**
 * Terrain.
 *
 * The property that matters most is not that it looks good — it is that the
 * server, the client and a headless batch run all compute the *same* ground.
 * Authoritative hit registration depends on it: if the client draws a hill the
 * server does not have, players get shot through it.
 */

import { describe, expect, it } from "vitest";
import {
  EYE_HEIGHT_M,
  RIVERBEND,
  TERRAIN_BASE_M,
  TERRAIN_RELIEF_M,
  Terrain,
  createTerrain,
  rules,
} from "../src/index.js";

const MAIN_BASES = [RIVERBEND.mainBases[0], RIVERBEND.mainBases[1]];

function sampleGrid(terrain: Terrain, step = 25): number[] {
  const heights: number[] = [];
  for (let x = 0; x <= rules.MAP_SIZE_M; x += step) {
    for (let y = 0; y <= rules.MAP_SIZE_M; y += step) {
      heights.push(terrain.heightAt(x, y));
    }
  }
  return heights;
}

describe("determinism", () => {
  it("gives the same ground for the same seed, every time", () => {
    const a = createTerrain(1234, MAIN_BASES);
    const b = createTerrain(1234, MAIN_BASES);
    expect(sampleGrid(a)).toEqual(sampleGrid(b));
  });

  it("does not depend on the order points are queried in", () => {
    const terrain = createTerrain(99, MAIN_BASES);
    const forwards: number[] = [];
    for (let x = 0; x <= 500; x += 50) forwards.push(terrain.heightAt(x, 300));
    const backwards: number[] = [];
    for (let x = 500; x >= 0; x -= 50) backwards.push(terrain.heightAt(x, 300));
    expect(forwards).toEqual([...backwards].reverse());
  });

  it("gives different ground for different seeds", () => {
    const a = sampleGrid(createTerrain(1, MAIN_BASES));
    const b = sampleGrid(createTerrain(2, MAIN_BASES));
    expect(a).not.toEqual(b);
  });
});

describe("shape", () => {
  it("stays within its stated relief", () => {
    const heights = sampleGrid(createTerrain(7, MAIN_BASES), 10);
    for (const h of heights) {
      expect(h).toBeGreaterThanOrEqual(TERRAIN_BASE_M - 1);
      expect(h).toBeLessThanOrEqual(TERRAIN_BASE_M + TERRAIN_RELIEF_M + 1);
    }
  });

  it("is continuous — no cliffs the renderer would tear on", () => {
    const terrain = createTerrain(11, MAIN_BASES);
    let worst = 0;
    for (let x = 100; x < 900; x += 7) {
      for (let y = 100; y < 900; y += 7) {
        const here = terrain.heightAt(x, y);
        worst = Math.max(worst, Math.abs(terrain.heightAt(x + 1, y) - here));
        worst = Math.max(worst, Math.abs(terrain.heightAt(x, y + 1) - here));
      }
    }
    // A metre of ground should never be a metre of climb at this relief.
    expect(worst).toBeLessThan(1);
  });

  it("actually undulates, rather than being a flat plane with extra steps", () => {
    const heights = sampleGrid(createTerrain(3, MAIN_BASES));
    const min = Math.min(...heights);
    const max = Math.max(...heights);
    expect(max - min).toBeGreaterThan(TERRAIN_RELIEF_M / 3);
  });
});

describe("fairness", () => {
  it("is mirror-symmetric about the centre line", () => {
    // The flags being mirrored is not enough. Once terrain blocks rounds, the
    // side with the better ground wins more, and unmirrored noise decides that
    // by seed rather than by play — it measured at a 68/32 split.
    const terrain = createTerrain(20260807, MAIN_BASES);
    for (let x = 0; x <= rules.MAP_SIZE_M / 2; x += 17) {
      for (let y = 0; y <= rules.MAP_SIZE_M; y += 37) {
        const here = terrain.heightAt(x, y);
        const mirrored = terrain.heightAt(rules.MAP_SIZE_M - x, y);
        expect(Math.abs(here - mirrored)).toBeLessThan(0.001);
      }
    }
  });

  it("levels both main bases to the same elevation", () => {
    const terrain = createTerrain(4242, MAIN_BASES);
    const blue = terrain.heightAt(MAIN_BASES[0]!.x, MAIN_BASES[0]!.y);
    const red = terrain.heightAt(MAIN_BASES[1]!.x, MAIN_BASES[1]!.y);
    // Neither side starts uphill of the other.
    expect(Math.abs(blue - red)).toBeLessThan(0.01);
  });

  it("keeps each main base pad flat enough to spawn on", () => {
    const terrain = createTerrain(31337, MAIN_BASES);
    for (const base of MAIN_BASES) {
      const centre = terrain.heightAt(base.x, base.y);
      for (const [dx, dy] of [
        [40, 0],
        [-40, 0],
        [0, 40],
        [0, -40],
      ]) {
        expect(Math.abs(terrain.heightAt(base.x + dx!, base.y + dy!) - centre)).toBeLessThan(
          0.01,
        );
      }
    }
  });
});

describe("derived positions", () => {
  it("puts eyes above the ground under them", () => {
    const terrain = createTerrain(5, MAIN_BASES);
    const eye = terrain.eyeAt(400, 600);
    expect(eye.z).toBeCloseTo(terrain.heightAt(400, 600) + EYE_HEIGHT_M, 9);
  });

  it("produces unit-length surface normals pointing upward", () => {
    const terrain = createTerrain(6, MAIN_BASES);
    for (const [x, y] of [
      [123, 456],
      [800, 200],
      [500, 500],
    ]) {
      const n = terrain.normalAt(x!, y!);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 9);
      expect(n.z).toBeGreaterThan(0);
    }
  });
});
