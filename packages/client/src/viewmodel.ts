/**
 * The weapon in your own hands.
 *
 * Until now first person showed a crosshair floating over an empty world. The
 * rifle was on every soldier's back except the one you were playing, which made
 * the view read as a camera rather than as a person — and it took away the only
 * continuous feedback the game has about the weapon's state. A magazine counter
 * tells you the number; the rifle dipping out of view tells you that you cannot
 * shoot for the next two seconds, without you having to read anything.
 *
 * It is a child of the camera, so it inherits the view transform for free and
 * nothing here has to know about world space.
 *
 * Two things it must not do:
 *
 *  1. **Cover the crosshair.** The weapon sits low and to the right, and when
 *     aiming it comes to just under centre. Rounds go where the crosshair is,
 *     not where the barrel is drawn, so a viewmodel that covers the aim point
 *     is actively lying about where you are shooting.
 *  2. **Clip through the near plane.** The camera's near plane is 0.1 m; the
 *     weapon lives well beyond it, and is scaled down rather than pulled
 *     closer when it needs to look bigger.
 */

import * as THREE from "three";
import { rules } from "@redoubt/core";
import { flashTexture } from "./flash.js";
import { buildRifle, muzzleOffset, opticHeight } from "./rifle.js";

/**
 * Overall rifle length, and how far out it is held.
 *
 * These two are one decision, not two: what a player sees is the angle the
 * weapon subtends, so halving the distance is the same as doubling the rifle.
 * The first attempt put a 0.86 m rifle 0.42 m from the eye, which sounds like
 * arm's length and looked like carrying a wardrobe — the stock alone, being
 * nearest, took a quarter of the screen.
 *
 * Sized instead by the fraction of the view it should occupy: the receiver is
 * about a twentieth of the screen width, which reads as a held weapon without
 * competing with the world for attention.
 */
const RIFLE_LENGTH_M = 0.6;

/** How far in front of the eye the weapon sits. Comfortably past the near plane. */
const REST_Z = -0.7;

/** Hip carry: down and to the right, out of the way of the aim point. */
const HIP = new THREE.Vector3(0.3, -0.26, REST_Z);
/**
 * Canted across the body when not aiming, which is how a rifle is actually
 * carried — and, less romantically, the only way it reads as a rifle at all.
 * Pointed straight down the view axis it is a dark rectangle seen end-on, with
 * no length visible and nothing to tell it from a wall.
 */
const HIP_YAW_RAD = -0.34;
const HIP_PITCH_RAD = 0.07;
const HIP_ROLL_RAD = 0.12;

/**
 * Aiming: sights centred horizontally and dropped so the eye looks over them.
 *
 * The vertical figure is derived rather than dialled in — the weapon is lowered
 * by exactly the height of its own optic axis, which is what puts the line
 * through the scope, rather than the barrel or the iron sights, on the
 * crosshair.
 */
const ADS_X = 0;
const ADS_Y = -opticHeight(RIFLE_LENGTH_M);
const ADS_Z = -0.58;

/** How fast the weapon moves between carry and aim. */
const ADS_EASE_PER_S = 14;

/** Recoil: straight back and slightly up, then a spring back to rest. */
const RECOIL_PER_SHOT_M = 0.035;
const RECOIL_MAX_M = 0.075;
const RECOIL_RECOVERY_PER_S = 0.42;
const RECOIL_RISE_RAD = 0.9;

/**
 * Walking sway, driven by distance rather than by time.
 *
 * Same reason the soldiers' legs are: a time-driven bob keeps bobbing when you
 * stand still, and stops matching your pace the moment anything changes speed.
 */
const METRES_PER_BOB = 1.9;
const BOB_X_M = 0.012;
const BOB_Y_M = 0.016;

/**
 * Muzzle flash.
 *
 * Two parts, because a flash is two things at once. The visible flare says
 * *you* fired; the burst of light says the world was lit by it, and that is the
 * half people notice without being able to name — a bright quad with no light
 * behind it reads as a decal stuck on the screen.
 *
 * Very short. A flash you can still see two frames later stops reading as an
 * explosion and starts reading as a lamp.
 */
const FLASH_SECONDS = 0.045;
const FLASH_RADIUS_M = 0.075;
const FLASH_LIGHT_RANGE_M = 9;
const FLASH_LIGHT_INTENSITY = 14;

/**
 * How much the flash varies in size from shot to shot.
 *
 * Identical flashes at 600 rounds a minute strobe like a fluorescent tube.
 * Varied deterministically off a shot counter rather than Math.random: nothing
 * here needs to be unpredictable, only uneven, and a counter is reproducible if
 * a recording ever needs to be compared frame by frame.
 */
const FLASH_SIZE_VARIATION = 0.35;

/**
 * The hands and forearms holding the weapon.
 *
 * Without them the rifle floats, and a floating rifle reads as a HUD element
 * rather than as something a person is carrying — which undercuts the whole
 * reason for drawing a weapon in the first place.
 *
 * They are children of the weapon, not of the camera. Hands that stayed put
 * while the rifle kicked and swayed would look worse than no hands at all, and
 * parenting them to the weapon makes recoil, sway, the aim transition and the
 * reload dip all carry them for free.
 *
 * Positions come from the rifle's own proportions: the firing hand at the grip,
 * the support hand forward on the handguard. Both are placed relative to the
 * receiver, so resizing the weapon moves the hands with it.
 */
const SLEEVE_COLOUR = 0x4a5340;
const GLOVE_COLOUR = 0x24262a;
const FOREARM_LENGTH_M = 0.26;
const FOREARM_RADIUS_M = 0.027;
const HAND_SIZE_M = 0.072;

/** How far the weapon drops out of view during a reload. */
const RELOAD_DROP_M = 0.22;
const RELOAD_ROLL_RAD = 0.5;

export class Viewmodel {
  private readonly root = new THREE.Group();
  private readonly rifle: THREE.Group;

  /** Whether the player is holding the weapon at all, as last told. */
  private held = false;

  /** 0 at the hip, 1 fully aimed. Eased, so it lags the state change. */
  private aimBlend = 0;
  private recoilM = 0;
  private bobPhase = 0;
  /** Seconds left on the muzzle flash, and how many shots have been fired. */
  private flashLeft = 0;
  private shotCount = 0;
  private readonly flash: THREE.Sprite;
  private readonly flashLight: THREE.PointLight;
  /** 0 to 1 through the current reload, for the dip. */
  private reloadBlend = 0;

  constructor(camera: THREE.Camera) {
    // Light enough to hold an edge against dark ground. A near-black weapon
    // against a shadowed hillside is one flat silhouette with no shape in it.
    const material = new THREE.MeshStandardMaterial({ color: 0x3c4046, roughness: 0.6 });
    this.rifle = buildRifle(RIFLE_LENGTH_M, material, true);
    this.root.add(this.rifle);

    // The flash hangs off the muzzle, which comes from the same proportions the
    // rifle is built from rather than being measured off the drawing.
    const muzzleZ = muzzleOffset(RIFLE_LENGTH_M);
    this.flash = buildFlash();
    this.flash.position.set(0, 0.01, muzzleZ);
    this.flash.visible = false;
    this.root.add(this.flash);

    this.flashLight = new THREE.PointLight(0xffd9a0, 0, FLASH_LIGHT_RANGE_M, 2);
    this.flashLight.position.copy(this.flash.position);
    this.root.add(this.flashLight);

    this.addHands();
    // Drawn after the world and never culled: it is always in front of the eye,
    // and a frustum test on an object parented to the camera is wasted work.
    this.root.frustumCulled = false;
    camera.add(this.root);
  }

  /**
   * Two arms, gripping.
   *
   * Each forearm is aimed along the line from its hand back towards the
   * shoulder it comes from, rather than being built out of Euler angles. An
   * earlier version set `rotation.set(x, 0, z)` on a cylinder, the second
   * rotation applied in the frame the first had already turned, and both arms
   * came out as logs pointing in arbitrary directions.
   *
   * Only the near part of the forearm is drawn: a limb continued to the
   * shoulder would cross the camera's near plane and be sliced open from
   * inside, and none of it would be visible anyway.
   *
   * The hand is built rather than boxed. A single cube for a fist reads as a
   * pipe end — which is exactly how the first version looked, because the cube
   * was also buried inside the receiver where nothing of it showed. A hand is
   * recognisable from three things at this distance: it is wider than the arm,
   * it has a thumb on one side, and it has knuckles across the back. So it gets
   * all three, and it sits proud of the weapon where it can be seen.
   */
  private addHands(): void {
    const sleeve = new THREE.MeshStandardMaterial({ color: SLEEVE_COLOUR, roughness: 0.9 });
    const glove = new THREE.MeshStandardMaterial({ color: GLOVE_COLOUR, roughness: 0.75 });
    const up = new THREE.Vector3(0, 1, 0);

    const arm = (hand: THREE.Vector3, shoulder: THREE.Vector3, thumbSide: number): void => {
      const towards = shoulder.clone().sub(hand).normalize();

      // Palm: flattened, not a cube — a hand around a grip is deeper than it
      // is wide, and the flattening is most of what stops it reading as a box.
      const palm = new THREE.Mesh(
        new THREE.BoxGeometry(HAND_SIZE_M * 0.82, HAND_SIZE_M * 1.05, HAND_SIZE_M * 1.5),
        glove,
      );
      palm.position.copy(hand);
      this.root.add(palm);

      // Knuckles: four small blocks across the back of the hand.
      for (let finger = 0; finger < 4; finger++) {
        const knuckle = new THREE.Mesh(
          new THREE.BoxGeometry(HAND_SIZE_M * 0.86, HAND_SIZE_M * 0.24, HAND_SIZE_M * 0.3),
          glove,
        );
        knuckle.position
          .copy(hand)
          .add(
            new THREE.Vector3(
              0,
              HAND_SIZE_M * 0.5,
              HAND_SIZE_M * (0.52 - finger * 0.34),
            ),
          );
        this.root.add(knuckle);
      }

      // Thumb, laid along the weapon on the inboard side.
      const thumb = new THREE.Mesh(
        new THREE.BoxGeometry(HAND_SIZE_M * 0.3, HAND_SIZE_M * 0.32, HAND_SIZE_M * 0.95),
        glove,
      );
      thumb.position
        .copy(hand)
        .add(new THREE.Vector3(thumbSide * HAND_SIZE_M * 0.5, HAND_SIZE_M * 0.24, 0));
      this.root.add(thumb);

      // Cuff, where the glove meets the sleeve. A visible seam is what tells
      // you the two are different things rather than one continuous tube.
      const cuff = new THREE.Mesh(
        new THREE.CylinderGeometry(
          FOREARM_RADIUS_M * 1.28,
          FOREARM_RADIUS_M * 1.28,
          0.035,
          10,
        ),
        glove,
      );
      cuff.quaternion.setFromUnitVectors(up, towards);
      cuff.position.copy(hand).addScaledVector(towards, HAND_SIZE_M * 0.85);
      this.root.add(cuff);

      const forearm = new THREE.Mesh(
        new THREE.CylinderGeometry(
          FOREARM_RADIUS_M * 0.8,
          FOREARM_RADIUS_M,
          FOREARM_LENGTH_M,
          10,
        ),
        sleeve,
      );
      // The cylinder's own axis is +y; point that at the shoulder.
      forearm.quaternion.setFromUnitVectors(up, towards);
      forearm.position.copy(hand).addScaledVector(towards, FOREARM_LENGTH_M / 2 + 0.03);
      this.root.add(forearm);
    };

    // Shoulders sit below and behind the weapon, outboard on each side. These
    // are directions for the forearms to run along, not anatomy — nothing above
    // the elbow is ever drawn.
    const rightShoulder = new THREE.Vector3(0.2, -0.34, 0.34);
    const leftShoulder = new THREE.Vector3(-0.22, -0.3, 0.3);

    // Firing hand on the grip, thumb inboard; support hand forward under the
    // handguard, thumb the other way. Both are pushed clear of the receiver so
    // the hand is actually visible rather than swallowed by the weapon.
    arm(new THREE.Vector3(0.062, -0.088, RIFLE_LENGTH_M * 0.05), rightShoulder, -1);
    arm(new THREE.Vector3(-0.058, -0.072, -RIFLE_LENGTH_M * 0.3), leftShoulder, 1);
  }

  /**
   * Show the weapon, or not.
   *
   * Hidden when there is no soldier to hold it — dead, waiting to deploy, or
   * sitting in a vehicle, where the rifle is stowed and the view is a cab.
   */
  setVisible(visible: boolean): void {
    this.held = visible;
    this.root.visible = visible;
  }

  /**
   * Hide the weapon for the scope's render pass, without forgetting whether it
   * was being held.
   *
   * Kept apart from `setVisible` deliberately: the scope pass runs inside a
   * frame, between the caller's own visibility decision and the next one, so
   * reusing that flag would have the weapon reappear or vanish depending on
   * which ran last.
   */
  setHiddenForScope(hidden: boolean): void {
    this.root.visible = hidden ? false : this.held;
  }

  /** A round has left the barrel. Called on the server's confirmation. */
  noteShot(): void {
    this.recoilM = Math.min(RECOIL_MAX_M, this.recoilM + RECOIL_PER_SHOT_M);
    this.flashLeft = FLASH_SECONDS;
    this.shotCount++;
    // Spin and resize it a little each shot, so automatic fire flickers rather
    // than strobing one identical shape at 600 rounds a minute.
    this.flash.material.rotation = this.shotCount * 1.1;
    const wobble = ((this.shotCount * 7) % 5) / 4;
    const size = FLASH_RADIUS_M * 2 * (1 - FLASH_SIZE_VARIATION / 2 + wobble * FLASH_SIZE_VARIATION);
    this.flash.scale.setScalar(size);
  }

  /**
   * Where the muzzle is in scene space.
   *
   * The player's own tracer starts here rather than at `shot.from`, which is
   * the soldier's eye — that is the right origin for everyone else's rounds,
   * but for your own it puts the streak's start inside the camera, so the round
   * appears to leave your forehead rather than the barrel you are looking at.
   */
  muzzleScenePosition(out: THREE.Vector3): THREE.Vector3 {
    this.flash.updateWorldMatrix(true, false);
    return this.flash.getWorldPosition(out);
  }

  /**
   * Advance the weapon one frame.
   *
   * `movedM` is how far the player actually moved, so the sway follows the
   * predicted position rather than a guess at their speed.
   */
  update(
    dt: number,
    aiming: boolean,
    movedM: number,
    reloadFraction: number,
  ): void {
    if (!this.root.visible) {
      // A weapon that is put away has no flash left burning on it.
      this.flashLeft = 0;
      this.flashLight.intensity = 0;
      return;
    }

    const ease = Math.min(1, dt * ADS_EASE_PER_S);
    this.aimBlend += ((aiming ? 1 : 0) - this.aimBlend) * ease;
    this.reloadBlend += (reloadFraction - this.reloadBlend) * ease;
    this.recoilM = Math.max(0, this.recoilM - RECOIL_RECOVERY_PER_S * dt);

    this.flashLeft = Math.max(0, this.flashLeft - dt);
    const flashStrength = this.flashLeft / FLASH_SECONDS;
    this.flash.visible = flashStrength > 0;
    // Fades rather than vanishing: at 45 ms even one frame of pop is visible.
    this.flash.material.opacity = flashStrength;
    this.flashLight.intensity = flashStrength * FLASH_LIGHT_INTENSITY;

    this.bobPhase += movedM / METRES_PER_BOB;
    // Sway settles as the weapon comes up: a rifle held against the shoulder
    // moves far less than one carried at the hip.
    const swayScale = 1 - this.aimBlend * 0.85;
    const sway = Math.sin(this.bobPhase * Math.PI * 2);

    const x = HIP.x + (ADS_X - HIP.x) * this.aimBlend + sway * BOB_X_M * swayScale;
    const y =
      HIP.y +
      (ADS_Y - HIP.y) * this.aimBlend +
      Math.abs(sway) * BOB_Y_M * swayScale -
      this.reloadBlend * RELOAD_DROP_M;
    const z = HIP.z + (ADS_Z - HIP.z) * this.aimBlend + this.recoilM;

    this.root.position.set(x, y, z);
    this.root.rotation.set(
      HIP_PITCH_RAD * (1 - this.aimBlend) - this.recoilM * RECOIL_RISE_RAD,
      HIP_YAW_RAD * (1 - this.aimBlend),
      HIP_ROLL_RAD * (1 - this.aimBlend) + this.reloadBlend * RELOAD_ROLL_RAD,
    );
  }
}

/**
 * How far through a reload the player is, from 0 (not reloading) to 1.
 *
 * Reads the authoritative finish tick rather than timing a local animation, so
 * the weapon comes back up exactly when the server says it can fire again. The
 * duration comes from the rules table for the same reason — a hard-coded
 * animation length would silently desynchronise the day the reload time is
 * retuned.
 */
export function reloadFraction(reloadingUntilTick: number, tick: number): number {
  const remaining = reloadingUntilTick - tick;
  if (remaining <= 0) return 0;
  const total = rules.RELOAD_TICKS;
  if (total <= 0) return 0;
  // Peaks in the middle of the reload and is back up by the end, so the weapon
  // is level again on the tick the player regains the ability to fire.
  return Math.sin(Math.min(1, remaining / total) * Math.PI);
}

/**
 * The flare itself.
 *
 * A sprite, not geometry. The first version used two quads meant to cross each
 * other, but rotating a plane about its own z spins it in place — the two were
 * coplanar and it drew one hard-edged square. A sprite faces the camera by
 * construction, which is what a flash should do anyway: it is a bloom of light,
 * and light has no back.
 *
 * Additive and depth-write off, because a muzzle flash emits rather than
 * receives — a lit material would go dark exactly when it matters, at night.
 */
function buildFlash(): THREE.Sprite {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: flashTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  sprite.scale.setScalar(FLASH_RADIUS_M * 2);
  return sprite;
}
