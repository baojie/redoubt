/**
 * Fitting surfaces to cover volumes.
 *
 * The drawing needs a canvas and is judged by looking at it. These two pieces
 * are neither: getting the UV fitting wrong makes bricks the wrong size on only
 * some faces of only some buildings, and getting the normal conversion wrong
 * lights every wall from the wrong side. Both fail quietly, which is exactly
 * why they are worth pinning down.
 */

import { describe, expect, it } from "vitest";
import { faceTileCounts, heightToNormals } from "../src/buildingTextures.js";

/** A flat greyscale relief image at one value, as RGBA bytes. */
function flat(width: number, rows: number, value: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * rows * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = value;
    pixels[i + 1] = value;
    pixels[i + 2] = value;
    pixels[i + 3] = 255;
  }
  return pixels;
}

/**
 * Tolerance for a component that should be zero.
 *
 * A normal map is bytes, and zero encodes as 127.5, which does not exist — it
 * rounds to 128 and reads back as 1/255. Anything tighter than one step is
 * asking the format for precision it does not have.
 */
const BYTE_STEP = 1 / 255 + 1e-9;

/** Read one normal back as signed components in [-1, 1]. */
function normalAt(
  normals: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
): { x: number; y: number; z: number } {
  const o = (y * width + x) * 4;
  return {
    x: (normals[o]! / 255) * 2 - 1,
    y: (normals[o + 1]! / 255) * 2 - 1,
    z: (normals[o + 2]! / 255) * 2 - 1,
  };
}

describe("fitting a tile to a volume", () => {
  it("gives a cube of exactly one tile a single tile on every face", () => {
    for (const face of faceTileCounts(3, 3, 3, 3)) {
      expect(face.u).toBe(1);
      expect(face.v).toBe(1);
    }
  });

  it("spans each face's own two dimensions, not the unit square", () => {
    // A barn: 12 m along x, 3 m tall, 6 m deep, on a 3 m tile.
    const [plusX, minusX, roof, floor, plusZ] = faceTileCounts(12, 3, 6, 3);

    // Looking at the +x side you see the depth across and the height up.
    expect(plusX).toEqual({ u: 2, v: 1 });
    expect(minusX).toEqual({ u: 2, v: 1 });
    // The roof is width by depth: no height in it at all.
    expect(roof).toEqual({ u: 4, v: 2 });
    expect(floor).toEqual({ u: 4, v: 2 });
    // The long side is width across, height up.
    expect(plusZ).toEqual({ u: 4, v: 1 });
  });

  it("changes only the faces a dimension actually appears on", () => {
    // The check that catches a swapped axis. Making the volume taller must not
    // touch the roof, and making it wider must not touch the ends.
    const base = faceTileCounts(12, 3, 6, 3);
    const taller = faceTileCounts(12, 6, 6, 3);
    const wider = faceTileCounts(24, 3, 6, 3);

    expect(taller[2]).toEqual(base[2]!); // roof unchanged by height
    expect(taller[4]!.v).toBe(base[4]!.v * 2); // long side twice as tall
    expect(wider[0]).toEqual(base[0]!); // ends unchanged by width
    expect(wider[2]!.u).toBe(base[2]!.u * 2); // roof twice as long
  });

  it("scales inversely with the tile size, so a smaller tile repeats more", () => {
    const coarse = faceTileCounts(12, 3, 6, 3);
    const fine = faceTileCounts(12, 3, 6, 1.5);
    expect(fine[4]!.u).toBe(coarse[4]!.u * 2);
    expect(fine[4]!.v).toBe(coarse[4]!.v * 2);
  });
});

describe("height to normals", () => {
  it("turns flat relief into normals that all point straight out", () => {
    const normals = heightToNormals(flat(8, 8, 128), 8, 8);
    expect(normals.length).toBe(8 * 8 * 4);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const n = normalAt(normals, 8, x, y);
        expect(Math.abs(n.x)).toBeLessThanOrEqual(BYTE_STEP);
        expect(Math.abs(n.y)).toBeLessThanOrEqual(BYTE_STEP);
        expect(n.z).toBeCloseTo(1, 2);
      }
    }
  });

  it("tilts away from rising ground, with the sign a light can use", () => {
    // A ramp climbing in +x. The surface normal of a slope going up to the
    // right leans to the left, so its x component is negative — get this
    // backwards and every wall in the game is lit from the wrong side.
    const width = 16;
    const pixels = flat(width, 4, 0);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < width; x++) {
        pixels[(y * width + x) * 4] = (x / (width - 1)) * 255;
      }
    }

    const normals = heightToNormals(pixels, width, 4);
    // Sampled mid-ramp, away from the wrap at either end.
    const n = normalAt(normals, width, 8, 2);
    expect(n.x).toBeLessThan(-0.05);
    expect(Math.abs(n.y)).toBeLessThanOrEqual(BYTE_STEP);
    expect(n.z).toBeGreaterThan(0);
  });

  it("wraps at the edges, so a tiled wall has no seam down it", () => {
    // One raised column, at x = 0. Its left-hand neighbour is the last column,
    // so if sampling clamped instead of wrapping the normal at x = 0 would come
    // back flat — and every tile boundary in the world would light differently
    // from the wall it is part of.
    const width = 8;
    const pixels = flat(width, 4, 40);
    for (let y = 0; y < 4; y++) pixels[(y * width + 0) * 4] = 220;

    const normals = heightToNormals(pixels, width, 4);
    const atSeam = normalAt(normals, width, width - 1, 2);
    // The last column sits below the first, so the surface climbs to its right.
    expect(atSeam.x).toBeLessThan(-0.05);
  });

  it("leans harder as the strength rises", () => {
    const width = 16;
    const pixels = flat(width, 4, 0);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < width; x++) {
        pixels[(y * width + x) * 4] = (x / (width - 1)) * 255;
      }
    }

    const gentle = normalAt(heightToNormals(pixels, width, 4, 1), width, 8, 2);
    const strong = normalAt(heightToNormals(pixels, width, 4, 4), width, 8, 2);
    expect(strong.x).toBeLessThan(gentle.x);
    expect(strong.z).toBeLessThan(gentle.z);
  });
});
