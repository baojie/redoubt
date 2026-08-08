/**
 * Surfaces for the things you take cover behind.
 *
 * Cover used to be flat-coloured boxes, which from across a field is fine and
 * from two metres away is grey cardboard. These give each kind of volume a
 * material: brick with windows for buildings, blockwork for walls, painted
 * corrugated steel for containers.
 *
 * Generated rather than imported, for the same two reasons the map imagery is:
 * CLAUDE.md forbids art taken from other games, and a generated surface can be
 * fitted to the volume it is on. That second point matters more than it sounds.
 * Cover volumes are all different sizes, and a texture stretched to fit each one
 * gives bricks that are half a metre wide on a barn and a hand's width on a
 * garden wall. Here the tile is a fixed number of *metres* and the UVs are
 * rescaled per volume, so a brick is a brick everywhere.
 *
 * Each surface carries a normal map derived from the same pattern that drew it,
 * so the mortar courses and the steel ribs catch the light instead of being
 * painted-on lines. That is most of the difference between "textured" and
 * "looks like a wall".
 */

import * as THREE from "three";

/** Texture resolution per tile. */
const TEXTURE_PX = 256;

/**
 * How much relief the normal maps imply, in the same arbitrary units the height
 * pass is drawn in.
 *
 * Started at 2.4, which photographed as a relief carving: every brick stood
 * proud of the mortar by something like half its own depth and the wall read as
 * Lego. Real brickwork is very nearly flush — the mortar course is a groove a
 * few millimetres deep, and all it has to do is catch a shadow.
 */
const NORMAL_STRENGTH = 0.6;

/** Brick geometry, over a 3 m tile: a 75 mm course, a 225 mm stretcher. */
const COURSES_PER_TILE = 40;
const BRICK_ASPECT = 3;

/** Ribs across a container's 1.2 m tile. Four is a 300 mm pitch, as built. */
const CONTAINER_RIBS = 4;

export interface Surface {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughness: number;
  metalness: number;
  /** Metres of wall covered by one tile of the texture. */
  tileM: number;
}

/**
 * One material per kind of cover, plus a roof.
 *
 * Built once and shared by every volume — the per-volume fitting happens in the
 * geometry's UVs, not in the material, so forty buildings still cost four
 * textures and not forty.
 */
export interface CoverSurfaces {
  building: Surface;
  buildingRoof: Surface;
  wall: Surface;
  container: Surface;
}

export function buildCoverSurfaces(): CoverSurfaces {
  return {
    // Three metres a tile: one storey, one row of windows.
    building: surface(3, 0.82, 0, drawBrick, heightBrick),
    buildingRoof: surface(2.4, 0.62, 0.25, drawRoof, heightRoof),
    wall: surface(1.6, 0.88, 0, drawBlockwork, heightBlockwork),
    container: surface(1.2, 0.55, 0.35, drawContainer, heightContainer),
  };
}

type Painter = (ctx: CanvasRenderingContext2D, size: number, rand: () => number) => void;

function surface(
  tileM: number,
  roughness: number,
  metalness: number,
  paint: Painter,
  emboss: Painter,
): Surface {
  const map = new THREE.CanvasTexture(render(paint, seedOf(paint)));
  const normalMap = new THREE.CanvasTexture(normalFrom(render(emboss, seedOf(paint))));
  for (const texture of [map, normalMap]) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    // The UVs already carry the repeat count, so leave `repeat` alone.
    texture.colorSpace = texture === map ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  }
  return { map, normalMap, roughness, metalness, tileM };
}

/**
 * The same seed for a surface's colour and its relief.
 *
 * They have to agree: a brick that is dark in the colour pass and flat in the
 * height pass reads as a stain rather than as a brick. Keyed off the painter
 * itself so the pairing cannot drift.
 */
function seedOf(paint: Painter): number {
  let hash = 0;
  for (const character of paint.name) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return hash;
}

function render(paint: Painter, seed: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_PX;
  canvas.height = TEXTURE_PX;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) paint(ctx, TEXTURE_PX, seededRandom(seed));
  return canvas;
}

// ---------------------------------------------------------------------------
// Colour passes
// ---------------------------------------------------------------------------

/** Brick courses, and a window, because a wall without one is a retaining wall. */
function drawBrick(ctx: CanvasRenderingContext2D, size: number, rand: () => number): void {
  // 40 courses to a 3 m tile is a 75 mm course, and 3:1 makes a 225 mm brick.
  // Both are the real thing. The first pass used 26 courses at 3.2:1, which put
  // a 1.1 m window at five bricks tall instead of nine.
  const courses = COURSES_PER_TILE;
  const courseH = size / courses;
  const brickW = courseH * BRICK_ASPECT;

  ctx.fillStyle = "#8d8177"; // mortar
  ctx.fillRect(0, 0, size, size);

  for (let row = 0; row < courses; row++) {
    // Stretcher bond: every other course offset by half a brick.
    const offset = row % 2 === 0 ? 0 : brickW / 2;
    for (let x = -brickW; x < size + brickW; x += brickW) {
      // Buff brick rather than engineering blue. Measured: the first pass came
      // out at 0.39 mean albedo against the flat colour's 0.58, and a wall that
      // dark reads as a shadow rather than as masonry.
      const shade = 0.82 + rand() * 0.36;
      const red = Math.min(255, 186 * shade);
      const green = Math.min(255, 134 * shade);
      const blue = Math.min(255, 112 * shade);
      ctx.fillStyle = `rgb(${red | 0}, ${green | 0}, ${blue | 0})`;
      ctx.fillRect(x + offset + 1, row * courseH + 1, brickW - 2, courseH - 2);
    }
  }

  window_(ctx, size, rand);
  weather(ctx, size, rand, 0.05);
}

/** Corrugated roof sheeting, run in bays with a seam between each. */
function drawRoof(ctx: CanvasRenderingContext2D, size: number, rand: () => number): void {
  ctx.fillStyle = "#70757a";
  ctx.fillRect(0, 0, size, size);

  const ribs = 18;
  for (let i = 0; i < ribs; i++) {
    const x = (i / ribs) * size;
    const lit = i % 2 === 0;
    ctx.fillStyle = lit ? "rgba(255, 252, 244, 0.10)" : "rgba(10, 12, 14, 0.14)";
    ctx.fillRect(x, 0, size / ribs / 2, size);
  }

  // Sheet ends, every third of the tile.
  ctx.fillStyle = "rgba(18, 20, 22, 0.5)";
  for (let y = 0; y < size; y += size / 3) ctx.fillRect(0, y, size, 2);

  weather(ctx, size, rand, 0.16);
}

/** Concrete blockwork: bigger courses than brick, greyer, more stained. */
function drawBlockwork(ctx: CanvasRenderingContext2D, size: number, rand: () => number): void {
  const courses = 8;
  const courseH = size / courses;
  const blockW = courseH * 2;

  ctx.fillStyle = "#7e7a72";
  ctx.fillRect(0, 0, size, size);

  for (let row = 0; row < courses; row++) {
    const offset = row % 2 === 0 ? 0 : blockW / 2;
    for (let x = -blockW; x < size + blockW; x += blockW) {
      const shade = 0.9 + rand() * 0.2;
      const value = Math.min(255, 150 * shade);
      ctx.fillStyle = `rgb(${value | 0}, ${(value * 0.98) | 0}, ${(value * 0.92) | 0})`;
      ctx.fillRect(x + offset + 1.5, row * courseH + 1.5, blockW - 3, courseH - 3);
    }
  }

  // Aggregate. Concrete photographs as speckle more than as anything else.
  for (let i = 0; i < size * 6; i++) {
    const grey = 90 + rand() * 90;
    ctx.fillStyle = `rgba(${grey | 0}, ${grey | 0}, ${(grey * 0.96) | 0}, 0.5)`;
    ctx.fillRect(rand() * size, rand() * size, 1, 1);
  }
  weather(ctx, size, rand, 0.12);
}

/** A shipping container: vertical ribs, paint, and rust where it collects. */
function drawContainer(ctx: CanvasRenderingContext2D, size: number, rand: () => number): void {
  // Measured at 0.28 mean albedo against the flat colour it replaced, 0.45.
  ctx.fillStyle = "#6d8161";
  ctx.fillRect(0, 0, size, size);

  const ribs = CONTAINER_RIBS;
  const ribW = size / ribs;
  for (let i = 0; i < ribs; i++) {
    const x = i * ribW;
    // A trapezoidal rib: lit face, flat top, shaded face.
    ctx.fillStyle = "rgba(255, 250, 236, 0.13)";
    ctx.fillRect(x, 0, ribW * 0.28, size);
    ctx.fillStyle = "rgba(8, 12, 8, 0.22)";
    ctx.fillRect(x + ribW * 0.62, 0, ribW * 0.38, size);
  }

  // Rust starts at the bottom edge and works up, as water does.
  for (let i = 0; i < 90; i++) {
    const x = rand() * size;
    const height = (0.1 + rand() * 0.5) * size;
    ctx.fillStyle = `rgba(${120 + rand() * 50 | 0}, ${62 + rand() * 30 | 0}, 34, ${0.05 + rand() * 0.13})`;
    ctx.fillRect(x, size - height, 1 + rand() * 3, height);
  }
  weather(ctx, size, rand, 0.1);
}

/** A window, set into whatever wall has just been drawn. */
function window_(ctx: CanvasRenderingContext2D, size: number, rand: () => number): void {
  const w = size * 0.3;
  const h = size * 0.36;
  const x = size * 0.35;
  const y = size * 0.26;

  // Reveal, then frame, then glass.
  ctx.fillStyle = "rgba(20, 18, 16, 0.55)";
  ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
  ctx.fillStyle = "#8e8a80";
  ctx.fillRect(x - 2, y - 2, w + 4, h + 4);

  // Glass reflects the sky at the top and the room's dark at the bottom, which
  // is the whole reason a window reads as glass rather than as a dark hole.
  const glass = ctx.createLinearGradient(x, y, x, y + h);
  glass.addColorStop(0, "#6d7d8c");
  glass.addColorStop(0.45, "#3c4650");
  glass.addColorStop(1, "#22282e");
  ctx.fillStyle = glass;
  ctx.fillRect(x, y, w, h);

  // Glazing bars.
  ctx.fillStyle = "#7d7970";
  ctx.fillRect(x + w / 2 - 1, y, 2, h);
  ctx.fillRect(x, y + h / 2 - 1, w, 2);

  // Sill, and the dirt that runs off it.
  ctx.fillStyle = "#9a9488";
  ctx.fillRect(x - 4, y + h + 2, w + 8, 3);
  const runoff = ctx.createLinearGradient(0, y + h + 5, 0, y + h + 5 + size * 0.1);
  runoff.addColorStop(0, `rgba(60, 54, 48, ${0.14 + rand() * 0.08})`);
  runoff.addColorStop(1, "rgba(60, 54, 48, 0)");
  ctx.fillStyle = runoff;
  ctx.fillRect(x - 2, y + h + 5, w + 4, size * 0.1);
}

/** Streaks and blotches. Nothing outdoors is evenly coloured. */
function weather(
  ctx: CanvasRenderingContext2D,
  size: number,
  rand: () => number,
  strength: number,
): void {
  for (let i = 0; i < 40; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const radius = size * (0.04 + rand() * 0.16);
    const stain = ctx.createRadialGradient(x, y, 0, x, y, radius);
    const dark = rand() < 0.6;
    stain.addColorStop(0, `rgba(${dark ? "26, 24, 20" : "220, 216, 202"}, ${strength})`);
    stain.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = stain;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
}

// ---------------------------------------------------------------------------
// Height passes
//
// Greyscale: white stands proud, black is recessed. Converted to a normal map
// below. Deliberately the *same shapes* as the colour pass and nothing else —
// stains and paint have no depth, and embossing them is what makes a generated
// surface look like crumpled foil.
// ---------------------------------------------------------------------------

function heightBrick(ctx: CanvasRenderingContext2D, size: number, rand: () => number): void {
  const courses = COURSES_PER_TILE;
  const courseH = size / courses;
  const brickW = courseH * BRICK_ASPECT;
  ctx.fillStyle = "#303030"; // mortar sits back
  ctx.fillRect(0, 0, size, size);
  for (let row = 0; row < courses; row++) {
    const offset = row % 2 === 0 ? 0 : brickW / 2;
    for (let x = -brickW; x < size + brickW; x += brickW) {
      const face = 200 + rand() * 55;
      ctx.fillStyle = `rgb(${face | 0}, ${face | 0}, ${face | 0})`;
      ctx.fillRect(x + offset + 1, row * courseH + 1, brickW - 2, courseH - 2);
    }
  }
  heightWindow(ctx, size);
}

function heightRoof(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, size, size);
  const ribs = 18;
  for (let i = 0; i < ribs; i++) {
    // A smooth ridge per bay, which is what corrugation is.
    const x = (i / ribs) * size;
    const ridge = ctx.createLinearGradient(x, 0, x + size / ribs, 0);
    ridge.addColorStop(0, "#3a3a3a");
    ridge.addColorStop(0.5, "#f0f0f0");
    ridge.addColorStop(1, "#3a3a3a");
    ctx.fillStyle = ridge;
    ctx.fillRect(x, 0, size / ribs, size);
  }
  ctx.fillStyle = "#202020";
  for (let y = 0; y < size; y += size / 3) ctx.fillRect(0, y, size, 2);
}

function heightBlockwork(ctx: CanvasRenderingContext2D, size: number, rand: () => number): void {
  const courses = 8;
  const courseH = size / courses;
  const blockW = courseH * 2;
  ctx.fillStyle = "#2a2a2a";
  ctx.fillRect(0, 0, size, size);
  for (let row = 0; row < courses; row++) {
    const offset = row % 2 === 0 ? 0 : blockW / 2;
    for (let x = -blockW; x < size + blockW; x += blockW) {
      const face = 190 + rand() * 40;
      ctx.fillStyle = `rgb(${face | 0}, ${face | 0}, ${face | 0})`;
      ctx.fillRect(x + offset + 1.5, row * courseH + 1.5, blockW - 3, courseH - 3);
    }
  }
}

function heightContainer(ctx: CanvasRenderingContext2D, size: number): void {
  const ribs = CONTAINER_RIBS;
  const ribW = size / ribs;
  for (let i = 0; i < ribs; i++) {
    const x = i * ribW;
    const profile = ctx.createLinearGradient(x, 0, x + ribW, 0);
    profile.addColorStop(0, "#f4f4f4");
    profile.addColorStop(0.3, "#f4f4f4");
    profile.addColorStop(0.62, "#303030");
    profile.addColorStop(1, "#303030");
    ctx.fillStyle = profile;
    ctx.fillRect(x, 0, ribW, size);
  }
}

function heightWindow(ctx: CanvasRenderingContext2D, size: number): void {
  const w = size * 0.3;
  const h = size * 0.36;
  const x = size * 0.35;
  const y = size * 0.26;
  ctx.fillStyle = "#101010"; // the reveal is a hole in the wall
  ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
  ctx.fillStyle = "#c8c8c8"; // frame stands forward of the glass
  ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
  ctx.fillStyle = "#4a4a4a";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#e8e8e8"; // the sill is the most prominent thing on the wall
  ctx.fillRect(x - 4, y + h + 2, w + 8, 3);
}

// ---------------------------------------------------------------------------
// Height to normal
// ---------------------------------------------------------------------------

/**
 * Convert a greyscale relief image into a tangent-space normal map.
 *
 * Central differences, wrapped at the edges: the textures tile, so sampling off
 * one side has to come back on the other or every tile boundary grows a seam
 * that lights differently from the wall around it.
 *
 * Exported and taking plain bytes so it can be tested without a canvas.
 */
export function heightToNormals(
  height: Uint8ClampedArray,
  width: number,
  rows: number,
  strength: number = NORMAL_STRENGTH,
): Uint8ClampedArray<ArrayBuffer> {
  // Explicitly buffer-backed: `ImageData` will not take a view that might be
  // over shared memory, and the plain constructor's type allows one.
  const out = new Uint8ClampedArray(new ArrayBuffer(width * rows * 4));
  const at = (x: number, y: number): number => {
    const wrappedX = ((x % width) + width) % width;
    const wrappedY = ((y % rows) + rows) % rows;
    return height[(wrappedY * width + wrappedX) * 4]! / 255;
  };

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // Normal of the surface z = h(x, y): (-dh/dx, -dh/dy, 1), normalised.
      const length = Math.sqrt(dx * dx + dy * dy + 1);
      const o = (y * width + x) * 4;
      out[o] = ((-dx / length) * 0.5 + 0.5) * 255;
      out[o + 1] = ((-dy / length) * 0.5 + 0.5) * 255;
      out[o + 2] = (1 / length) * 0.5 * 255 + 127.5;
      out[o + 3] = 255;
    }
  }
  return out;
}

function normalFrom(heightCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = heightCanvas.width;
  canvas.height = heightCanvas.height;
  const source = heightCanvas.getContext("2d");
  const target = canvas.getContext("2d");
  if (source === null || target === null) return canvas;

  const height = source.getImageData(0, 0, heightCanvas.width, heightCanvas.height);
  const normals = heightToNormals(height.data, heightCanvas.width, heightCanvas.height);
  target.putImageData(new ImageData(normals, canvas.width, canvas.height), 0, 0);
  return canvas;
}

// ---------------------------------------------------------------------------
// Fitting a texture to a volume
// ---------------------------------------------------------------------------

/**
 * How many tiles each face of a box needs, in `BoxGeometry`'s face order:
 * +x, -x, +y, -y, +z, -z.
 *
 * The point of the exercise: a face's UVs have to span its own real extent, not
 * the unit square, or the texture stretches to whatever shape the volume is. A
 * garden wall and a barn are both cover and they are not remotely the same size.
 *
 * Exported and pure because it is the part that is easy to get subtly wrong —
 * swap two axes here and only some faces look wrong, on only some buildings.
 */
export function faceTileCounts(
  width: number,
  height: number,
  depth: number,
  tileM: number,
): Array<{ u: number; v: number }> {
  const w = width / tileM;
  const h = height / tileM;
  const d = depth / tileM;
  return [
    { u: d, v: h }, // +x: looking at it, you see depth across and height up
    { u: d, v: h }, // -x
    { u: w, v: d }, // +y: the roof, seen from above
    { u: w, v: d }, // -y
    { u: w, v: h }, // +z
    { u: w, v: h }, // -z
  ];
}

/**
 * Rescale a box's UVs so one texture tile covers `tileM` metres on every face.
 *
 * Mutates the geometry in place, which is safe because every volume gets its own
 * — they are all different sizes, so there is nothing to share.
 */
export function fitBoxUvs(
  geometry: THREE.BufferGeometry,
  width: number,
  height: number,
  depth: number,
  tileM: number,
): void {
  const uv = geometry.attributes.uv as THREE.BufferAttribute | undefined;
  if (uv === undefined) return;
  const counts = faceTileCounts(width, height, depth, tileM);

  // BoxGeometry lays out four vertices per face, faces in the order above.
  for (let face = 0; face < counts.length; face++) {
    const { u, v } = counts[face]!;
    for (let corner = 0; corner < 4; corner++) {
      const i = face * 4 + corner;
      if (i >= uv.count) return;
      uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
    }
  }
  uv.needsUpdate = true;
}

// ---------------------------------------------------------------------------

/**
 * A small deterministic generator, so every client draws the same wall.
 *
 * Exported because the ground is drawn the same way and there is no sense in
 * two generated-surface files disagreeing about what "the same seed" means.
 */
export function seededRandom(seed: number): () => number {
  let state = (seed | 0) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
