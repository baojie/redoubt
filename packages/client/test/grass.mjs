#!/usr/bin/env node
/**
 * Photograph the ground.
 *
 * Same trick as `look.mjs` — place the camera, render synchronously, read the
 * back buffer in the same turn — but pointed at the one thing that is under
 * every other shot and never the subject of any of them.
 *
 * Three ranges, because ground fails differently at each: boots-on, where a
 * painted mat gives itself away; mid, where the tile's repeat shows as a grid;
 * and out to the horizon, where the whole field either reads as a landscape or
 * as green paper.
 *
 *   node packages/client/test/grass.mjs [--out DIR] [--client URL]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const OUT = flag("out", "/tmp/redoubt-shots");
const CLIENT = flag("client", "http://localhost:5173");

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "chromium",
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-gpu-sandbox",
  ],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
page.on("pageerror", (error) => console.log("[pageerror]", error.message));
page.on("console", (message) => {
  if (message.type() === "error") console.log("[console]", message.text());
});

await page.goto(`${CLIENT}/?join=grass`, { waitUntil: "domcontentloaded" });
await page
  .waitForFunction(() => globalThis.window.redoubt?.scene != null, { timeout: 60_000 })
  .catch(() => console.log("[warn] no scene; the client may have fallen back to 2D"));
await page.waitForTimeout(2500);

/**
 * Stand somewhere, look at the ground `pitch` radians down, photograph it.
 *
 * `render` rather than `renderer.render`, so the grass field gets the frame it
 * needs to move itself under the camera — it follows the camera, and a camera
 * teleported across the map without a frame in between would be photographed
 * standing in the bald patch it left behind.
 */
const shot = (eyeM, pitch, yaw) =>
  page.evaluate(
    ({ eyeM, pitch, yaw }) => {
      const scene3d = globalThis.window.redoubt?.scene;
      if (scene3d == null) return null;

      const here = { x: scene3d.camera.position.x, y: -scene3d.camera.position.z };
      const ground = scene3d.terrain.heightAt(here.x, here.y);
      scene3d.camera.position.set(here.x, ground + eyeM, -here.y);
      scene3d.camera.rotation.set(0, 0, 0);
      scene3d.camera.rotateY(yaw - Math.PI / 2);
      scene3d.camera.rotateX(pitch);
      scene3d.camera.updateMatrixWorld(true);

      // Two frames: the first moves the grass, the second is the picture.
      scene3d.render(0.05);
      scene3d.render(0.05);

      const gl = scene3d.renderer.getContext();
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      // readPixels counts rows from the bottom; images count from the top.
      const flipped = new Uint8ClampedArray(width * height * 4);
      const stride = width * 4;
      for (let row = 0; row < height; row++) {
        flipped.set(
          pixels.subarray((height - 1 - row) * stride, (height - row) * stride),
          row * stride,
        );
      }

      let luma = 0;
      for (let i = 0; i < width * height; i++) {
        luma += 0.2126 * pixels[i * 4] + 0.7152 * pixels[i * 4 + 1] + 0.0722 * pixels[i * 4 + 2];
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").putImageData(new ImageData(flipped, width, height), 0, 0);
      return {
        url: canvas.toDataURL("image/png"),
        at: here,
        meanLuma: Math.round((luma / (width * height) / 255) * 1000) / 1000,
        grassClumps: scene3d.grassCount,
      };
    },
    { eyeM, pitch, yaw },
  );

for (const [name, eyeM, pitch, yaw] of [
  ["grass-boots", 1.1, -0.85, 0.6],
  ["grass-mid", 1.7, -0.28, 0.6],
  ["grass-far", 1.7, -0.05, 0.6],
  ["grass-low", 0.35, -0.12, 2.4],
]) {
  const result = await shot(eyeM, pitch, yaw);
  if (result === null) {
    console.log(`${name}: no scene`);
    continue;
  }
  const png = Buffer.from(result.url.split(",")[1], "base64");
  writeFileSync(`${OUT}/${name}.png`, png);
  console.log(
    `${name}: at ${result.at.x.toFixed(0)},${result.at.y.toFixed(0)} ` +
      `mean luma ${result.meanLuma}, ${result.grassClumps} clumps → ${OUT}/${name}.png`,
  );
}

await browser.close();
