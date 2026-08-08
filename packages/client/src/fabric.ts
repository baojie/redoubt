/**
 * Cloth and glove textures for the hands holding the weapon.
 *
 * These are the only surfaces in the game a player looks at permanently — the
 * hands sit in the corner of every frame — and until now they were flat colour:
 * one olive cylinder per forearm and a few black boxes for each hand. Against a
 * textured soldier and a textured world they read as untextured, which draws
 * the eye exactly where it should not go.
 *
 * Generated into a canvas rather than loaded, like every other texture here
 * except the two models: no asset, no download, no licence. Two 128×128
 * canvases once per session, shared by every instance.
 *
 * Deterministic on purpose. `Math.random` would give a different weave each
 * time the page loads, which makes a screenshot impossible to compare against
 * an earlier one — and comparing screenshots is how everything visual in this
 * project has been checked.
 */

import * as THREE from "three";

const SIZE = 128;

/**
 * A cheap hash-based value noise.
 *
 * Reproducible, and good enough for cloth: what sells fabric at arm's length is
 * that no two neighbouring pixels agree, not that the noise is high quality.
 */
function noise(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695040) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function paint(draw: (ctx: CanvasRenderingContext2D) => void): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  // No 2D context is not a reason to lose the hands; an untextured glove is a
  // worse glove, not a missing one.
  if (ctx === null) return new THREE.Texture();

  draw(ctx);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

let fabric: THREE.Texture | null = null;

/**
 * Uniform sleeve: a woven olive with a mottle over it.
 *
 * Two scales of variation, because one is not enough to read as cloth — a fine
 * weave for the thread and a coarse blotch for the dye. With only the fine
 * noise it looks like film grain painted onto a tube.
 */
export function fabricTexture(): THREE.Texture {
  if (fabric !== null) return fabric;

  fabric = paint((ctx) => {
    const image = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        // Coarse: the dye blotches, sampled on a wide grid and smoothed by
        // sampling the same cell from neighbouring pixels.
        const blotch = noise(Math.floor(x / 26), Math.floor(y / 26), 11);
        // Fine: the weave. A twill runs diagonally, hence x + y.
        const weave = noise(x, y, 3) * 0.5 + (((x + y) % 3) / 3) * 0.5;

        const shade = 0.72 + blotch * 0.34 + (weave - 0.5) * 0.18;
        const index = (y * SIZE + x) * 4;
        image.data[index] = Math.min(255, 74 * shade);
        image.data[index + 1] = Math.min(255, 83 * shade);
        image.data[index + 2] = Math.min(255, 64 * shade);
        image.data[index + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  });
  return fabric;
}

let glove: THREE.Texture | null = null;

/**
 * Glove: dark leather with knuckle panels and stitching.
 *
 * The panels and seams are what make it a glove rather than a dark box. They
 * are drawn as bands rather than placed per-knuckle, because the hand is built
 * from several separate boxes that each get the whole texture — a layout tuned
 * to one of them would be wrong on the rest.
 */
export function gloveTexture(): THREE.Texture {
  if (glove !== null) return glove;

  glove = paint((ctx) => {
    const image = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const grain = noise(x, y, 7) * 0.22 + noise(Math.floor(x / 9), Math.floor(y / 9), 5) * 0.3;
        const shade = 0.62 + grain;
        const index = (y * SIZE + x) * 4;
        image.data[index] = Math.min(255, 46 * shade);
        image.data[index + 1] = Math.min(255, 45 * shade);
        image.data[index + 2] = Math.min(255, 48 * shade);
        image.data[index + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);

    // Seams: a couple of light stitch lines across the panel.
    ctx.strokeStyle = "rgba(150, 148, 140, 0.28)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    for (const y of [SIZE * 0.34, SIZE * 0.66]) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(SIZE, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // A darker reinforced patch across the palm side.
    ctx.fillStyle = "rgba(10, 10, 12, 0.35)";
    ctx.fillRect(0, SIZE * 0.7, SIZE, SIZE * 0.3);
  });
  return glove;
}
