/**
 * The magnified image inside the scope.
 *
 * Narrowing the main camera's field of view is not a scope. It zooms
 * everything, including the weapon in your hands and the ground at your feet,
 * and it gives you no way to see what is beside you while you look — so it
 * reads as the world lurching closer rather than as looking through glass.
 *
 * What a scope does is show one magnified circle while the rest of your view
 * stays where it is. That needs a second render: the scene drawn again from the
 * same eye position through a much narrower lens, into a texture, which is then
 * drawn as a disc in the middle of the screen.
 *
 * The cost is one extra pass over the scene, so it only happens while the
 * player is actually looking through it.
 */

import * as THREE from "three";

/** Resolution of the scope image. Square, because the eyepiece is round. */
const TARGET_SIZE = 768;

/** How much of the screen's height the eyepiece covers. */
const EYEPIECE_RADIUS = 0.46;

/** Thickness of the black surround, as a fraction of the eyepiece radius. */
const BEZEL_FRACTION = 0.13;

/** The field of view the scope would have at 1x, before magnification. */
const SCOPE_BASE_FOV_DEG = 42;

/** Reticle proportions, in eyepiece radii. */
const RETICLE_ARM = 0.62;
const RETICLE_GAP = 0.1;
const RETICLE_THICKNESS = 0.006;

export class ScopeView {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly camera = new THREE.PerspectiveCamera(SCOPE_BASE_FOV_DEG, 1, 0.1, 3000);

  /**
   * The eyepiece is drawn in its own tiny scene with an orthographic camera, in
   * units where 1 is half the screen height. That keeps the disc perfectly
   * round whatever the window's aspect ratio is — sizing it in pixels means it
   * turns into an ellipse the moment somebody resizes.
   */
  private readonly overlay = new THREE.Scene();
  private readonly overlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
  private readonly disc: THREE.Mesh;

  constructor() {
    this.target = new THREE.WebGLRenderTarget(TARGET_SIZE, TARGET_SIZE, {
      depthBuffer: true,
    });

    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(EYEPIECE_RADIUS, 64),
      new THREE.MeshBasicMaterial({ map: this.target.texture, toneMapped: false }),
    );
    this.overlay.add(this.disc);

    // The surround. Opaque, and wide enough to cover the square texture's
    // corners — without it the disc is a circle sitting on a visible square.
    const bezel = new THREE.Mesh(
      new THREE.RingGeometry(
        EYEPIECE_RADIUS,
        EYEPIECE_RADIUS * (1 + BEZEL_FRACTION),
        64,
      ),
      new THREE.MeshBasicMaterial({ color: 0x05070a, toneMapped: false }),
    );
    bezel.position.z = 0.01;
    this.overlay.add(bezel);

    this.addReticle();
    this.overlayCamera.position.z = 5;
  }

  /**
   * A cross with a gap at the centre.
   *
   * The gap matters: a solid cross covers the one thing you are trying to look
   * at, which at four hundred metres is a target a few pixels across.
   */
  private addReticle(): void {
    const ink = new THREE.MeshBasicMaterial({ color: 0x0a0f0a, toneMapped: false });
    const arm = (horizontal: boolean, sign: number): void => {
      const length = (RETICLE_ARM - RETICLE_GAP) * EYEPIECE_RADIUS;
      const centre = (RETICLE_GAP + (RETICLE_ARM - RETICLE_GAP) / 2) * EYEPIECE_RADIUS * sign;
      const thickness = RETICLE_THICKNESS * 2;
      const mesh = new THREE.Mesh(
        horizontal
          ? new THREE.PlaneGeometry(length, thickness)
          : new THREE.PlaneGeometry(thickness, length),
        ink,
      );
      mesh.position.set(horizontal ? centre : 0, horizontal ? 0 : centre, 0.005);
      this.overlay.add(mesh);
    };
    arm(true, 1);
    arm(true, -1);
    arm(false, 1);
    arm(false, -1);

    const dot = new THREE.Mesh(new THREE.CircleGeometry(RETICLE_THICKNESS * 1.4, 12), ink);
    dot.position.z = 0.005;
    this.overlay.add(dot);
  }

  /** Keep the disc round when the window changes shape. */
  resize(width: number, height: number): void {
    const aspect = width / Math.max(1, height);
    this.overlayCamera.left = -aspect;
    this.overlayCamera.right = aspect;
    this.overlayCamera.updateProjectionMatrix();
  }

  /**
   * Draw the scope image over the frame that has just been rendered.
   *
   * Call after the main render. `magnification` divides the scope's own field
   * of view and nothing else — the surrounding view keeps whatever the naked
   * eye had, which is the entire point of a picture-in-picture scope.
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    eye: THREE.Camera,
    magnification: number,
  ): void {
    // The scope looks from exactly where the eye is, so the shot lands where
    // the reticle is. Deriving it from the eye's world matrix rather than
    // copying position and rotation separately keeps it correct even though the
    // weapon and its hands are children of that camera.
    eye.updateWorldMatrix(true, false);
    this.camera.position.setFromMatrixPosition(eye.matrixWorld);
    this.camera.quaternion.setFromRotationMatrix(eye.matrixWorld);
    this.camera.fov = SCOPE_BASE_FOV_DEG / Math.max(1, magnification);
    this.camera.updateProjectionMatrix();

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(previousTarget);

    // Over the top of the finished frame, depth cleared so nothing in the world
    // can poke through the eyepiece.
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.overlay, this.overlayCamera);
    renderer.autoClear = autoClear;
  }

  dispose(): void {
    this.target.dispose();
  }
}
