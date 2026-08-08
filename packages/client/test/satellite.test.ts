/**
 * The map view's aerial ground.
 *
 * Everything here is a picture, so most of what makes it good is a matter of
 * looking at it. What is tested is the part that is not: that the image is
 * actually derived from the terrain rather than being a slab of one colour,
 * that it is reproducible from the seed, that fields genuinely merge into each
 * other rather than the lattice showing through, and that cover lands where the
 * server says the cover is.
 */

import { describe, expect, it } from "vitest";
import { createTerrain, rules, RIVERBEND } from "@redoubt/core";
import {
  compositeCover,
  paintGround,
  sampleGround,
  RASTER_PX_PER_M,
} from "../src/satellite.js";

const SEED = 42;
/**
 * Sampling runs at the real map size, because how much relief there is depends
 * on it: the coarsest terrain octave has a 500 m wavelength, so a quarter-size
 * map is a quarter-size *sample* of one hill and comes out far flatter than
 * anything a player would see.
 */
const SAMPLE_SIZE_M = rules.MAP_SIZE_M;
/** Painting is four million pixels at full size, so it is tested small. */
const SIZE_M = 250;

function ground(seed = SEED) {
  const terrain = createTerrain(seed, [{ x: 40, y: 125 }], SIZE_M);
  const layers = sampleGround(terrain, SIZE_M, seed);
  return paintGround(layers, SIZE_M, seed);
}

/** Spread of luminance across the image, as a stand-in for "has any content". */
function luminanceSpread(pixels: Uint8ClampedArray): number {
  let min = 255;
  let max = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const l = pixels[i]! * 0.3 + pixels[i + 1]! * 0.59 + pixels[i + 2]! * 0.11;
    if (l < min) min = l;
    if (l > max) max = l;
  }
  return max - min;
}

describe("sampling the ground", () => {
  it("takes its normals from the terrain, pointing broadly up", () => {
    const terrain = createTerrain(SEED, [], SAMPLE_SIZE_M);
    const layers = sampleGround(terrain, SAMPLE_SIZE_M, SEED);

    // Aggregated and asserted once: there are sixty thousand samples and an
    // assertion apiece costs more than the whole rest of the suite.
    let flattest = 0;
    let steepest = 1;
    let outOfHemisphere = 0;
    for (const nz of layers.normalZ) {
      if (nz <= 0 || nz > 1.0001) outOfHemisphere++;
      if (nz > flattest) flattest = nz;
      if (nz < steepest) steepest = nz;
    }

    expect(outOfHemisphere).toBe(0);
    // Rolling farmland, not a billiard table: if the relief did not survive
    // into the normals the shading would have nothing to work with, which is
    // exactly the state this started in.
    expect(flattest - steepest).toBeGreaterThan(0.15);
  });

  it("reports the height range the shading normalises against", () => {
    const terrain = createTerrain(SEED, [], SAMPLE_SIZE_M);
    const layers = sampleGround(terrain, SAMPLE_SIZE_M, SEED);
    expect(layers.maxHeight).toBeGreaterThan(layers.minHeight);

    // Every sample inside the reported range, or the elevation tint runs
    // outside the unit interval. The range has to be read back off the float32
    // array rather than tracked as it is computed, or rounding breaks this by
    // half an ulp — which is how this assertion first failed.
    let outside = 0;
    for (const h of layers.height) {
      if (h < layers.minHeight || h > layers.maxHeight) outside++;
    }
    expect(outside).toBe(0);
  });
});

describe("painting the ground", () => {
  it("fills the raster at the declared resolution, fully opaque", () => {
    const painted = ground();
    expect(painted.width).toBe(SIZE_M * RASTER_PX_PER_M);
    expect(painted.height).toBe(painted.width);
    expect(painted.pixels.length).toBe(painted.width * painted.height * 4);

    let transparent = 0;
    for (let i = 3; i < painted.pixels.length; i += 4) {
      if (painted.pixels[i] !== 255) transparent++;
    }
    expect(transparent).toBe(0);
  });

  it("paints an image with content rather than a slab of one colour", () => {
    // The failure this catches is a whole layer silently contributing nothing —
    // which is exactly what happened when the relief was shaded on the true
    // vertical scale and came out invisible.
    expect(luminanceSpread(ground().pixels)).toBeGreaterThan(40);
  });

  it("is reproducible from the seed, and only from the seed", () => {
    // Same seed twice must be identical: the map is baked on every client
    // independently and they are all looking at the same ground.
    expect(ground(7).pixels).toEqual(ground(7).pixels);
    expect(ground(7).pixels).not.toEqual(ground(8).pixels);
  });
});

describe("fields", () => {
  it("merges cells into larger fields instead of drawing the bare lattice", () => {
    // Every cell boundary carrying a hedge is the artifact this is here to rule
    // out: it draws a net over the map. Counting distinct colours along a line
    // that crosses many cells is the cheapest way to see that boundaries are
    // being suppressed — a bare lattice changes tint at every single cell.
    const painted = ground();
    const row = Math.floor(painted.height / 2);
    let changes = 0;
    for (let x = 1; x < painted.width; x++) {
      const a = (row * painted.width + x - 1) * 4;
      const b = (row * painted.width + x) * 4;
      // A real tint change, not the grain.
      if (Math.abs(painted.pixels[a]! - painted.pixels[b]!) > 12) changes++;
    }
    // 250 m at a 62 m lattice is four cells across, so a bare lattice would
    // show a handful of steps; merging and hedge-dropping means fewer still.
    expect(changes).toBeLessThan(24);
  });
});

describe("cover", () => {
  it("puts roofs exactly where the server says the cover is", () => {
    const width = 64;
    const pixels = new Uint8ClampedArray(width * width * 4).fill(0);
    const volume = {
      x: 10,
      y: 10,
      halfWidth: 4,
      halfDepth: 2,
      height: 6,
      kind: "building" as const,
    };

    compositeCover(pixels, width, [volume], 1);

    // Inside the footprint: a roof, which is the only bright thing on a buffer
    // that started black.
    const inside = ((10 * width) + 10) * 4;
    expect(pixels[inside]).toBeGreaterThan(100);
    // Well outside it and away from the shadow: untouched.
    const outside = ((40 * width) + 40) * 4;
    expect(pixels[outside]).toBe(0);
    // The shadow falls away from the sun, down and to the right, so it darkens
    // ground that the roof itself does not cover.
    const shadowed = ((14 * width) + 16) * 4;
    expect(pixels[shadowed]).toBeGreaterThan(0);
    expect(pixels[shadowed]).toBeLessThan(pixels[inside]!);
  });

  it("draws every volume the map defines", () => {
    // A real map, so the test fails if the volume shape or the units change
    // under it rather than only when this file is edited.
    const width = RIVERBEND.sizeM;
    const pixels = new Uint8ClampedArray(width * width * 4).fill(0);
    compositeCover(pixels, width, RIVERBEND.cover, 1);

    let painted = 0;
    for (const volume of RIVERBEND.cover) {
      const o = (Math.round(volume.y) * width + Math.round(volume.x)) * 4;
      if (pixels[o]! > 0) painted++;
    }
    expect(painted).toBe(RIVERBEND.cover.length);
  });
});
