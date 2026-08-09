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
import { fabricTexture, gloveTexture } from "./fabric.js";
import { flashTexture } from "./flash.js";
import { buildHand, wristOffset } from "./hands.js";
import {
  buildRifle,
  muzzleOffset as primitiveMuzzleOffset,
  opticHeight as primitiveOpticHeight,
  scopeCentre,
  mountScope,
} from "./rifle.js";
import { RifleModels } from "./rifleModel.js";

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
/**
 * Sleeve and glove tints.
 *
 * Near-white now, not the old olive and near-black: `color` multiplies the map,
 * and the textures already carry the colour — leaving the old values in
 * multiplied olive by olive and produced a black tube. What is left is a gentle
 * darkening, because a plain white multiplier let both surfaces come out paler
 * than the soldier's own fatigues and the gloves read as light grey blocks.
 */
const SLEEVE_COLOUR = 0xa7ad98;
/**
 * Warm, where it used to be grey.
 *
 * The rifle is a neutral 0x3c4046 and the gloves were a neutral 0x74767c over a
 * near-black leather texture — two greys of similar value, touching, in the
 * corner of every frame. Value alone was never going to separate them, so the
 * hand now separates by *hue*: tan leather against a cold grey weapon reads as
 * two objects even where the light is flat and even in the shadowed half.
 */
const GLOVE_COLOUR = 0xc39c6d;
const FOREARM_RADIUS_M = 0.027;

/**
 * Where each arm's elbow sits, in the weapon's own frame.
 *
 * These are placed the way the shoulders used to be *derived* and the result
 * photographed as pipes. The old scheme took a shoulder point down behind the
 * eye and pushed the elbow a small distance off the straight line to it; the
 * projection put both elbows off the bottom of the screen (firing elbow at NDC
 * (2.1, −2.7)), so what a player saw was a single straight tube from the hand
 * to the frame edge. A straight tube of constant curvature is a pipe, and no
 * weave on it changes that.
 *
 * So the elbow is placed by working backwards from the screen instead. Each
 * point here was chosen so that in the hip-carry pose it projects to a visible
 * bend — firing to NDC (1.05, −0.88), support to (0.05, −0.85) — with the
 * forearm then running down to it at a clear angle and the depth chosen so the
 * joint sits between the hand and the eye, which is where an elbow actually is.
 */
const FIRING_ELBOW = new THREE.Vector3(0.139, -0.043, 0.217);
const SUPPORT_ELBOW = new THREE.Vector3(-0.22, -0.062, 0.241);

/**
 * Where the upper arm runs to from the elbow.
 *
 * Below the elbow and back behind the eye, so the bicep segment is clipped by
 * the near plane rather than ending in a visible flat lid — the same trick the
 * old shoulder points played, but now with the bend *above* the frame instead
 * of everything above it.
 */
const FIRING_SHOULDER = new THREE.Vector3(0.139, -0.423, 0.397);
const SUPPORT_SHOULDER = new THREE.Vector3(-0.27, -0.392, 0.421);

/** Across the knuckles. A hand, at the scale this rifle is drawn. */
const HAND_WIDTH_M = 0.063;

/**
 * What each hand closes around.
 *
 * Both come off the rifle's own proportions rather than being dialled in: the
 * support hand takes the barrel's half-thickness plus clearance for a glove,
 * the firing hand the pistol grip's. Resize the weapon and the grips still fit,
 * which is the whole reason `rifle.ts` keeps its proportions as fractions.
 */
const SUPPORT_GRIP_RADIUS_M = 0.024;
const FIRING_GRIP_RADIUS_M = 0.026;

/** Where along the barrel the support hand sits, as a fraction of the length. */
const SUPPORT_HAND_Z = -0.42;

/**
 * How the support hand is turned onto the handguard.
 *
 * A quarter turn puts the back of the hand *underneath* the barrel, which is
 * how a handguard is actually held and — the reason it is worth the trouble —
 * the only arrangement where the closed fingers face the eye. With the hand
 * outboard, every finger is on the far side of the barrel and the grip is a
 * brown band; from underneath, the fingers come up the near side and the hand
 * reads as holding something.
 */
const SUPPORT_ROLL_RAD = -Math.PI / 2 - 0.3;

/** The firing hand rakes back a little, as a hand on a pistol grip does. */
const FIRING_RAKE_RAD = 0.22;

/**
 * Where the real rifle's scope hangs, as a fraction of its length.
 *
 * The real model ships without a scope, so the primitive one is mounted on it —
 * but at a height measured from the real receiver rather than the primitive
 * proportions (see `opticAxisY`). The forward position is dialled in: centred
 * over the carry handle, which is where a scope goes on this rifle.
 */
const GLB_SCOPE_CENTRE = -0.04;

/** The barrel axis of the primitive rifle, where its flash and hand sit. */
const PRIMITIVE_BARREL_Y = 0.01;

/** How far the weapon drops out of view during a reload. */
const RELOAD_DROP_M = 0.22;
const RELOAD_ROLL_RAD = 0.5;

export class Viewmodel {
  private readonly root = new THREE.Group();
  /** The shared loader, so the real rifle can replace the primitive one. */
  private readonly rifles: RifleModels;
  /** The primitive rifle's material; the real rifle's scope borrows it too. */
  private readonly rifleMaterial: THREE.Material;
  /** The gun body: primitive at first, the real model after it loads. */
  private rifle: THREE.Object3D;
  /** Whether the real model has already replaced the primitive rifle. */
  private glb = false;
  /** Everything the hands drew, so they can be taken down on a swap. */
  private readonly handNodes: THREE.Object3D[] = [];

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

  constructor(camera: THREE.Camera, rifles: RifleModels) {
    this.rifles = rifles;
    // Light enough to hold an edge against dark ground. A near-black weapon
    // against a shadowed hillside is one flat silhouette with no shape in it.
    this.rifleMaterial = new THREE.MeshStandardMaterial({ color: 0x3c4046, roughness: 0.6 });
    this.rifle = buildRifle(RIFLE_LENGTH_M, this.rifleMaterial, true);
    this.root.add(this.rifle);

    // The flash hangs off the muzzle. Where the muzzle is depends on which
    // rifle is up, so it is asked for rather than hard-coded.
    this.flash = buildFlash();
    this.flash.position.set(0, this.barrelY(), this.muzzleZ());
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
   * Each forearm is aimed along the line from its wrist back towards the
   * shoulder it comes from, rather than being built out of Euler angles. An
   * earlier version set `rotation.set(x, 0, z)` on a cylinder, the second
   * rotation applied in the frame the first had already turned, and both arms
   * came out as logs pointing in arbitrary directions.
   *
   * Only the near part of the forearm is drawn: a limb continued to the
   * shoulder would cross the camera's near plane and be sliced open from
   * inside, and none of it would be visible anyway.
   *
   * The hands come from `hands.ts` and are placed **on the weapon** — the
   * support hand around the barrel, the firing hand around the pistol grip —
   * rather than beside it. That is the correction. The previous version held
   * both hands clear of the receiver so they would not be swallowed by it, and
   * the result was two sleeves ending in dark lumps near a rifle they were not
   * touching: hands read as hands because of the fingers closed around
   * something, and a hand holding nothing has no fingers to show.
   *
   * Each hand is turned onto its grip with a quaternion built from the axis it
   * closes around, not with Euler angles, for the same reason the forearms are.
   */
  private addHands(): void {
    // Textured rather than flat. The hands are in the corner of every single
    // frame, so they are the surface a player has the most time to notice is
    // untextured — and against a textured soldier and a textured world, they
    // were the one thing left that looked like placeholder geometry.
    //
    // The same canvas doubles as a bump map: it costs nothing extra and turns
    // the weave and the stitching from a printed pattern into something the
    // light catches, which is most of the difference at this distance.
    const cloth = fabricTexture();
    const sleeve = new THREE.MeshStandardMaterial({
      color: SLEEVE_COLOUR,
      map: cloth,
      bumpMap: cloth,
      bumpScale: 0.004,
      roughness: 0.95,
    });
    const leather = gloveTexture();
    const glove = new THREE.MeshStandardMaterial({
      color: GLOVE_COLOUR,
      map: leather,
      bumpMap: leather,
      bumpScale: 0.006,
      roughness: 0.7,
    });
    const up = new THREE.Vector3(0, 1, 0);

    // Every part of a hand rides the weapon and nothing about it moves
    // independently, so on a rifle swap the whole arm is taken down at once.
    const track = (obj: THREE.Object3D): void => {
      this.root.add(obj);
      this.handNodes.push(obj);
    };

    /**
     * One arm: a hand closed on the weapon, and a sleeve running back from its
     * wrist towards the elbow, then down off the frame.
     *
     * `at` is the axis of the thing being gripped, `turn` puts the canonical
     * hand onto it, and the wrist — hence where the sleeve starts — falls out
     * of the two rather than being placed separately. `elbow` and `shoulder`
     * are the two joints, both in the weapon's frame, chosen so the bend lands
     * on screen (see the FIRING_ELBOW / SUPPORT_ELBOW notes).
     */
    const arm = (
      at: THREE.Vector3,
      turn: THREE.Quaternion,
      gripRadius: number,
      elbow: THREE.Vector3,
      shoulder: THREE.Vector3,
      grip: { trigger?: boolean; thumbForward?: boolean },
    ): void => {
      const hand = buildHand({
        gripRadius,
        width: HAND_WIDTH_M,
        material: glove,
        ...grip,
      });
      hand.position.copy(at);
      hand.quaternion.copy(turn);
      track(hand);

      // The wrist leaves the palm along the hand's own +x, wherever the hand
      // has been turned to.
      const wrist = at
        .clone()
        .add(
          new THREE.Vector3(wristOffset(gripRadius), 0, 0).applyQuaternion(turn),
        );
      const towards = shoulder.clone().sub(wrist).normalize();

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
      cuff.position.copy(wrist).addScaledVector(towards, 0.012);
      track(cuff);

      // The arm bends.
      //
      // This is the whole of what was wrong, and it is worth being blunt about:
      // a single straight cylinder from wrist to shoulder is a pipe. Not a
      // badly textured arm — a pipe, because "straight tube of constant
      // curvature" is what a pipe *is*, and no amount of weave on it changes
      // the silhouette. Arms have an elbow, and the bend is the read.
      //
      // So: two segments meeting at an elbow that projects onto the screen,
      // thin at the wrist and thickest just above the elbow, with the far end
      // running past the shoulder point — which sits behind the eye — so it is
      // clipped by the near plane rather than showing a flat lid floating in
      // mid-air.
      const bone = (from: THREE.Vector3, to: THREE.Vector3, near: number, far: number): void => {
        const along = to.clone().sub(from);
        const length = along.length();
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(FOREARM_RADIUS_M * near, FOREARM_RADIUS_M * far, length, 10),
          sleeve,
        );
        // Oval in section, not round. A forearm is wider across than through,
        // and a perfectly circular cross-section is the other half of why a
        // cylinder reads as plumbing however it is shaded.
        mesh.scale.set(1, 1, 0.82);
        // The cylinder's own axis is +y; point that down the bone.
        mesh.quaternion.setFromUnitVectors(up, along.normalize());
        mesh.position.copy(from).addScaledVector(along, length / 2);
        track(mesh);
      };

      // The taper is the point of a limb. A real forearm roughly doubles in
      // thickness from wrist to elbow, and it is that change over the visible
      // span — not the bend alone — that stops the silhouette reading as a
      // constant-width tube.
      bone(wrist, elbow, 0.55, 1.15);
      bone(elbow, shoulder, 1.15, 1.5);

      // A ball in the joint, so the two do not read as two pipes in a socket.
      const joint = new THREE.Mesh(
        new THREE.SphereGeometry(FOREARM_RADIUS_M * 1.08, 10, 8),
        sleeve,
      );
      joint.position.copy(elbow);
      track(joint);
    };

    // Firing hand: the pistol grip runs down the weapon's own -y, so turning
    // the canonical hand a quarter turn about x puts its grip axis on the grip,
    // its palm outboard right, its fingers closing around the front of the grip
    // and its thumb behind — which is where all four of those things belong.
    const firing = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 2 + FIRING_RAKE_RAD,
    );
    // Where each hand closes on the rifle. The primitive rifle and the real
    // model grip at different points, so the positions come from whichever is
    // up: the real rifle's pistol grip sits at its origin and its handguard at
    // the measured barrel axis, while the primitive rifle's were dialled into
    // its own proportions.
    const firingGrip = this.glb
      ? new THREE.Vector3(0, -0.02, RIFLE_LENGTH_M * 0.02)
      : new THREE.Vector3(0, -0.035, RIFLE_LENGTH_M * 0.055);
    const supportGrip = this.glb
      ? new THREE.Vector3(0, this.barrelY(), RifleModels.handguardOffset(RIFLE_LENGTH_M))
      : new THREE.Vector3(0, 0.006, RIFLE_LENGTH_M * SUPPORT_HAND_Z);
    const firingRadius = this.glb ? 0.022 : FIRING_GRIP_RADIUS_M;
    const supportRadius = this.glb ? 0.02 : SUPPORT_GRIP_RADIUS_M;

    arm(
      firingGrip,
      firing,
      firingRadius,
      FIRING_ELBOW,
      FIRING_SHOULDER,
      { trigger: true },
    );

    // Support hand: the barrel already runs along z, so the canonical hand only
    // has to be rolled round it until the back of the hand is underneath.
    const support = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      SUPPORT_ROLL_RAD,
    );
    arm(
      supportGrip,
      support,
      supportRadius,
      SUPPORT_ELBOW,
      SUPPORT_SHOULDER,
      { thumbForward: true },
    );
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

  /**
   * Swap the primitive rifle for the real model, once it has loaded.
   *
   * Everything that hangs off the rifle — the scope, both hands, the muzzle
   * flash — is rebuilt from the real model's measured geometry, because the
   * primitive rifle's proportions no longer apply. If the model never arrived
   * the primitive rifle simply stays.
   */
  useRifleModel(): void {
    const rifle = this.rifles.instantiate(RIFLE_LENGTH_M);
    if (rifle === null) return;

    this.root.remove(this.rifle);
    for (const node of this.handNodes) this.root.remove(node);
    this.handNodes.length = 0;

    this.rifle = rifle;
    this.root.add(this.rifle);
    this.glb = true;

    // The primitive scope is mounted on the real receiver at the height the
    // real receiver is, borrowing the real model's own material so it matches.
    const body = firstMaterial(rifle) ?? this.rifleMaterial;
    mountScope(rifle, RIFLE_LENGTH_M, body, this.opticAxisY(), this.scopeCentreZ());

    this.addHands();

    // The flash now hangs off the real muzzle rather than the primitive one.
    this.flash.position.set(0, this.barrelY(), this.muzzleZ());
    this.flashLight.position.copy(this.flash.position);
  }

  /**
   * The geometry facts of whichever rifle is up.
   *
   * The primitive rifle and the real model hold their muzzle, barrel and optic
   * at different heights and distances from the grip, and every one of those
   * is a fact a caller acts on — the flash goes on the muzzle, the support
   * hand on the barrel, the eye on the optic. So instead of scattering
   * if-this-else-that at the call sites, the choice lives here.
   */
  private muzzleZ(): number {
    return this.glb
      ? RifleModels.muzzleOffset(RIFLE_LENGTH_M)
      : primitiveMuzzleOffset(RIFLE_LENGTH_M);
  }
  private barrelY(): number {
    return this.glb
      ? RifleModels.barrelHeight(RIFLE_LENGTH_M)
      : PRIMITIVE_BARREL_Y;
  }
  private opticAxisY(): number {
    return this.glb
      ? RifleModels.opticHeight(RIFLE_LENGTH_M)
      : primitiveOpticHeight(RIFLE_LENGTH_M);
  }
  private scopeCentreZ(): number {
    return this.glb ? GLB_SCOPE_CENTRE * RIFLE_LENGTH_M : scopeCentre(RIFLE_LENGTH_M);
  }
  private adsY(): number {
    return -this.opticAxisY();
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
      (this.adsY() - HIP.y) * this.aimBlend +
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
 * The first material a model's meshes share, or null if it has none.
 *
 * The real rifle's scope is built out of the rifle's own material, so a grey
 * tube and a grey rifle do not read as two different objects. Which material
 * that is comes from the model rather than being assumed — the Quaternius
 * asset happens to paint everything with three variants of the same scheme.
 */
function firstMaterial(root: THREE.Object3D): THREE.Material | null {
  let found: THREE.Material | null = null;
  root.traverse((object) => {
    if (found !== null) return;
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material as THREE.Material | THREE.Material[];
    found = Array.isArray(material) ? (material[0] ?? null) : material;
  });
  return found;
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
