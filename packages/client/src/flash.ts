/**
 * The muzzle flash texture, drawn at runtime.
 *
 * A flash needs a falloff. Drawn as a plain quad it is a hard-edged card that
 * reads as a sheet of paper stuck to the barrel — which is exactly what the
 * first attempt looked like: a white square hanging off the muzzle. What sells
 * it is the gradient, bright core to nothing at the rim, plus a few spikes so
 * the shape is not a perfect disc.
 *
 * Generated into a canvas rather than loaded, for the same reason everything
 * else here is generated: no asset, no download, no licence to carry. It costs
 * one 64×64 canvas once per session, and both the weapon in your hands and the
 * flashes out in the world share it.
 */

import * as THREE from "three";

const SIZE = 64;
const SPIKES = 4;
const SPIKE_LENGTH = 0.48;
const SPIKE_WIDTH = 0.055;

let cached: THREE.Texture | null = null;

/** The shared flash texture. Built on first use; reused forever after. */
export function flashTexture(): THREE.Texture {
  if (cached !== null) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    // No 2D context is not a reason to lose the flash entirely — an untextured
    // sprite is a worse flash, not a missing one.
    cached = new THREE.Texture();
    return cached;
  }

  const centre = SIZE / 2;

  // Spikes first, so the core glow is drawn over their roots and they appear to
  // come out of the light rather than being stuck onto it.
  ctx.fillStyle = "rgba(255, 214, 140, 0.55)";
  for (let i = 0; i < SPIKES; i++) {
    const angle = (i / SPIKES) * Math.PI * 2 + Math.PI / SPIKES;
    ctx.save();
    ctx.translate(centre, centre);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -SIZE * SPIKE_WIDTH);
    ctx.lineTo(SIZE * SPIKE_LENGTH, 0);
    ctx.lineTo(0, SIZE * SPIKE_WIDTH);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  const glow = ctx.createRadialGradient(centre, centre, 0, centre, centre, centre);
  glow.addColorStop(0, "rgba(255, 255, 245, 1)");
  glow.addColorStop(0.18, "rgba(255, 233, 175, 0.95)");
  glow.addColorStop(0.45, "rgba(255, 170, 70, 0.4)");
  glow.addColorStop(1, "rgba(255, 140, 40, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SIZE, SIZE);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  cached = texture;
  return texture;
}
