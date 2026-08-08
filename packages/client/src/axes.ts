/**
 * The one place the two coordinate conventions meet.
 *
 * The rules engine works in x east, y north, z up — the convention a map is
 * drawn in. Three.js is y up with -z going away from the camera. Every mesh,
 * camera and tracer in the renderer crosses that boundary, and it is crossed
 * *here*: a second, slightly different conversion somewhere else would put the
 * scenery a quarter turn away from the cover the server adjudicates against,
 * and nothing about the resulting bug would point at the axes.
 *
 * Re-exported from `scene3d.ts`, which is where these used to live.
 */

import * as THREE from "three";

/** Rules-space (x east, y north, z up) to Three.js space (y up, -z north). */
export function worldToScene(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, z, -y);
}

/**
 * Rules yaw to a Three.js rotation about the up axis.
 *
 * Rules yaw is measured from +x (east) toward +y (north). A Three.js object
 * with no rotation faces -z, which under `worldToScene` is north — that is,
 * yaw = π/2. So the scene rotation is the world yaw less a quarter turn.
 *
 * Worth deriving rather than guessing: the first version of this had the sign
 * inverted, which put the camera exactly backwards and made the whole world
 * look like it was behind you.
 */
export function sceneYaw(worldYaw: number): number {
  return worldYaw - Math.PI / 2;
}
