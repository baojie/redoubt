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
 * The optic, as fractions of overall length.
 *
 * The magnification itself already existed — the wheel drives it — but there
 * was nothing on the weapon to look through, so aiming narrowed the field of
 * view with no explanation on screen. The tube is what makes the zoom legible
 * as a scope rather than as the world lurching.
 *
 * It sits above the iron sights and slightly forward, on two rings, which is
 * where a scope goes and also what keeps it clear of the ejection port side of
 * the receiver.
 */
const SCOPE_LENGTH = 0.26;
const SCOPE_RADIUS = 0.032;
const SCOPE_RISE = 0.115;
const SCOPE_FORWARD = 0.16;
const RING_RADIUS = 0.017;
const LENS_RADIUS = 0.038;

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

  addScope(rifle, lengthM, material);

  return rifle;
}

/** Where the sights sit above the receiver, so a caller can line the eye up. */
export function sightHeight(lengthM: number): number {
  return (RECEIVER_HEIGHT / 2 + SIGHT_RISE) * lengthM;
}

/**
 * The optic's axis above the receiver — where the eye actually goes.
 *
 * Aiming lowers the weapon by exactly this, so what lands on the crosshair is
 * the line through the tube. Using `sightHeight` instead puts the eye level
 * with the iron sights and the scope body then sits squarely over the target,
 * which is the one thing a scope must never do.
 */
export function opticHeight(lengthM: number): number {
  return (RECEIVER_HEIGHT / 2 + SCOPE_RISE) * lengthM;
}

/**
 * Tube, mounting rings and a glass objective.
 *
 * The tube is open-ended and the eyepiece has no lens in it, because the eye
 * sits directly behind it when aiming and anything solid there covers the
 * target. The first version capped both ends and put a tinted disc at the
 * eyepiece: it looked like a scope from outside and, the moment you aimed,
 * planted an opaque circle exactly over whatever you were shooting at.
 *
 * What is left is a ring to look through — the inside wall of the tube, drawn
 * from both sides, framing the sight picture the way a real eyepiece does.
 */
function addScope(rifle: THREE.Group, lengthM: number, body: THREE.Material): void {
  const axisY = (RECEIVER_HEIGHT / 2 + SCOPE_RISE) * lengthM;
  const centreZ = -SCOPE_FORWARD * lengthM;

  const tubeMaterial = (body as THREE.MeshStandardMaterial).clone();
  tubeMaterial.side = THREE.DoubleSide;

  const tube = new THREE.Mesh(
    new THREE.CylinderGeometry(
      SCOPE_RADIUS * lengthM,
      SCOPE_RADIUS * lengthM,
      SCOPE_LENGTH * lengthM,
      16,
      1,
      true,
    ),
    tubeMaterial,
  );
  // Cylinders stand on their own y; the scope lies along the barrel.
  tube.rotation.x = Math.PI / 2;
  tube.position.set(0, axisY, centreZ);
  rifle.add(tube);

  // The bell at the objective end, also open, so it flares without blocking.
  const bell = new THREE.Mesh(
    new THREE.CylinderGeometry(
      LENS_RADIUS * lengthM,
      SCOPE_RADIUS * lengthM,
      0.05 * lengthM,
      16,
      1,
      true,
    ),
    tubeMaterial,
  );
  bell.rotation.x = Math.PI / 2;
  bell.position.set(0, axisY, centreZ - (SCOPE_LENGTH * lengthM) / 2);
  rifle.add(bell);

  // Glass, at the far end only — far enough forward that it tints the view
  // rather than masking it, which is what glass in a scope actually does.
  const glass = new THREE.MeshStandardMaterial({
    color: 0x9fd8ea,
    roughness: 0.1,
    metalness: 0.2,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
  });
  const objective = new THREE.Mesh(
    new THREE.CircleGeometry(LENS_RADIUS * lengthM * 0.95, 16),
    glass,
  );
  objective.position.set(0, axisY, centreZ - (SCOPE_LENGTH * lengthM) / 2 - 0.025 * lengthM);
  rifle.add(objective);

  for (const offset of [-0.07, 0.07]) {
    const ring = new THREE.Mesh(
      new THREE.CylinderGeometry(
        RING_RADIUS * lengthM,
        RING_RADIUS * lengthM,
        0.02 * lengthM,
        10,
      ),
      body,
    );
    ring.position.set(0, axisY - SCOPE_RADIUS * lengthM, centreZ + offset * lengthM);
    rifle.add(ring);
  }
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
