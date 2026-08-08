/**
 * Keyboard and mouse, turned into intents.
 *
 * Movement keys are read as *held state* and sampled once per input frame,
 * not turned into events. That matches how `core` models steering and means a
 * key held across a dropped frame keeps working.
 *
 * Action keys are edge-triggered and queued, so pressing a key exactly once
 * sends exactly one action however many frames it spans.
 */

import type { Intent } from "@redoubt/protocol";

export interface Camera {
  /** World metres per screen pixel. */
  metresPerPixel: number;
  centre: { x: number; y: number };
  /** Whole-map overview, ignoring the follow camera. */
  overview: boolean;
}

export type ActionKey =
  | "resupply"
  | "build"
  | "placeRally"
  | "placeFob"
  | "placeHabitat"
  | "placeAmmoCrate"
  | "enterVehicle"
  | "exitVehicle"
  | "reviveNearby"
  | "dragNearby"
  | "loadSupply"
  | "unloadSupply"
  | "giveUp"
  | "deploy"
  | "toggleView"
  | "toggleOverview"
  | "toggleHelp";

const MOVEMENT_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);

const ACTION_BINDINGS: Readonly<Record<string, ActionKey>> = {
  KeyE: "resupply",
  KeyB: "build",
  KeyR: "placeRally",
  KeyT: "placeFob",
  KeyH: "placeHabitat",
  KeyY: "placeAmmoCrate",
  KeyG: "enterVehicle",
  KeyV: "exitVehicle",
  KeyF: "reviveNearby",
  KeyQ: "dragNearby",
  KeyZ: "loadSupply",
  KeyC: "unloadSupply",
  KeyX: "giveUp",
  Space: "deploy",
  KeyM: "toggleOverview",
  Tab: "toggleView",
  Slash: "toggleHelp",
};

/** Zoom limits, in metres per pixel. Tighter than 0.2 is uselessly close. */
const MIN_METRES_PER_PIXEL = 0.2;
const MAX_METRES_PER_PIXEL = 2.0;
const ZOOM_STEP = 1.15;

export class InputState {
  private readonly held = new Set<string>();
  private readonly actions: ActionKey[] = [];
  /** World position of the most recent click, if there was one. */
  clickWorld: { x: number; y: number } | null = null;
  /** Live cursor position in world metres, for aiming and placement previews. */
  pointerWorld: { x: number; y: number } = { x: 0, y: 0 };

  readonly camera: Camera = {
    metresPerPixel: 0.55,
    centre: { x: 500, y: 500 },
    overview: false,
  };

  attach(canvas: HTMLCanvasElement): void {
    window.addEventListener("keydown", (event) => {
      // Never swallow browser shortcuts or typing in the join form.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Only text entry blocks game keys. Buttons used to block them too,
      // which meant that if any button anywhere still held focus — the join
      // button, a deploy option — WASD silently did nothing while every other
      // part of the client looked healthy.
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (MOVEMENT_KEYS.has(event.code)) {
        this.held.add(event.code);
        event.preventDefault();
        return;
      }
      if (event.repeat) return;
      const action = ACTION_BINDINGS[event.code];
      if (action !== undefined) {
        this.actions.push(action);
        event.preventDefault();
      }
    });

    window.addEventListener("keyup", (event) => {
      this.held.delete(event.code);
    });

    // Losing focus mid-stride would otherwise leave the soldier walking.
    window.addEventListener("blur", () => this.held.clear());

    canvas.addEventListener("mousemove", (event) => {
      this.pointerWorld = this.toWorld(canvas, event);
    });

    canvas.addEventListener("mousedown", (event) => {
      this.clickWorld = this.toWorld(canvas, event);
      event.preventDefault();
    });

    canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    // On the window rather than on the map canvas.
    //
    // That canvas is `display: none` for as long as the first-person view is
    // up, and a hidden element receives no mouse events at all — so a wheel
    // handler bound to it is silently dead in 3D, which is exactly how this
    // behaved. Bound here, the wheel always adjusts the map camera; which view
    // is on screen decides when you see it, not whether the input arrives.
    window.addEventListener(
      "wheel",
      (event) => {
        // Ctrl/Cmd+wheel is the browser's own zoom, and not ours to take.
        if (event.ctrlKey || event.metaKey) return;
        applyZoom(this.camera, event.deltaY);
        event.preventDefault();
      },
      { passive: false },
    );
  }

  /** The current movement direction, unnormalised. Screen axes: y grows down. */
  steerVector(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.held.has("KeyW")) y -= 1;
    if (this.held.has("KeyS")) y += 1;
    if (this.held.has("KeyA")) x -= 1;
    if (this.held.has("KeyD")) x += 1;
    return { x, y };
  }

  /** Which movement keys the client believes are down. Diagnostic. */
  heldMovementKeys(): string[] {
    return [...MOVEMENT_KEYS].filter((code) => this.held.has(code)).map((c) => c.slice(3));
  }

  /** Take and clear the queued actions for this frame. */
  drainActions(): ActionKey[] {
    return this.actions.splice(0);
  }

  /** Take and clear the click, if any. */
  drainClick(): { x: number; y: number } | null {
    const click = this.clickWorld;
    this.clickWorld = null;
    return click;
  }

  private toWorld(canvas: HTMLCanvasElement, event: MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    return screenToWorld(this.camera, canvas, px, py);
  }
}

/**
 * One notch of the wheel.
 *
 * Pure and exported because the listener that drives it cannot be exercised
 * without a DOM, while the two parts that were actually wrong — the clamp and
 * the handoff out of overview — are worth pinning down in a test.
 *
 * Scrolling drops the whole-map view. Overview fits the map to the window and
 * ignores `metresPerPixel` entirely, so without this the wheel is a control
 * that does nothing at all while M is on: not a mode, just a broken input.
 */
export function applyZoom(camera: Camera, deltaY: number): void {
  if (deltaY === 0) return;
  camera.overview = false;
  const factor = deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
  camera.metresPerPixel = Math.min(
    MAX_METRES_PER_PIXEL,
    Math.max(MIN_METRES_PER_PIXEL, camera.metresPerPixel * factor),
  );
}

/** Effective scale, accounting for overview mode fitting the whole map. */
export function effectiveScale(
  camera: Camera,
  canvas: HTMLCanvasElement,
  mapSizeM: number,
): number {
  if (!camera.overview) return camera.metresPerPixel;
  return mapSizeM / Math.min(canvas.width, canvas.height);
}

export function effectiveCentre(camera: Camera, mapSizeM: number): { x: number; y: number } {
  return camera.overview ? { x: mapSizeM / 2, y: mapSizeM / 2 } : camera.centre;
}

export function worldToScreen(
  camera: Camera,
  canvas: HTMLCanvasElement,
  mapSizeM: number,
  world: { x: number; y: number },
): { x: number; y: number } {
  const scale = effectiveScale(camera, canvas, mapSizeM);
  const centre = effectiveCentre(camera, mapSizeM);
  return {
    x: canvas.width / 2 + (world.x - centre.x) / scale,
    y: canvas.height / 2 + (world.y - centre.y) / scale,
  };
}

export function screenToWorld(
  camera: Camera,
  canvas: HTMLCanvasElement,
  px: number,
  py: number,
  mapSizeM = 1000,
): { x: number; y: number } {
  const scale = effectiveScale(camera, canvas, mapSizeM);
  const centre = effectiveCentre(camera, mapSizeM);
  return {
    x: centre.x + (px - canvas.width / 2) * scale,
    y: centre.y + (py - canvas.height / 2) * scale,
  };
}

/** Actions that map straight to an intent with no context needed. */
export const SIMPLE_ACTION_INTENTS: Partial<Record<ActionKey, Intent>> = {
  resupply: { t: "resupply" },
  placeRally: { t: "placeRally" },
  placeFob: { t: "placeFob" },
  exitVehicle: { t: "exitVehicle" },
  giveUp: { t: "giveUp" },
};
