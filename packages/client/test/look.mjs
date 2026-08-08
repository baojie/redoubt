#!/usr/bin/env node
/**
 * Photograph one cover volume of each kind, close up.
 *
 * Separate from `shoot.mjs`, which photographs whatever the player can see from
 * where they spawned. This one goes and looks at a specific thing, which is what
 * you want when the question is "does that surface look like brick".
 *
 *   node packages/client/test/look.mjs [--out DIR]
 *
 * The frame is taken with `readPixels` straight after a synchronous render,
 * rather than with a page screenshot. The client's render loop puts the camera
 * back on the player every frame, so anything that waits for the compositor
 * photographs the player's viewpoint instead of the one asked for. Reading the
 * back buffer inside the same turn as the render cannot lose that race.
 */

import { writeFileSync, mkdirSync } from "node:fs";
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
await page.goto(`${CLIENT}/?join=look`, { waitUntil: "domcontentloaded" });
await page
  .waitForFunction(() => globalThis.window.redoubt?.scene != null, { timeout: 60_000 })
  .catch(() => console.log("[warn] no scene; the client may have fallen back to 2D"));
await page.waitForTimeout(2500);

/** Frame one volume of the given kind and hand back a PNG data URL. */
const shot = (kind, metres) =>
  page.evaluate(
    ({ kind, metres }) => {
      const redoubt = globalThis.window.redoubt;
      const scene3d = redoubt?.scene;
      const welcome = redoubt?.connection?.welcome;
      if (scene3d == null || welcome == null) return null;

      const volume = welcome.map.cover.find((v) => v.kind === kind);
      if (volume === undefined) return null;

      // Find the mesh built for it: cover is the only thing with a six-slot
      // material array, and it sits at the volume's own position.
      let mesh = null;
      let nearest = Infinity;
      for (const child of scene3d.scene.children) {
        if (child.isMesh !== true || Array.isArray(child.material) !== true) continue;
        const d = Math.hypot(child.position.x - volume.x, -child.position.z - volume.y);
        if (d < nearest) {
          nearest = d;
          mesh = child;
        }
      }
      if (mesh === null) return null;

      // Stand on the lit side. The sun sits at (-0.4, 0.8, 0.45) in scene axes,
      // so the faces it reaches are -x and +z; photographing the other two gives
      // a picture of the ambient term and nothing else.
      const target = mesh.position.clone();
      scene3d.camera.position.set(
        target.x - metres * 0.55,
        target.y + Math.max(0.4, volume.height * 0.15),
        target.z + metres * 0.83,
      );
      scene3d.camera.rotation.set(0, 0, 0);
      scene3d.camera.lookAt(target);
      scene3d.camera.updateMatrixWorld(true);

      scene3d.renderer.render(scene3d.scene, scene3d.camera);

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

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").putImageData(new ImageData(flipped, width, height), 0, 0);
      return {
        url: canvas.toDataURL("image/png"),
        volume,
        cameraDistanceM: metres,
      };
    },
    { kind, metres },
  );

for (const [kind, metres] of [
  ["building", 11],
  ["wall", 6],
  ["container", 7],
]) {
  const result = await shot(kind, metres);
  if (result === null) {
    console.log(`${kind}: no volume of this kind on the map`);
    continue;
  }
  const png = Buffer.from(result.url.split(",")[1], "base64");
  writeFileSync(`${OUT}/${kind}.png`, png);
  console.log(
    `${kind}: ${JSON.stringify(result.volume)} from ${result.cameraDistanceM} m ` +
      `→ ${OUT}/${kind}.png (${png.length} bytes)`,
  );
}

await browser.close();
