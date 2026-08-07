/**
 * The ground.
 *
 * A 1 km² heightfield generated entirely from the match seed. Nothing is
 * stored and nothing is shipped: the server, the client and a headless batch
 * run all call the same pure function and get the same hill, which is the only
 * way authoritative hit registration and client rendering can agree about what
 * a bullet hits.
 *
 * PLAN §1 calls the map the most expensive asset in the genre and procedural
 * generation the only viable path at this budget. This is that path — the
 * hand-placed landmarks it mentions go on top, as data, later.
 *
 * Deterministic by construction: value noise over an integer lattice, hashed
 * with the same integer mixing the RNG uses. No floating-point accumulation
 * across calls, so `heightAt(x, y)` is a genuine function — same inputs, same
 * output, on any machine, in any order, forever.
 */

import {
  BODY_HALF_HEIGHT_M,
  BODY_RADIUS_M,
  EYE_HEIGHT_M,
  MAP_SIZE_M,
  TORSO_HEIGHT_M,
} from "./rules.js";

export { BODY_HALF_HEIGHT_M, BODY_RADIUS_M, EYE_HEIGHT_M, TORSO_HEIGHT_M };

// ---------------------------------------------------------------------------
// Shape of the land
// ---------------------------------------------------------------------------

/**
 * Peak-to-trough relief. Deliberately modest: this is rolling farmland, not
 * mountains. Terrain that blocks line of sight everywhere would make the
 * 200 m engagement range meaningless, and terrain that blocks it nowhere makes
 * cover meaningless. Around 40 m over a kilometre gives ridges you can crest.
 */
export const TERRAIN_RELIEF_M = 42;

/** Base elevation, so the whole field sits above zero. */
export const TERRAIN_BASE_M = 8;

/** Metres per lattice cell of the coarsest noise layer. */
const BASE_FEATURE_SIZE_M = 500;

/** How many octaves of detail. Each halves the feature size and the amplitude. */
const OCTAVES = 4;

/** Amplitude falloff per octave. */
const PERSISTENCE = 0.5;

/**
 * Main bases and their approaches are flattened, so neither side spawns on a
 * slope or has to fight uphill out of a hole. Fairness beats scenery.
 */
const FLATTEN_RADIUS_M = 130;
const FLATTEN_FALLOFF_M = 90;

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

const HASH_A = 0x27d4eb2d;
const HASH_B = 0x165667b1;
const UINT32 = 4294967296;

/** Hash two lattice coordinates and a seed into a float in [0, 1). */
function latticeValue(ix: number, iy: number, seed: number): number {
  let h = (ix | 0) * HASH_A + (iy | 0) * HASH_B + (seed | 0);
  h = h >>> 0;
  h = Math.imul(h ^ (h >>> 15), 1 | h);
  h = (h ^ (h + Math.imul(h ^ (h >>> 7), 61 | h))) >>> 0;
  return ((h ^ (h >>> 14)) >>> 0) / UINT32;
}

/** Smoothstep, so the lattice does not show as a grid of creases. */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** One octave of value noise. */
function valueNoise(x: number, y: number, cellSize: number, seed: number): number {
  const gx = x / cellSize;
  const gy = y / cellSize;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = fade(gx - ix);
  const fy = fade(gy - iy);

  const v00 = latticeValue(ix, iy, seed);
  const v10 = latticeValue(ix + 1, iy, seed);
  const v01 = latticeValue(ix, iy + 1, seed);
  const v11 = latticeValue(ix + 1, iy + 1, seed);

  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

export interface TerrainOptions {
  seed: number;
  sizeM?: number;
  /** Positions to flatten around — main bases, so nobody spawns on a cliff. */
  flattenAround?: ReadonlyArray<{ x: number; y: number }>;
}

/**
 * A terrain instance. Cheap to construct and free to copy: it holds only the
 * seed and the flattening points, and computes everything on demand.
 */
export class Terrain {
  readonly seed: number;
  readonly sizeM: number;
  private readonly flatten: ReadonlyArray<{ x: number; y: number }>;
  /** Elevation the flattened areas are levelled to. */
  private readonly flattenHeight: number;

  constructor(options: TerrainOptions) {
    this.seed = options.seed | 0;
    this.sizeM = options.sizeM ?? MAP_SIZE_M;
    this.flatten = options.flattenAround ?? [];
    // Level to the mean, so flattening neither raises nor sinks the whole map.
    this.flattenHeight = TERRAIN_BASE_M + TERRAIN_RELIEF_M / 2;
  }

  /**
   * Ground elevation in metres at a map position.
   *
   * Mirror-symmetric about the map's centre line by construction: the noise is
   * sampled at the position *and* at its reflection and the two are averaged.
   *
   * This is not decoration. Once rounds are blocked by terrain, whichever side
   * holds the better ground wins more — and with unmirrored noise that is
   * decided by the seed rather than by play. Symmetric flags on asymmetric
   * ground measured at a 68/32 win split. Averaging rather than folding avoids
   * a crease down the middle of the map, at the cost of slightly gentler
   * relief.
   */
  heightAt(x: number, y: number): number {
    const mirroredX = this.sizeM - x;
    let amplitude = 1;
    let total = 0;
    let normalisation = 0;
    let cell = BASE_FEATURE_SIZE_M;

    for (let octave = 0; octave < OCTAVES; octave++) {
      const here = valueNoise(x, y, cell, this.seed + octave);
      const there = valueNoise(mirroredX, y, cell, this.seed + octave);
      total += ((here + there) / 2) * amplitude;
      normalisation += amplitude;
      amplitude *= PERSISTENCE;
      cell /= 2;
    }

    const raw = TERRAIN_BASE_M + (total / normalisation) * TERRAIN_RELIEF_M;
    return this.applyFlattening(x, y, raw);
  }

  /**
   * Blend toward a level pad near each flattening point. Inside the radius the
   * ground is flat; over the falloff it eases back into the natural surface.
   */
  private applyFlattening(x: number, y: number, raw: number): number {
    let height = raw;
    for (const centre of this.flatten) {
      const dx = x - centre.x;
      const dy = y - centre.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= FLATTEN_RADIUS_M + FLATTEN_FALLOFF_M) continue;
      const t = d <= FLATTEN_RADIUS_M ? 0 : (d - FLATTEN_RADIUS_M) / FLATTEN_FALLOFF_M;
      const blend = fade(t);
      height = this.flattenHeight + (height - this.flattenHeight) * blend;
    }
    return height;
  }

  /** Eye position of a soldier standing at a map position. */
  eyeAt(x: number, y: number): { x: number; y: number; z: number } {
    return { x, y, z: this.heightAt(x, y) + EYE_HEIGHT_M };
  }

  /** Centre-of-mass position — what you aim at and what a bullet must hit. */
  torsoAt(x: number, y: number): { x: number; y: number; z: number } {
    return { x, y, z: this.heightAt(x, y) + TORSO_HEIGHT_M };
  }

  /**
   * Surface normal, for the renderer's shading and for slope checks.
   * Central differences over a metre — plenty at this relief.
   */
  normalAt(x: number, y: number): { x: number; y: number; z: number } {
    const step = 1;
    const dzdx = (this.heightAt(x + step, y) - this.heightAt(x - step, y)) / (2 * step);
    const dzdy = (this.heightAt(x, y + step) - this.heightAt(x, y - step)) / (2 * step);
    const length = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
    return { x: -dzdx / length, y: -dzdy / length, z: 1 / length };
  }
}

/**
 * Build the terrain for a match. Main bases are flattened for fairness.
 *
 * Terrain is derived state, never stored in `GameState`: it is a pure function
 * of the seed, so anything holding the seed can reconstruct it exactly rather
 * than being sent it.
 */
export function createTerrain(
  seed: number,
  mainBases: ReadonlyArray<{ x: number; y: number }>,
  sizeM = MAP_SIZE_M,
): Terrain {
  return new Terrain({ seed, sizeM, flattenAround: mainBases });
}
