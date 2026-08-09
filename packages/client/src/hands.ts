/**
 * A hand, closed around something.
 *
 * The first-person hands were a palm box with four small blocks on the back of
 * it. That is a description of a hand rather than a picture of one, and at
 * viewmodel distance it read as a pipe end capped with a lump — because the
 * thing that makes a hand recognisable is not the palm, which is mostly hidden,
 * but the **fingers wrapped around the object**. A closed grip has four fingers
 * arcing over the far side of whatever is held, and that arc is visible in
 * silhouette against the world even when everything else is in shadow.
 *
 * So the fingers here genuinely wrap: each is a chain of segments walked around
 * the circumference of the gripped bar, joint by joint, with the radius drawing
 * in slightly as it curls. Nothing is placed by eye — give it the radius of the
 * thing being held and the grip closes on it, which is also why the same
 * function can grip a handguard and a pistol grip without either being tuned.
 *
 * Built in a canonical frame and rotated by the caller:
 *
 *   - the gripped bar runs along **+z**, centred on the origin
 *   - the palm is on the **+x** side
 *   - the fingers wrap **+x → +y → -x**, i.e. over the top and down the far side
 *   - the thumb wraps the other way, under the bar
 *
 * Everything is merged into one geometry per hand. Nothing about a hand moves
 * independently — the whole thing rides the weapon — so thirty little meshes
 * would be thirty draw calls for a shape that never changes.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Fingers per hand, not counting the thumb. */
const FINGERS = 4;

/** Segments per finger. Three is what it takes to read as knuckle-knuckle-tip. */
const FINGER_SEGMENTS = 3;

/**
 * How far around the bar each finger segment carries.
 *
 * Three segments at 52° is 156° of wrap, which — starting just above the palm —
 * brings the fingertips to the underside of the bar. Less than that and the
 * hand is resting on the weapon rather than holding it, which reads as a hand
 * that has let go.
 */
const WRAP_PER_SEGMENT_RAD = 0.91;

/** Where the index knuckle sits, measured up from the palm side of the bar. */
const FINGER_START_RAD = 0.3;

/** The curl draws in as it closes: fingertips sit tighter than knuckles. */
const CURL_TIGHTEN = 0.055;

/** Thumb: fewer segments, wrapping the other way, and thicker. */
const THUMB_SEGMENTS = 2;
const THUMB_START_RAD = -0.35;
const THUMB_WRAP_RAD = -0.85;
const THUMB_THICKNESS = 1.3;

/**
 * A trigger finger is not curled — it is reaching.
 *
 * Only the firing hand has one, and it is the single detail that says the hand
 * is *on a weapon* rather than holding a rail. Expressed as a fraction of the
 * normal wrap so it stays consistent if the grip is retuned.
 */
const TRIGGER_WRAP_FRACTION = 0.3;

/**
 * How far the wrist sits from the axis of the gripped bar.
 *
 * The caller needs this to start the forearm at the wrist rather than at the
 * middle of the weapon — and needs it to come from here, because it is the sum
 * of the palm's own dimensions. Measured by eye at the call site, it drifts the
 * moment the palm is retuned and the sleeve ends up growing out of the hand.
 */
export function wristOffset(gripRadius: number): number {
  return gripRadius * 2.25;
}

export interface HandOptions {
  /** Radius of the thing being gripped, in metres. */
  gripRadius: number;
  /** Across the hand, along the gripped bar. */
  width: number;
  material: THREE.Material;
  /** Extend the index finger onto a trigger instead of curling it. */
  trigger?: boolean;
  /**
   * Lay the thumb forward along the bar instead of wrapping it round.
   *
   * The support hand's thumb-forward grip, and the reason it is worth having as
   * an option: from the player's own eye the fingers of that hand are behind
   * the handguard and genuinely cannot be seen — that is true of real hands too.
   * What is visible is the back of the hand, and a thumb lying along the weapon
   * pointing where the weapon points is the one part of it that says "hand" from
   * this angle rather than "lump".
   */
  thumbForward?: boolean;
}

/**
 * One joint of a finger, in the plane across the gripped bar.
 *
 * Exported with the walk that produces it because this is the part that is easy
 * to get quietly wrong: a chain whose segments do not start where the previous
 * one ended is four floating sausages, and it looks fine in a still from the
 * one angle you happened to check.
 */
export interface Joint {
  x: number;
  y: number;
}

/**
 * Walk a finger around the bar, returning its joints from knuckle to tip.
 *
 * Each step turns by a fixed angle and pulls in slightly, so the segment
 * lengths are chords of the circle rather than numbers anyone chose. That is
 * the whole point: the grip closes on whatever radius it is given.
 */
export function fingerChain(
  gripRadius: number,
  startAngle: number,
  segments: number,
  wrapPerSegment: number,
): Joint[] {
  const joints: Joint[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = startAngle + wrapPerSegment * i;
    const radius = gripRadius * (1 - CURL_TIGHTEN * i);
    joints.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return joints;
}

/**
 * A closed hand, as a single merged geometry.
 *
 * `width` is the span across the knuckles; everything else — finger thickness,
 * palm size, how far the fingers reach — comes off that and off the radius of
 * what is being held, so a hand on a barrel and a hand on a grip are the same
 * hand at the same scale.
 */
export function buildHand(options: HandOptions): THREE.Mesh {
  const { gripRadius, width, material } = options;
  const fingerRadius = width / 8;
  const parts: THREE.BufferGeometry[] = [];

  /** A capsule between two points in the plane at depth `z`. */
  const bone = (from: Joint, to: Joint, z: number, radius: number): void => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    // Capsules are built standing on +y; turn it onto the chord.
    const geometry = new THREE.CapsuleGeometry(radius, length, 3, 8);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(dx / length, dy / length, 0),
    );
    geometry.applyQuaternion(quaternion);
    geometry.translate((from.x + to.x) / 2, (from.y + to.y) / 2, z);
    parts.push(geometry);
  };

  // The palm, hugging the bar. Flattened rather than cubic: a hand closed round
  // a grip is deeper across the knuckles than it is thick through the palm.
  const palmThickness = gripRadius * 0.8;
  const palm = new THREE.BoxGeometry(palmThickness, gripRadius * 2.1, width * 1.02);
  palm.translate(gripRadius + palmThickness / 2 - gripRadius * 0.15, gripRadius * 0.1, 0);
  parts.push(palm);

  // Fingers, spread along the bar. Index nearest +z, little finger at -z, which
  // is what puts the trigger finger at the front of the grip once the caller
  // has turned the hand onto the weapon.
  for (let finger = 0; finger < FINGERS; finger++) {
    const t = finger / (FINGERS - 1);
    const z = (0.5 - t) * (width - fingerRadius * 2);
    // Fingers shorten and thin towards the little finger, which is most of what
    // stops four identical rods reading as a comb.
    const taper = 1 - t * 0.16;
    const isTrigger = options.trigger === true && finger === 0;
    const wrap = isTrigger
      ? WRAP_PER_SEGMENT_RAD * TRIGGER_WRAP_FRACTION
      : WRAP_PER_SEGMENT_RAD * taper;
    const joints = fingerChain(
      gripRadius + fingerRadius * 0.9,
      FINGER_START_RAD,
      FINGER_SEGMENTS,
      wrap,
    );
    for (let segment = 0; segment < FINGER_SEGMENTS; segment++) {
      // Segments thin towards the tip. A finger of constant thickness is a rod.
      const thickness = fingerRadius * taper * (1 - segment * 0.12);
      bone(joints[segment]!, joints[segment + 1]!, z, thickness);
    }
  }

  // Knuckles, stood proud of the back of the hand.
  //
  // The one feature that reads at viewmodel distance from *outside* the grip.
  // Everything else about a closed hand — the fingers, the thumb — is on the far
  // side of whatever is held, so from the eye's own position a hand without
  // knuckles is a smooth brown lump with a sleeve attached, which is precisely
  // what the previous version photographed as.
  for (let finger = 0; finger < FINGERS; finger++) {
    const t = finger / (FINGERS - 1);
    const z = (0.5 - t) * (width - fingerRadius * 2);
    const knuckle = new THREE.SphereGeometry(fingerRadius * (1.08 - t * 0.14), 8, 6);
    knuckle.translate(
      gripRadius + palmThickness * 0.78,
      gripRadius * (0.62 - t * 0.06),
      z,
    );
    parts.push(knuckle);
  }

  // The thumb. Without it the hand is a paw, and the thumb is also the only
  // part of a gloved hand whose position tells you which way round the hand is.
  if (options.thumbForward === true) {
    // Laid along the bar, angled slightly across it, on the palm side where the
    // eye can see it.
    const along = new THREE.CapsuleGeometry(
      fingerRadius * THUMB_THICKNESS,
      width * 1.15,
      3,
      8,
    );
    along.rotateX(Math.PI / 2);
    along.rotateY(-0.22);
    along.translate(gripRadius * 0.72, gripRadius * 0.72, width * 0.42);
    parts.push(along);
  } else {
    const thumbJoints = fingerChain(
      gripRadius + fingerRadius,
      THUMB_START_RAD,
      THUMB_SEGMENTS,
      THUMB_WRAP_RAD,
    );
    for (let segment = 0; segment < THUMB_SEGMENTS; segment++) {
      bone(
        thumbJoints[segment]!,
        thumbJoints[segment + 1]!,
        width * 0.34,
        fingerRadius * THUMB_THICKNESS * (1 - segment * 0.15),
      );
    }
  }

  // The wrist, running out of the palm to meet the sleeve. Tapered, because the
  // step from a round forearm to a flat hand is exactly where an arm stops
  // looking like plumbing.
  const wrist = new THREE.CylinderGeometry(
    width * 0.34,
    width * 0.42,
    gripRadius * 1.6,
    10,
  );
  wrist.rotateZ(-Math.PI / 2);
  wrist.translate(gripRadius + palmThickness + gripRadius * 0.45, gripRadius * 0.1, 0);
  parts.push(wrist);

  return new THREE.Mesh(mergeGeometries(parts), material);
}
