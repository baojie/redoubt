#!/usr/bin/env node
/**
 * Photograph your own hands.
 *
 * The viewmodel is the one surface a player looks at for the whole match, and
 * it is also the one the ordinary screenshot scripts frame badly — `shoot.mjs`
 * points the camera at a building and the hands end up as two small shapes in
 * the corner, which is exactly the size at which "that isn't a hand" is hard to
 * see and impossible to diagnose.
 *
 * So this one photographs nothing else: the corner the weapon lives in, blown
 * up to fill the frame, in the four states the hands are ever seen in —
 * carried, aimed, mid-reload, and close enough to count the fingers.
 *
 *   node packages/client/test/hands.mjs [--out DIR] [--client URL] [--server WS]
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
/** Only needed when the game server is not on the client host's :8787. */
const SERVER = flag("server", "");

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
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on("pageerror", (error) => console.log("[pageerror]", error.message));

const url = new URL(CLIENT);
url.searchParams.set("join", "hands");
if (SERVER !== "") url.searchParams.set("server", SERVER);
await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
// Alive, not merely connected: the viewmodel is hidden while deploying, and a
// hidden viewmodel photographs as an empty field with no hint of why.
await page
  .waitForFunction(
    () => globalThis.window.redoubt?.report?.()?.selfStatus === "alive",
    { timeout: 60_000 },
  )
  .catch(() => console.log("[warn] never reached alive; the weapon may not be drawn"));
await page.waitForTimeout(2000);

/**
 * Drive the viewmodel to a given state and photograph it close up.
 *
 * Framing this is not obvious. The viewmodel is a child of the camera, so
 * moving or turning the camera brings the weapon along and changes nothing;
 * and narrowing the field of view — the first thing I tried — magnifies about
 * the *centre*, which is precisely where a hip-carried weapon is not. Two
 * shots came back as photographs of an empty field.
 *
 * `setViewOffset` is the one that works: it renders a sub-rectangle of the
 * normal frame blown up to the full viewport. The weapon is drawn exactly where
 * it really sits, in the pose it really has — the picture is just a crop of the
 * corner it lives in.
 */
const shot = (aiming, reload, crop) =>
  page.evaluate(
    ({ aiming, reload, crop }) => {
      const scene3d = globalThis.window.redoubt?.scene;
      if (scene3d == null) return null;
      const viewmodel = scene3d.viewmodel;

      // Force it visible. The weapon is hidden while deploying and while dead,
      // and in a live match with bots the player is regularly one or the other —
      // which photographs as an empty field with no clue as to why, and cost me
      // two rounds of "the hands have vanished" before I noticed.
      viewmodel.setVisible(true);

      // Settle the aim/reload blends: they are eased, so one frame at a new
      // state photographs the transition rather than the state.
      for (let i = 0; i < 60; i++) viewmodel.update(1 / 30, aiming, 0, reload);

      const gl0 = scene3d.renderer.getContext();
      const fullWidth = gl0.drawingBufferWidth;
      const fullHeight = gl0.drawingBufferHeight;
      scene3d.camera.setViewOffset(
        fullWidth,
        fullHeight,
        crop[0] * fullWidth,
        crop[1] * fullHeight,
        crop[2] * fullWidth,
        crop[3] * fullHeight,
      );
      scene3d.camera.updateProjectionMatrix();
      scene3d.camera.updateMatrixWorld(true);
      scene3d.renderer.render(scene3d.scene, scene3d.camera);

      const gl = scene3d.renderer.getContext();
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      scene3d.camera.clearViewOffset();
      scene3d.camera.updateProjectionMatrix();

      const flipped = new Uint8ClampedArray(width * height * 4);
      const stride = width * 4;
      for (let row = 0; row < height; row++) {
        flipped.set(
          pixels.subarray((height - 1 - row) * stride, (height - row) * stride),
          row * stride,
        );
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").putImageData(new ImageData(flipped, width, height), 0, 0);
      return { url: canvas.toDataURL("image/png") };
    },
    { aiming, reload, crop },
  );

// Crops are fractions of the frame: [x, y, width, height]. Carried, the weapon
// lives in the bottom-right corner; aimed, it comes to the centre; mid-reload
// it drops, so the crop follows it down.
for (const [name, aiming, reload, crop] of [
  ["hands-frame", false, 0, [0, 0, 1, 1]],
  ["hands-carry", false, 0, [0.42, 0.42, 0.58, 0.58]],
  ["hands-close", false, 0, [0.52, 0.55, 0.42, 0.42]],
  ["hands-fist", false, 0, [0.6, 0.6, 0.2, 0.2]],
  ["hands-aim", true, 0, [0.28, 0.42, 0.44, 0.44]],
  ["hands-reload", false, 1, [0.42, 0.5, 0.55, 0.5]],
]) {
  const result = await shot(aiming, reload, crop);
  if (result === null) {
    console.log(`${name}: no scene`);
    continue;
  }
  const png = Buffer.from(result.url.split(",")[1], "base64");
  writeFileSync(`${OUT}/${name}.png`, png);
  console.log(`${name}: → ${OUT}/${name}.png (${png.length} bytes)`);
}

await browser.close();
