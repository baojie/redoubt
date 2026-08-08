/**
 * The soldier model.
 *
 * One rigged glTF, loaded once and cloned per body. It carries an attribution
 * obligation — see ATTRIBUTION.md.
 *
 * This replaced a featureless mannequin whose limbs were posed by hand: two
 * shoulder bones and two hip bones driven by a sine wave, with a helmet and a
 * chest rig built from primitives on top. That produced a red mass with a box
 * for a head, because everything on it — skin, kit, boots — was painted the
 * team's colour. The model here is a soldier already: its own helmet, webbing
 * and boots, a separate material for each, and twenty-four authored clips.
 *
 * Three rules shape how it is used, two carried over and one new:
 *
 *  1. **It must not lie about the hitbox.** The server tests rounds against a
 *     cylinder of `BODY_RADIUS_M` by `BODY_HALF_HEIGHT_M * 2`. The model is
 *     scaled to that height, because a figure that does not match the cylinder
 *     teaches players to aim at edges that never register.
 *  2. **It must be optional.** If the file is missing or blocked, the caller
 *     falls back to a figure built from primitives. A missing asset should cost
 *     fidelity, not the ability to see the enemy.
 *  3. **Only the uniform takes the team's colour.** Painting the whole soldier
 *     is what made the old one a red silhouette. The model's materials are
 *     named, so the uniform can be tinted and the face, hair and boots left
 *     alone — friend-or-foe stays readable at range without the soldier
 *     ceasing to look like a person up close.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { rules } from "@redoubt/core";

const MODEL_URL = "/models/Soldier.glb";

/** Target height, matched to the cylinder the server actually tests against. */
const TARGET_HEIGHT_M = rules.BODY_HALF_HEIGHT_M * 2;

/**
 * Clips, by the names the asset uses.
 *
 * Four of the twenty-four it ships with; the rest are for a game with melee and
 * jumping. Anything missing is skipped, so a model with a different set
 * degrades to a stiff figure rather than throwing.
 */
const CLIPS = {
  idle: "CharacterArmature|Idle_Gun",
  walk: "CharacterArmature|Walk",
  // "Run", not "Run_Gun": that name belongs to a different Quaternius
  // character. Named wrongly it is silently skipped — `play` returns early on a
  // missing action and the soldier keeps whatever clip it had, which looks like
  // a walk that never speeds up rather than like a bug.
  run: "CharacterArmature|Run",
  death: "CharacterArmature|Death",
} as const;

type ClipName = keyof typeof CLIPS;

/**
 * The material that is the uniform, by name.
 *
 * "Swat" is the fatigues on this asset. Skin, hair and boots have their own
 * materials and are deliberately left alone.
 */
const UNIFORM_MATERIAL = "Swat";

/**
 * How far the team colour is mixed into the uniform.
 *
 * Low on purpose. The fatigues are near-black, and mixing more than about a
 * third of a bright team colour into them turns the soldier into somebody in a
 * red or blue t-shirt — recognisable as a team, no longer recognisable as a
 * soldier. A third is enough to read at two hundred metres because the eye is
 * comparing it against grass and brick, not against the other team.
 */
const TEAM_TINT_STRENGTH = 0.32;

/**
 * Metres covered per full stride, and the speed above which a soldier is
 * running rather than walking.
 *
 * The locomotion clips are advanced by distance travelled, not by wall time —
 * the same rule the old hand-posed walk followed, and for the same reason: a
 * time-driven cycle keeps striding when its owner is standing still, and skates
 * whenever the two disagree.
 */
const METRES_PER_WALK_CYCLE = 1.6;
const METRES_PER_RUN_CYCLE = 2.9;
const RUN_ABOVE_MPS = 3.6;

/** How long the gait cross-fade takes. */
const GAIT_FADE_S = 0.15;

export interface SoldierRig {
  root: THREE.Object3D;
  /** Facing correction, measured from the model rather than assumed. */
  facingOffset: number;
  /** Drives the clips. One per soldier: mixers are not shareable. */
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<ClipName, THREE.AnimationAction>>;
  current: ClipName | null;
  /** The uniform meshes, which are the only ones that take a team colour. */
  tinted: THREE.Mesh[];
}

export class SoldierModel {
  private template: THREE.Object3D | null = null;
  private clips: THREE.AnimationClip[] = [];
  private scale = 1;
  /**
   * How far the model has to be turned so it faces the way the rules mean.
   *
   * glTF authors point characters whichever way suits them, and guessing is how
   * you end up with a squad that walks backwards. Measured from the mesh: a
   * human is wider across the shoulders than front-to-back, so the narrower
   * horizontal axis is the facing axis.
   */
  private facingOffset = 0;
  /** Null until a load has been attempted; false if it failed. */
  loaded: boolean | null = null;

  async load(): Promise<boolean> {
    try {
      const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
      const root = gltf.scene;

      const bounds = new THREE.Box3().setFromObject(root);
      const height = bounds.max.y - bounds.min.y;
      this.scale = height > 0 ? TARGET_HEIGHT_M / height : 1;

      const width = bounds.max.x - bounds.min.x;
      const depth = bounds.max.z - bounds.min.z;
      // Shoulders across x means the model already faces along z, which is what
      // the scene expects; shoulders across z means it needs a quarter turn.
      this.facingOffset = width >= depth ? 0 : Math.PI / 2;

      this.template = root;
      this.clips = gltf.animations ?? [];
      this.loaded = true;
      return true;
    } catch {
      // Missing, blocked, or offline. The caller falls back to primitives.
      this.loaded = false;
      return false;
    }
  }

  /**
   * A fresh, independently animated soldier, or null if unavailable.
   *
   * `SkeletonUtils.clone` rather than `Object3D.clone`, because a skinned mesh
   * shares its skeleton with the original otherwise and every soldier on the
   * map ends up in the same pose as the last one drawn.
   */
  instantiate(): SoldierRig | null {
    if (this.template === null) return null;

    const model = cloneSkinned(this.template);
    model.scale.setScalar(this.scale);
    // Stand the model on the ground: the caller positions bodies by their
    // torso, which is where the server puts the centre of the hit cylinder.
    model.position.y = -rules.TORSO_HEIGHT_M;

    const tinted: THREE.Mesh[] = [];
    model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Materials are cloned per instance so one soldier's team colour does
      // not repaint every other soldier sharing the template's material.
      const source = mesh.material as THREE.Material;
      mesh.material = Array.isArray(source)
        ? source.map((m) => m.clone())
        : source.clone();

      const names = Array.isArray(mesh.material)
        ? mesh.material.map((m) => m.name)
        : [mesh.material.name];
      if (names.includes(UNIFORM_MATERIAL)) tinted.push(mesh);
    });

    const root = new THREE.Group();
    root.add(model);

    const mixer = new THREE.AnimationMixer(model);
    const actions: SoldierRig["actions"] = {};
    for (const [key, clipName] of Object.entries(CLIPS) as Array<[ClipName, string]>) {
      const clip = this.clips.find((c) => c.name === clipName);
      if (clip === undefined) continue;
      const action = mixer.clipAction(clip);
      if (key === "death") {
        // A corpse stays down. Left looping, the death clip has the body sit
        // up and fall over again, which is worse than not animating at all.
        action.loop = THREE.LoopOnce;
        action.clampWhenFinished = true;
      }
      actions[key] = action;
    }

    return { root, facingOffset: this.facingOffset, mixer, actions, current: null, tinted };
  }

  /**
   * Drive a soldier for one frame.
   *
   * `movedM` is how far they actually travelled since the last frame and `dt`
   * how long that took. The locomotion clips advance with the ground covered;
   * idle and death advance on the clock. Mixing the two is deliberate: a walk
   * driven by wall time skates, and an idle driven by distance freezes solid
   * the moment its owner stops moving.
   */
  advance(rig: SoldierRig, dt: number, movedM: number, alive: boolean): void {
    const speed = dt > 0 ? movedM / dt : 0;
    const wanted: ClipName = !alive
      ? "death"
      : movedM <= 1e-4
        ? "idle"
        : speed >= RUN_ABOVE_MPS
          ? "run"
          : "walk";

    this.play(rig, wanted);

    let clipSeconds = dt;
    const action = rig.actions[wanted];
    if ((wanted === "walk" || wanted === "run") && action !== undefined) {
      const metresPerCycle = wanted === "run" ? METRES_PER_RUN_CYCLE : METRES_PER_WALK_CYCLE;
      clipSeconds = (movedM / metresPerCycle) * action.getClip().duration;
    }
    rig.mixer.update(clipSeconds);
  }

  /** Cross-fade to a clip, if it is not already the one running. */
  private play(rig: SoldierRig, name: ClipName): void {
    if (rig.current === name) return;
    const next = rig.actions[name];
    if (next === undefined) return;

    const previous = rig.current === null ? undefined : rig.actions[rig.current];
    next.reset();
    next.enabled = true;
    next.play();
    // Short, because soldiers start and stop constantly; a long fade reads as
    // sliding rather than as changing gait.
    if (previous !== undefined && previous !== next) previous.crossFadeTo(next, GAIT_FADE_S, false);
    rig.current = name;
  }

  /**
   * Paint the uniform. Emissive carries friend-or-foe at a glance.
   *
   * Only the meshes wearing the uniform material are touched, and the colour is
   * mixed part-way from the fabric's own tone rather than replacing it. Setting
   * every material to a saturated team colour is what turned the previous
   * soldier into a flat red silhouette with a box for a head.
   */
  tint(rig: SoldierRig, colour: number, emissive: number): void {
    const team = new THREE.Color(colour);
    for (const mesh of rig.tinted) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const standard = material as THREE.MeshStandardMaterial;
        if (standard.name !== UNIFORM_MATERIAL) continue;
        standard.color?.lerp(team, TEAM_TINT_STRENGTH);
        standard.emissive?.setHex(emissive);
      }
    }
  }
}
