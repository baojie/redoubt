#!/usr/bin/env node
/**
 * Photograph the running client.
 *
 * Not a test — a pair of eyes. The 3D view is the one part of this project that
 * cannot be judged from its output values, and "does that building look like a
 * building" is not a question a unit test answers. This drives the real client
 * against the real server in headless Chromium and saves PNGs.
 *
 *   node packages/client/test/shoot.mjs [--out DIR] [--server ws://host:port]
 *
 * Needs the dev server on :5173 and a game server on :8787 — `./run.sh play`.
 *
 * WebGL under headless Chromium runs on SwiftShader, at something like ten
 * frames a second. Anything that lives for less than about 100 ms cannot be
 * caught here at all; static scenery is fine, muzzle flashes are not.
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
const WIDTH = 1280;
const HEIGHT = 720;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  // The full Chromium build, not the headless shell. `pnpm exec playwright
  // install chromium` fetches the former and Playwright reaches for the latter
  // by default, so without this it fails on a perfectly good install. The full
  // build is also the one with working WebGL.
  channel: "chromium",
  args: [
    // SwiftShader, explicitly: without this WebGL simply fails to initialise
    // headless and the client falls back to the 2D map, which is not what we
    // came to photograph.
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-gpu-sandbox",
  ],
});

const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

const logs = [];
page.on("console", (message) => logs.push(`[${message.type()}] ${message.text()}`));
page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`));

await page.goto(`${CLIENT}/?join=camera`, { waitUntil: "domcontentloaded" });

// Wait for the client to actually be in the world, rather than for a fixed
// delay: a screenshot taken during the join is a screenshot of the join screen.
await page.waitForFunction(
  () => {
    const report = globalThis.window.redoubt?.report?.();
    return report !== undefined && report.selfStatus === "alive";
  },
  { timeout: 60_000 },
).catch(() => logs.push("[warn] never reached alive; shooting anyway"));

const report = await page.evaluate(() => globalThis.window.redoubt?.report?.() ?? null);
console.log("client report:", JSON.stringify(report, null, 2));

/**
 * Point the camera at the nearest cover volume and photograph it.
 *
 * The point of the exercise is the buildings, and where the player happens to
 * have spawned looking is not where they are.
 */
const aimed = await page.evaluate(() => {
  const redoubt = globalThis.window.redoubt;
  const welcome = redoubt?.connection?.welcome;
  const scene = redoubt?.scene;
  if (redoubt === undefined || welcome == null || scene == null) return null;

  const me = scene.camera.position;
  // Scene space is x east, y up, -z north; cover is in map metres.
  const here = { x: me.x, y: -me.z };
  let best = null;
  for (const volume of welcome.map.cover) {
    const d = Math.hypot(volume.x - here.x, volume.y - here.y);
    if (best === null || d < best.d) best = { volume, d };
  }
  if (best === null) return null;

  const yaw = Math.atan2(best.volume.y - here.y, best.volume.x - here.x);
  redoubt.aim(yaw, -0.05);
  return { kind: best.volume.kind, distance: Math.round(best.d), yaw };
});
console.log("aimed at:", JSON.stringify(aimed));

// Several frames at ten frames a second, so the camera move has landed.
await page.waitForTimeout(1500);

const shots = [
  ["cover-3d", null],
  ["map", "Tab"],
];
for (const [name, key] of shots) {
  if (key !== null) {
    await page.keyboard.press(key);
    await page.waitForTimeout(1200);
  }
  const png = await page.screenshot();
  writeFileSync(`${OUT}/${name}.png`, png);
  console.log(`wrote ${OUT}/${name}.png (${png.length} bytes)`);
}

if (logs.length > 0) console.log("page log:\n" + logs.join("\n"));
await browser.close();
