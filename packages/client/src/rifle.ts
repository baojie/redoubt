/**
 * The rifle, in one place.
 *
 * It is drawn twice at very different distances: slung on a soldier a hundred
 * metres away, where it is a handful of pixels, and held in the player's own
 * hands at arm's length, where it fills a third of the screen. Those want
 * different amounts of detail but they had better be the same weapon — a
 * silhouette that changes shape when you pick it up is the kind of thing
 * players notice without being able to say what is wrong.
 *
 * So the proportions live here and the caller picks how much of it to build.
 * Everything is expressed as a fraction of the overall length, which means the
 * two callers can size the weapon however they need — the soldier scales it off
 * the model's shoulders — without the shape drifting apart.
 *
 * Built from primitives for the same reason the soldier's gear is: no sourced
 * asset, no licence to carry, nothing from anyone else's game.
 */

import * as THREE from "three";

/** Fractions of overall length. The receiver is the bit you hold. */
const BARREL_LENGTH = 0.46;
const BARREL_THICKNESS = 0.055;
const RECEIVER_LENGTH = 0.3;
const RECEIVER_HEIGHT = 0.13;
const RECEIVER_WIDTH = 0.075;
const STOCK_LENGTH = 0.24;
const MAGAZINE_LENGTH = 0.09;
const MAGAZINE_DROP = 0.17;
const GRIP_DROP = 0.15;
const SIGHT_RISE = 0.055;

/**
 * A rifle lying along its own -z, muzzle forward, origin at the receiver.
 *
 * The origin is the grip rather than the centre or the muzzle, because both
 * callers position it by where it is *held*: at the soldier's hand, and at the
 * player's shoulder. Measuring from a point nobody holds means every placement
 * carries a correction term.
 */
export function buildRifle(
  lengthM: number,
  material: THREE.Material,
  detailed: boolean,
): THREE.Group {
  const rifle = new THREE.Group();
  const at = (
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
  ): void => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width * lengthM, height * lengthM, depth * lengthM),
      material,
    );
    mesh.position.set(x * lengthM, y * lengthM, z * lengthM);
    rifle.add(mesh);
  };

  // Receiver and barrel: the two that make it read as a rifle at any distance.
  at(RECEIVER_WIDTH, RECEIVER_HEIGHT, RECEIVER_LENGTH, 0, 0, -RECEIVER_LENGTH / 2);
  at(
    BARREL_THICKNESS,
    BARREL_THICKNESS,
    BARREL_LENGTH,
    0,
    0.01,
    -RECEIVER_LENGTH - BARREL_LENGTH / 2,
  );

  // Magazine — the one part that is unmistakable even as a few pixels, because
  // nothing else on a human silhouette hangs down under a horizontal line.
  at(
    RECEIVER_WIDTH * 0.8,
    MAGAZINE_DROP,
    MAGAZINE_LENGTH,
    0,
    -MAGAZINE_DROP / 2 - RECEIVER_HEIGHT / 4,
    -RECEIVER_LENGTH * 0.55,
  );

  // Anything below here is only legible up close, so a slung rifle skips it and
  // stays at three boxes. There can be two dozen soldiers on screen.
  if (!detailed) return rifle;

  at(RECEIVER_WIDTH, RECEIVER_HEIGHT * 0.85, STOCK_LENGTH, 0, -0.01, STOCK_LENGTH / 2);
  at(RECEIVER_WIDTH * 0.85, GRIP_DROP, MAGAZINE_LENGTH * 0.8, 0, -GRIP_DROP / 2, 0.05);
  // Rear sight then front sight — in that order, back to front, which is also
  // the order the eye lines them up in when aiming.
  at(RECEIVER_WIDTH * 0.5, SIGHT_RISE, 0.03, 0, RECEIVER_HEIGHT / 2 + SIGHT_RISE / 2, -0.02);
  at(
    RECEIVER_WIDTH * 0.5,
    SIGHT_RISE,
    0.03,
    0,
    RECEIVER_HEIGHT / 2 + SIGHT_RISE / 2,
    -RECEIVER_LENGTH - BARREL_LENGTH * 0.8,
  );

  return rifle;
}

/** Where the sights sit above the receiver, so a caller can line the eye up. */
export function sightHeight(lengthM: number): number {
  return (RECEIVER_HEIGHT / 2 + SIGHT_RISE) * lengthM;
}

/**
 * Where the muzzle is, along the weapon's own -z.
 *
 * Exported for the same reason `sightHeight` is: the flash and the tracer both
 * have to come out of the end of the barrel, and the end of the barrel is a
 * fact about the proportions above. Anyone measuring it by eye gets a flash
 * hanging in mid-air the first time the rifle is resized.
 */
export function muzzleOffset(lengthM: number): number {
  return -(RECEIVER_LENGTH + BARREL_LENGTH) * lengthM;
}
