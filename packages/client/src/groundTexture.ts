/**
 * The ground you walk on.
 *
 * The terrain used to be one flat olive colour over a kilometre of hills, which
 * reads as a billiard table: with nothing on the surface, there is no scale, no
 * texture under your feet and no sense of moving. This gives it a grass mat.
 *
 * Three things together make ground look like ground, and any one of them alone
 * does not:
 *
 *  - a **tile** of individual blades, drawn as thousands of short strokes over
 *    soil, with a matching normal map so the mat catches the low sun;
 *  - a **second sample of that same tile at a much larger scale**, multiplied
 *    over the first. Ground repeats every 3 m otherwise, and a 3 m checkerboard
 *    stretching to the horizon is more obviously artificial than flat colour
 *    was. Two coprime scales beat that at the cost of one extra texture fetch;
 *  - **patch tint** varying over tens of metres, baked into the terrain mesh's
 *    vertex colours, so one field is drier than the next and steep faces show
 *    bare earth where grass would not hold.
 *
 * Generated, not imported, for the reason `buildingTextures.ts` gives: CLAUDE.md
 * forbids art taken from other games, and a generated tile can be sized in
 * metres so a blade of grass is the same size on every hill.
 */

import * as THREE from "three";
import { heightToNormals, seededRandom } from "./buildingTextures.js";

/** Texture resolution per tile. Finer than the walls: blades are small. */
const TEXTURE_PX = 512;

/**
 * Metres of ground covered by one tile.
 *
 * Three metres puts a blade at about a centimetre of texel, which is as fine as
 * is worth drawing, and keeps the repeat period long enough that the macro
 * sample below has something to hide.
 */
export const GROUND_TILE_M = 3;

/** How many times larger the second, repetition-breaking sample is. */
const MACRO_SCALE = 1 / 11;

/** How strongly that macro sample modulates the first. */
const MACRO_STRENGTH = 0.55;

/** Blades per tile. Nine square metres of grass is a lot of blades. */
const BLADE_COUNT = 13000;

/** Blade length, in metres. Ankle-height pasture, cropped by weather. */
const BLADE_MIN_M = 0.05;
const BLADE_MAX_M = 0.14;

/** Grass is not one colour: a fifth of it is dead or dying at any time. */
const DRY_FRACTION = 0.22;

/** Bare patches per tile, where the soil shows through. */
const SCRAPE_COUNT = 14;

/** Relief on the mat. Grass is shallow — this only has to catch a shadow. */
const GROUND_NORMAL_STRENGTH = 1.4;

export interface GroundSurface {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  /** Metres of ground covered by one tile of the texture. */
  tileM: number;
  /**
   * Mean luminance of the colour pass, in [0, 1].
   *
   * The macro sample multiplies the base one, and multiplying by an image whose
   * average is 0.3 would drop the whole field to a third of its brightness. The
   * shader divides by this, so the modulation averages out to unity and only
   * the *variation* survives.
   */
  meanLuma: number;
}

/**
 * The grass mat: colour, relief, and the average brightness of the colour.
 *
 * Built once. Everything on the map that is ground shares it.
 */
export function buildGroundSurface(): GroundSurface {
  const colour = paint(drawGrass);
  const map = new THREE.CanvasTexture(colour);
  const normalMap = new THREE.CanvasTexture(
    heightToNormals2d(paint(heightGrass), GROUND_NORMAL_STRENGTH),
  );

  for (const texture of [map, normalMap]) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  map.colorSpace = THREE.SRGBColorSpace;
  normalMap.colorSpace = THREE.NoColorSpace;

  return { map, normalMap, tileM: GROUND_TILE_M, meanLuma: meanLuminance(colour) };
}

/**
 * Patch the terrain's material so it samples the grass tile twice — once at
 * blade scale, once eleven times larger — and multiplies the two.
 *
 * The second sample carries no detail at that size; what it carries is the
 * tile's own blotchiness, stretched over 33 m. That is enough to stop the eye
 * finding the 3 m grid, which it otherwise does immediately on open ground.
 */
export function applyMacroVariation(material: THREE.Material, surface: GroundSurface): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMacroScale = { value: MACRO_SCALE };
    shader.uniforms.uMacroMean = { value: Math.max(0.02, surface.meanLuma) };
    shader.uniforms.uMacroStrength = { value: MACRO_STRENGTH };

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        `uniform float uMacroScale;
         uniform float uMacroMean;
         uniform float uMacroStrength;
         void main() {`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
         {
           vec3 macro = texture2D( map, vMapUv * uMacroScale ).rgb;
           float luma = dot( macro, vec3( 0.2126, 0.7152, 0.0722 ) );
           diffuseColor.rgb *= mix( 1.0, luma / uMacroMean, uMacroStrength );
         }`,
      );
  };
  // Materials are cached by program key; without this, the terrain would share
  // a compiled program with any other standard material and lose the patch.
  material.customProgramCacheKey = () => "ground-macro";
}

// ---------------------------------------------------------------------------
// Patch tint
// ---------------------------------------------------------------------------

/** Metres across one patch of drier or greener ground. */
const PATCH_SIZE_M = 45;

/** How far the tint moves from neutral, at its strongest. */
const PATCH_STRENGTH = 0.32;

/**
 * Slope past which grass gives way to bare earth.
 *
 * Expressed as the upward component of the surface normal: 1 is flat, and 0.9
 * is about a 25° face. Steep ground washes and grass does not hold on it, which
 * is also why a bare face reads as steep at a glance.
 */
const BARE_SLOPE_Z = 0.93;
const BARE_SLOPE_FULL_Z = 0.78;

/** What bare ground is, as a multiplier on the grass colour. */
const EARTH_TINT = { r: 1.22, g: 1.0, b: 0.72 };

/**
 * The colour multiplier for one point of ground.
 *
 * Two effects: a slow noise that makes some fields greener and some drier, and
 * slope, which strips grass off anything steep. Pure and exported so both the
 * terrain mesh and the grass clumps standing on it can agree — clumps tinted
 * independently of the ground under them float visibly.
 */
export function groundTint(
  x: number,
  y: number,
  normalZ: number,
  seed: number,
): { r: number; g: number; b: number } {
  const patch = patchNoise(x / PATCH_SIZE_M, y / PATCH_SIZE_M, seed) * 2 - 1;
  // Drier ground is yellower and lighter; lusher ground is darker and greener.
  const dry = Math.max(0, patch) * PATCH_STRENGTH;
  const lush = Math.max(0, -patch) * PATCH_STRENGTH;
  let r = 1 + dry * 0.9 - lush * 0.55;
  let g = 1 + dry * 0.55 - lush * 0.2;
  let b = 1 - dry * 0.5 - lush * 0.3;

  const bare = clamp01((BARE_SLOPE_Z - normalZ) / (BARE_SLOPE_Z - BARE_SLOPE_FULL_Z));
  r += (EARTH_TINT.r - 1) * bare;
  g += (EARTH_TINT.g - 1) * bare;
  b += (EARTH_TINT.b - 1) * bare;

  return { r, g, b };
}

/** Two octaves of value noise on a lattice. Deterministic, like everything. */
export function patchNoise(x: number, y: number, seed: number): number {
  return lattice(x, y, seed) * 0.7 + lattice(x * 2.7, y * 2.7, seed ^ 0x5bf03635) * 0.3;
}

function lattice(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Integer mixing, of the same family the terrain and the RNG use. */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 0x27d4eb2d) + Math.imul(iy, 0x165667b1) + seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 1 | h);
  h = (h ^ (h + Math.imul(h ^ (h >>> 7), 61 | h))) >>> 0;
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// The tile itself
// ---------------------------------------------------------------------------

type Painter = (ctx: CanvasRenderingContext2D, size: number) => void;

function paint(painter: Painter): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_PX;
  canvas.height = TEXTURE_PX;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) painter(ctx, TEXTURE_PX);
  return canvas;
}

/**
 * One blade of grass, as the tile sees it: a short stroke from above.
 *
 * Colour and relief have to place blades identically or the mat lights like a
 * stain rather than like grass, so both passes walk this same generator with
 * the same seed rather than each rolling their own.
 */
interface Blade {
  x: number;
  y: number;
  angle: number;
  length: number;
  width: number;
  /** Dead or dying, and therefore straw rather than green. */
  dry: boolean;
  /** 0 flat on the soil, 1 standing up. Drives shade and relief together. */
  stand: number;
}

function eachBlade(size: number, visit: (blade: Blade) => void): void {
  const rand = seededRandom(0x6a55);
  const perM = size / GROUND_TILE_M;
  for (let i = 0; i < BLADE_COUNT; i++) {
    visit({
      x: rand() * size,
      y: rand() * size,
      angle: rand() * Math.PI * 2,
      length: (BLADE_MIN_M + rand() * (BLADE_MAX_M - BLADE_MIN_M)) * perM,
      width: (0.6 + rand() * 0.9) * (perM / 100),
      dry: rand() < DRY_FRACTION,
      stand: rand(),
    });
  }
}

/** Grass over soil, seen from above. */
function drawGrass(ctx: CanvasRenderingContext2D, size: number): void {
  const rand = seededRandom(0x1d0e);

  // Soil first, because the gaps between blades are what you see of it.
  ctx.fillStyle = "#4a4230";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const shade = 0.75 + rand() * 0.5;
    ctx.fillStyle = `rgba(${(74 * shade) | 0}, ${(66 * shade) | 0}, ${(48 * shade) | 0}, 0.8)`;
    const r = size * (0.01 + rand() * 0.05);
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.lineCap = "round";
  eachBlade(size, (blade) => {
    // A blade standing up catches the light; one lying flat is in the mat's own
    // shade. That single variable is most of what stops this looking like felt.
    const lit = 0.72 + blade.stand * 0.6;
    const [r, g, b] = blade.dry
      ? [150 * lit, 132 * lit, 74 * lit]
      : [86 * lit, 116 * lit, 54 * lit];
    ctx.strokeStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
    ctx.lineWidth = blade.width;
    strokeWrapped(ctx, blade, size);
  });

  scrapes(ctx, size, rand);
}

/**
 * The same blades in greyscale, for the normal map.
 *
 * White stands proud. Only the blades are embossed: the soil's mottling and the
 * dry/green split are colour, not depth, and embossing colour is what makes a
 * generated surface look like crumpled foil.
 */
function heightGrass(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = "#404040";
  ctx.fillRect(0, 0, size, size);
  ctx.lineCap = "round";
  eachBlade(size, (blade) => {
    const value = (110 + blade.stand * 145) | 0;
    ctx.strokeStyle = `rgb(${value}, ${value}, ${value})`;
    ctx.lineWidth = blade.width;
    strokeWrapped(ctx, blade, size);
  });
}

/**
 * Draw a blade, and again on the far side whenever it crosses an edge.
 *
 * The tile repeats every 3 m across a kilometre of ground. A blade clipped at
 * the edge leaves a bald seam, and 300 of those in a row is a visible grid.
 */
function strokeWrapped(ctx: CanvasRenderingContext2D, blade: Blade, size: number): void {
  const dx = Math.cos(blade.angle) * blade.length;
  const dy = Math.sin(blade.angle) * blade.length;
  const reach = blade.length + blade.width;

  const line = (x: number, y: number): void => {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx, y + dy);
    ctx.stroke();
  };

  line(blade.x, blade.y);
  const shiftX = blade.x < reach ? size : blade.x > size - reach ? -size : 0;
  const shiftY = blade.y < reach ? size : blade.y > size - reach ? -size : 0;
  if (shiftX !== 0) line(blade.x + shiftX, blade.y);
  if (shiftY !== 0) line(blade.x, blade.y + shiftY);
  if (shiftX !== 0 && shiftY !== 0) line(blade.x + shiftX, blade.y + shiftY);
}

/** Bare patches: worn soil, a few stones. Nothing outdoors is unbroken. */
function scrapes(ctx: CanvasRenderingContext2D, size: number, rand: () => number): void {
  for (let i = 0; i < SCRAPE_COUNT; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const radius = size * (0.02 + rand() * 0.06);
    const patch = ctx.createRadialGradient(x, y, 0, x, y, radius);
    const earth = `${(96 + rand() * 30) | 0}, ${(84 + rand() * 24) | 0}, ${(58 + rand() * 20) | 0}`;
    patch.addColorStop(0, `rgba(${earth}, 0.75)`);
    patch.addColorStop(1, `rgba(${earth}, 0)`);
    ctx.fillStyle = patch;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  for (let i = 0; i < 40; i++) {
    const grey = (110 + rand() * 60) | 0;
    ctx.fillStyle = `rgba(${grey}, ${(grey * 0.97) | 0}, ${(grey * 0.9) | 0}, 0.8)`;
    const r = size * (0.002 + rand() * 0.004);
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Blades in three dimensions
// ---------------------------------------------------------------------------

/** Resolution of the clump sprite the 3D blades are cut from. */
const CLUMP_PX = 128;

/** Blades in one clump sprite. A tuft, not a handful of leaves. */
const CLUMP_BLADES = 15;

/**
 * A clump of blades on a transparent square, for the grass standing up around
 * the player. Cut out with an alpha test rather than blended, so no sorting is
 * needed and a thousand clumps cost one draw call.
 */
export function grassClumpTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = CLUMP_PX;
  canvas.height = CLUMP_PX;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return new THREE.CanvasTexture(canvas);

  const rand = seededRandom(0x4c17);
  ctx.clearRect(0, 0, CLUMP_PX, CLUMP_PX);

  for (let i = 0; i < CLUMP_BLADES; i++) {
    // Rooted along the bottom edge, leaning out and tapering to a point — the
    // silhouette is the whole job here, since at this size nothing else reads.
    const root = (0.08 + rand() * 0.84) * CLUMP_PX;
    const height = (0.35 + rand() * 0.62) * CLUMP_PX;
    const lean = (rand() - 0.5) * CLUMP_PX * 0.5;
    const halfWidth = (0.009 + rand() * 0.013) * CLUMP_PX;
    const tip = { x: root + lean, y: CLUMP_PX - height };
    const bend = { x: root + lean * 0.25, y: CLUMP_PX - height * 0.55 };

    const dry = rand() < DRY_FRACTION;
    const shade = 0.8 + rand() * 0.45;
    // Brighter than the same blade drawn into the mat: a standing blade is lit
    // from the side by the sky as well as from above by the sun, and one cut
    // from the mat's own palette reads as a shadow standing on end.
    const [r, g, b] = dry
      ? [186 * shade, 166 * shade, 96 * shade]
      : [118 * shade, 152 * shade, 74 * shade];

    // Darker at the root, lighter at the tip: that vertical gradient is what
    // makes a flat cut-out read as a blade with depth rather than as a decal.
    const gradient = ctx.createLinearGradient(root, CLUMP_PX, tip.x, tip.y);
    gradient.addColorStop(0, `rgb(${(r * 0.72) | 0}, ${(g * 0.72) | 0}, ${(b * 0.72) | 0})`);
    gradient.addColorStop(1, `rgb(${r | 0}, ${g | 0}, ${b | 0})`);
    ctx.fillStyle = gradient;

    ctx.beginPath();
    ctx.moveTo(root - halfWidth, CLUMP_PX);
    ctx.quadraticCurveTo(bend.x - halfWidth * 0.6, bend.y, tip.x, tip.y);
    ctx.quadraticCurveTo(bend.x + halfWidth * 0.6, bend.y, root + halfWidth, CLUMP_PX);
    ctx.closePath();
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ---------------------------------------------------------------------------

/** Height image to normal map, going through a canvas at both ends. */
function heightToNormals2d(heightCanvas: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = heightCanvas.width;
  canvas.height = heightCanvas.height;
  const source = heightCanvas.getContext("2d");
  const target = canvas.getContext("2d");
  if (source === null || target === null) return canvas;

  const height = source.getImageData(0, 0, heightCanvas.width, heightCanvas.height);
  const normals = heightToNormals(height.data, canvas.width, canvas.height, strength);
  target.putImageData(new ImageData(normals, canvas.width, canvas.height), 0, 0);
  return canvas;
}

/** Average luminance of a canvas, sampled on a grid. */
function meanLuminance(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return 1;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let total = 0;
  const pixels = canvas.width * canvas.height;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    total += 0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!;
  }
  return total / pixels / 255;
}
