/**
 * The client loop.
 *
 * Two clocks, deliberately:
 *
 *  - **Input** runs at the server's tick rate. One input frame is worth
 *    exactly one tick of predicted movement, which is what lets reconciliation
 *    replay frames one-for-one against what the server did.
 *  - **Rendering** runs at the display's refresh rate and draws the world one
 *    snapshot interval in the past, interpolating between the two frames it
 *    holds (PLAN §4).
 *
 * The client decides nothing. It predicts its own movement, and it picks which
 * intents to send. Everything else on screen is the server's word.
 */

import { rules, type TeamId } from "@redoubt/core";
import type { Intent } from "@redoubt/protocol";
import { FirstPersonInput, steerFromCamera } from "./firstPerson.js";
import { Hud, type DeployOption } from "./hud.js";
import { applyZoom, InputState, SIMPLE_ACTION_INTENTS, type ActionKey } from "./input.js";
import { Connection } from "./net.js";
import { normaliseSteer } from "./prediction.js";
import { render } from "./render.js";
import { buildSatelliteRaster } from "./satellite.js";
import { Scene3D } from "./scene3d.js";
import { reloadFraction } from "./viewmodel.js";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const ctx = canvas.getContext("2d");
if (ctx === null) throw new Error("canvas 2d context unavailable");
const scene3dCanvas = document.getElementById("view3d") as HTMLCanvasElement;

const connection = new Connection();
const input = new InputState();
const hud = new Hud();
const firstPerson = new FirstPersonInput(scene3dCanvas);

/**
 * Two views over one connection.
 *
 * First person is where the game is played; the top-down map is where it is
 * understood. Both read the same predicted and interpolated state — the map is
 * not a minimap widget, it is the M2 client still running, which is why
 * switching between them costs nothing and neither can disagree with the other.
 */
let scene: Scene3D | null = null;
let firstPersonView = true;
/** The map view's aerial ground, baked once on join. See satellite.ts. */
let satelliteGround: HTMLCanvasElement | null = null;

input.attach(canvas);
hud.drawHelp();

/**
 * The wheel means different things in the two views, so it is routed here —
 * this is where which view is up is actually known.
 *
 * It used to be handled inside `InputState`, bound to the map canvas. That
 * canvas is `display: none` for as long as the first-person view is up, and a
 * hidden element receives no mouse events at all, so the wheel was simply dead
 * in 3D. Routing it from here means each view gets the control it can use: the
 * optic's zoom ring in first person, the map's scale on the map.
 */
window.addEventListener(
  "wheel",
  (event) => {
    // Ctrl/Cmd+wheel is the browser's own zoom, and not ours to take.
    if (event.ctrlKey || event.metaKey) return;
    if (firstPersonView) firstPerson.adjustOptic(event.deltaY);
    else applyZoom(input.camera, event.deltaY);
    event.preventDefault();
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

const joinScreen = document.getElementById("join") as HTMLElement;
const joinName = document.getElementById("join-name") as HTMLInputElement;
const joinButton = document.getElementById("join-go") as HTMLButtonElement;
const joinStatus = document.getElementById("join-status") as HTMLElement;

/**
 * Default to the page's own host so opening the dev server from another
 * machine on the LAN connects back to that machine, not to the visitor's
 * localhost. Overridable with ?server= for pointing at a remote box.
 */
function defaultServerUrl(): string {
  const override = new URLSearchParams(location.search).get("server");
  if (override !== null && override !== "") return override;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.hostname}:8787`;
}

joinButton.addEventListener("click", () => {
  // Hand focus back to the page. A focused button eats Space and Enter, and
  // is one browser quirk away from eating the movement keys too.
  joinButton.blur();
  joinButton.disabled = true;
  joinStatus.textContent = "connecting…";
  connection.connect(defaultServerUrl(), joinName.value || "player", () => {
    joinScreen.classList.add("hidden");
    const welcome = connection.welcome;
    if (welcome !== null && scene === null) {
      // No WebGL is a reason to fall back to the map, not to break the page.
      // The 2D view is a complete client on its own — it was the whole of M2 —
      // so a machine that cannot do 3D can still play.
      try {
        scene = new Scene3D(
          scene3dCanvas,
          welcome.terrainSeed,
          [welcome.map.mainBases[0], welcome.map.mainBases[1]],
          welcome.map.sizeM,
        );
        scene.buildCover(welcome.map.cover);
        // Loads in the background; bodies drawn before it lands use the
        // primitive figure and swap over as they are recreated.
        void scene.soldiers.load().then((ok) => {
          if (!ok) hud.note("soldier model unavailable — using simple figures");
        });
        // Same deal for the vehicles: they load in the background and hulls
        // created before they land keep the boxes until they are recreated.
        void scene.vehicles.load().then((ok) => {
          if (!ok) hud.note("vehicle models unavailable — using simple hulls");
        });
      } catch (error) {
        scene = null;
        firstPersonView = false;
        hud.note(`3D unavailable (${describeError(error)}) — using the map view`);
      }
      resize();
    }
    if (welcome !== null && satelliteGround === null) {
      // A couple of hundred milliseconds of per-pixel terrain work, spent once,
      // here. A hitch while the join screen is coming down is invisible; the
      // same hitch on the first frame of the map view, mid-firefight, is not.
      try {
        satelliteGround = buildSatelliteRaster(welcome.map, welcome.terrainSeed);
      } catch (error) {
        // The map is perfectly usable on bare ground — it was, for all of M2.
        hud.note(`map imagery unavailable (${describeError(error)})`);
      }
    }
    setView(firstPersonView);
  });
  window.setTimeout(() => {
    if (connection.welcome === null) {
      joinStatus.textContent = `no server at ${defaultServerUrl()} — is it running?`;
      joinButton.disabled = false;
    }
  }, 3000);
});

joinName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinButton.click();
});

// ?join=callsign skips the splash. Handy for reconnecting after a code change
// without retyping, and for driving the page from a headless browser.
const autoJoin = new URLSearchParams(location.search).get("join");
if (autoJoin !== null) {
  joinName.value = autoJoin === "" ? "player" : autoJoin;
  joinButton.click();
}

// ---------------------------------------------------------------------------
// Input loop — one frame per server tick
// ---------------------------------------------------------------------------

const queuedIntents: Intent[] = [];

function actionToIntent(action: ActionKey): Intent | null {
  const simple = SIMPLE_ACTION_INTENTS[action];
  if (simple !== undefined) return simple;

  const world = connection.world;
  const self = world.self;
  if (self === null) return null;

  switch (action) {
    case "build": {
      // Nearest unbuilt friendly site within reach. Digging is the one action
      // where "the thing in front of me" is unambiguous.
      const site = nearest(
        [...world.deployables.values()].filter(
          (d) => !d.built && d.team === self.team,
        ),
        predictedPosition(),
      );
      return site === null ? null : { t: "build", deployable: site.id };
    }
    case "placeHabitat":
    case "placeAmmoCrate": {
      const fob = nearest(
        [...world.fobs.values()].filter((f) => f.team === self.team),
        predictedPosition(),
      );
      if (fob === null) return null;
      const pos = predictedPosition();
      return {
        t: "placeDeployable",
        fob: fob.id,
        kind: action === "placeHabitat" ? "habitat" : "ammoCrate",
        pos,
      };
    }
    case "reviveNearby": {
      const casualty = casualtyInReach();
      return casualty === null ? null : { t: "revive", target: casualty.id };
    }
    case "dragNearby": {
      // One key for both: if you are carrying somebody, it puts them down.
      if (self.dragging !== null) return { t: "drag", target: null };
      const casualty = casualtyInReach();
      return casualty === null ? null : { t: "drag", target: casualty.id };
    }
    case "loadSupply": {
      // Fill to capacity; core clamps and moves it at the transfer rate, so
      // "load" is a single keypress that starts a job, not a slider.
      const spec = rules.VEHICLE_SPECS.logistics;
      return {
        t: "loadSupply",
        constructionPoints: spec.maxCargoConstructionPoints,
        ammoPoints: spec.maxCargoAmmoPoints,
      };
    }
    case "unloadSupply": {
      const fob = nearest(
        [...world.fobs.values()].filter((f) => f.team === self.team),
        predictedPosition(),
      );
      if (fob === null) return null;
      return {
        t: "unloadSupply",
        fob: fob.id,
        constructionPoints: rules.FOB_MAX_CONSTRUCTION_POINTS,
        ammoPoints: rules.FOB_MAX_AMMO_POINTS,
      };
    }
    case "enterVehicle": {
      const vehicle = nearest(
        [...world.vehicles.values()].filter((v) => v.team === self.team),
        predictedPosition(),
      );
      return vehicle === null ? null : { t: "enterVehicle", vehicle: vehicle.id };
    }
    default:
      return null;
  }
}

function handleActions(): void {
  for (const action of input.drainActions()) {
    if (action === "toggleView") {
      setView(!firstPersonView);
      continue;
    }
    if (action === "toggleOverview") {
      input.camera.overview = !input.camera.overview;
      continue;
    }
    if (action === "toggleHelp") {
      hud.toggleHelp();
      continue;
    }
    if (action === "deploy") continue; // handled by the deploy screen's buttons
    const intent = actionToIntent(action);
    if (intent !== null) queuedIntents.push(intent);
  }

  // A click engages the enemy nearest to where you clicked, rather than
  // demanding pixel-accurate selection of a 4px dot.
  const click = input.drainClick();
  if (click !== null) {
    const self = connection.world.self;
    if (self !== null) {
      const target = nearest(
        [...connection.world.players.values()].filter(
          (p) => p.team !== self.team && p.status === "alive",
        ),
        click,
      );
      if (target !== null) queuedIntents.push({ t: "engage", target: target.id });
    }
  }
}

function inputTick(): void {
  if (connection.welcome === null) return;
  handleActions();

  const self = connection.world.self;
  const alive = self !== null && self.status === "alive";
  const onFoot = alive && self.vehicle === null;

  // WASD means compass directions on the map and camera-relative directions in
  // first person. Both produce the same `steer` intent; the rules engine has
  // no idea which view the player is using.
  const raw = input.steerVector();
  const steer = !onFoot
    ? null
    : firstPersonView
      ? steerFromCamera(raw, firstPerson.yaw)
      : normaliseSteer(raw);

  // At the wheel: WASD is throttle and steering, not footsteps.
  const mounted = alive && self.vehicle !== null;
  if (firstPersonView && mounted) {
    const raw2 = input.steerVector();
    queuedIntents.push({ t: "drive", throttle: -raw2.y, steering: raw2.x });
    queuedIntents.push({ t: "look", yaw: firstPerson.yaw, pitch: firstPerson.viewPitch });
  }

  if (firstPersonView && onFoot) {
    // The kick is part of where the rifle is pointing, so it goes to the
    // server too — otherwise the round would leave along the aim the player
    // has, not the one the recoil gave them, and fighting the climb would be
    // a purely cosmetic exercise.
    queuedIntents.push({
      t: "look",
      yaw: firstPerson.yaw,
      pitch: firstPerson.viewPitch,
    });
    if (firstPerson.aiming !== lastSentAiming) {
      lastSentAiming = firstPerson.aiming;
      queuedIntents.push({ t: "aim", aiming: firstPerson.aiming });
    }
    if (firstPerson.triggerHeld) {
      // The server enforces rate of fire and rejects nothing else here, so
      // holding the trigger simply fires as fast as the weapon allows.
      queuedIntents.push({ t: "fire", renderTick: lastRenderTick });
    }
    if (firstPerson.takeReload()) queuedIntents.push({ t: "reload" });
  }

  connection.sendInput(steer, queuedIntents);
  queuedIntents.length = 0;
}

function setView(toFirstPerson: boolean): void {
  firstPersonView = toFirstPerson && scene !== null;
  scene3dCanvas.style.display = firstPersonView ? "block" : "none";
  canvas.style.display = firstPersonView ? "none" : "block";
  if (!firstPersonView) firstPerson.release();
  hud.setCrosshair(firstPersonView);
  resize();
}

window.setInterval(inputTick, 1000 / rules.TICK_RATE_HZ);

// ---------------------------------------------------------------------------
// Deploy screen
// ---------------------------------------------------------------------------

function refreshDeployScreen(): void {
  const world = connection.world;
  const self = world.self;
  if (self === null || self.status !== "deploying") {
    hud.hideDeploy();
    return;
  }

  // Let go of the mouse. Pointer lock hides the cursor and routes every click
  // to the canvas, so a deploy screen shown while still locked is a menu you
  // can see and cannot use.
  firstPerson.release();

  const waited = world.tick - self.deployingSinceTick;
  const options: DeployOption[] = [];

  for (const rally of world.rallies.values()) {
    options.push({
      key: `rally:${rally.id}`,
      label: "Rally point",
      detail: rally.live ? "your squad, on the objective" : "blocked or on cooldown",
      readyInTicks: Math.max(0, rules.RALLY_SPAWN_DELAY_TICKS - waited),
      enabled: rally.live,
      onPick: () => connection.sendAction({ t: "spawn", source: { kind: "rally", rally: rally.id } }),
    });
  }

  for (const deployable of world.deployables.values()) {
    if (deployable.kind !== "habitat" || deployable.team !== self.team) continue;
    if (!deployable.built) continue;
    options.push({
      key: `habitat:${deployable.id}`,
      label: "Habitat",
      detail: deployable.overrun ? "OVERRUN — enemies on it" : "forward base",
      readyInTicks: Math.max(0, rules.HABITAT_SPAWN_DELAY_TICKS - waited),
      enabled: !deployable.overrun,
      onPick: () =>
        connection.sendAction({
          t: "spawn",
          source: { kind: "habitat", deployable: deployable.id },
        }),
    });
  }

  options.push({
    key: "main",
    label: "Main base",
    detail: "safe, and a very long walk",
    readyInTicks: Math.max(0, rules.MAIN_BASE_SPAWN_DELAY_TICKS - waited),
    enabled: true,
    onPick: () => connection.sendAction({ t: "spawn", source: { kind: "main" } }),
  });

  hud.showDeploy(options, world);
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function predictedPosition(): { x: number; y: number } {
  const self = connection.world.self;
  if (self === null) return { x: 0, y: 0 };
  // While alive and on foot the prediction is ahead of the server and is what
  // the player is actually looking at; otherwise the server's word is all
  // there is.
  return self.status === "alive" && self.vehicle === null
    ? connection.predictor.position
    : { x: self.x, y: self.y };
}

function resize(): void {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(canvas.clientWidth * ratio);
  canvas.height = Math.floor(canvas.clientHeight * ratio);
  scene?.resize(scene3dCanvas.clientWidth, scene3dCanvas.clientHeight);
}
window.addEventListener("resize", resize);

let lastRenderTick = 0;
let lastFrameMs = 0;
/** Only send the aim toggle on change — it is a held state, not a stream. */
let lastSentAiming = false;
/** Last authoritative position, for working out how fast we are actually going. */
let lastReportedPos: { x: number; y: number } | null = null;
/** Previous rendered position, for the weapon's walking sway. */
let lastViewPos: { x: number; y: number } | null = null;
let observedSpeedMps = 0;

function frame(): void {
  requestAnimationFrame(frame);

  const welcome = connection.welcome;
  if (welcome === null || ctx === null) return;
  if (canvas.width === 0) resize();

  const now = performance.now();
  const dt = lastFrameMs === 0 ? 0 : Math.min(0.1, (now - lastFrameMs) / 1000);
  lastFrameMs = now;

  const world = connection.world;
  const selfPos = predictedPosition();

  // Speed measured from the server's own positions, not from what we asked
  // for — the question this answers is "did the world move me", and only the
  // server can say.
  if (world.self !== null && dt > 0) {
    if (lastReportedPos !== null) {
      const moved = Math.hypot(world.self.x - lastReportedPos.x, world.self.y - lastReportedPos.y);
      observedSpeedMps = observedSpeedMps * 0.7 + (moved / dt) * 0.3;
    }
    lastReportedPos = { x: world.self.x, y: world.self.y };
  }

  // Follow the soldier, unless the whole-map view is up.
  input.camera.centre = selfPos;

  // Render one snapshot interval in the past: that is the delay that
  // guarantees two samples to interpolate between, and it is why other
  // players glide instead of teleporting between updates.
  const interpolationDelayTicks = rules.TICK_RATE_HZ / welcome.snapshotRateHz;
  const renderTick = world.tick - interpolationDelayTicks;
  lastRenderTick = renderTick;

  if (firstPersonView && scene !== null) {
    firstPerson.settle(dt);
    hud.drawSupply(world, predictedPosition());
    scene.setAiming(world.self?.aiming ?? false, dt, firstPerson.magnification);
    // Sit up in the cab when mounted; a driver's eyeline is not a rifleman's.
    const vehicle = world.self?.vehicle == null ? null : world.vehicles.get(world.self.vehicle);
    const eyeHeight =
      vehicle === undefined || vehicle === null
        ? rules.EYE_HEIGHT_M
        : rules.VEHICLE_SPECS[vehicle.kind].heightM * 0.8;
    scene.placeCamera(selfPos, firstPerson.yaw, firstPerson.viewPitch, eyeHeight);

    // The weapon in our own hands. Hidden when there is nobody holding it —
    // downed, waiting to deploy, or riding in a cab with the rifle stowed.
    const self = world.self;
    scene.viewmodel.setVisible(self !== null && self.status === "alive" && vehicle === null);
    const swayM =
      lastViewPos === null ? 0 : Math.hypot(selfPos.x - lastViewPos.x, selfPos.y - lastViewPos.y);
    lastViewPos = { x: selfPos.x, y: selfPos.y };
    scene.viewmodel.update(
      dt,
      self?.aiming ?? false,
      swayM,
      self === null ? 0 : reloadFraction(self.reloadingUntilTick, world.tick),
    );
    scene.syncPlayers(world, renderTick, welcome.playerId, welcome.team as TeamId, dt);
    scene.syncStructures(world, welcome.team as TeamId, world.self?.vehicle ?? null);
    scene.syncGrenades(world);
    for (const blast of connection.takeBlasts()) scene.addBlast(blast.at);
    for (const shot of connection.takeShots()) {
      // Our own rounds kick the view. Driven by the server's confirmation of
      // the shot rather than by the click, so the kick matches the rounds that
      // actually left the barrel.
      if (shot.shooter === welcome.playerId) {
        firstPerson.noteShot();
        scene.viewmodel.noteShot();
        // From the muzzle, not from `shot.from` — that is our own eye, and a
        // streak starting there begins inside the camera.
        scene.addOwnTracer(shot.to, shot.flightSeconds);
        continue;
      }
      scene.addTracer(shot.from, shot.to, shot.flightSeconds, shot.team === welcome.team);
      // Somebody else fired: mark where from. This is how a player finds out
      // they are being shot at, and from which direction.
      scene.addMuzzleFlash(shot.from);
    }
    scene.render(dt);
    hud.drawWeapon(world.self, world.tick, firstPerson.magnification);
    hud.drawScoreboard(world, welcome.team as TeamId, welcome.lane.name);
    hud.drawStatus(world.self, world);
    hud.drawNetgraph(connection.stats(renderTick), world.tick);
    hud.drawMovement(input.heldMovementKeys(), observedSpeedMps, selfPos);
    hud.drawFeed(connection.feed);
    hud.setSuppression(world.self?.suppression ?? 0);
    refreshCasualtyPrompt();
    refreshDeployScreen();
    return;
  }

  render({
    canvas,
    ctx,
    camera: input.camera,
    map: welcome.map,
    world,
    team: welcome.team as TeamId,
    squad: welcome.squad,
    selfPos,
    renderTick,
    pointer: input.pointerWorld,
    ground: satelliteGround,
  });

  hud.drawScoreboard(world, welcome.team as TeamId, welcome.lane.name);
  hud.drawStatus(world.self, world);
  hud.drawWeapon(world.self, world.tick);
  hud.drawNetgraph(connection.stats(renderTick), world.tick);
  hud.drawMovement(input.heldMovementKeys(), observedSpeedMps, selfPos);
  hud.drawFeed(connection.feed);
  hud.setSuppression(0);
  hud.drawSupply(world, predictedPosition());
  refreshCasualtyPrompt();
  refreshDeployScreen();
}

/**
 * A handle for poking at a live session from the devtools console.
 *
 * Deliberately kept: "I cannot see anyone" is not answerable from a
 * screenshot, and the difference between "the server never sent them", "the
 * client dropped them" and "they are being drawn somewhere wrong" is three
 * lines of console away with this and unguessable without it.
 */
declare global {
  interface Window {
    redoubt?: {
      connection: Connection;
      scene: Scene3D | null;
      aim: (yaw: number, pitch?: number) => void;
      report: () => Record<string, unknown>;
    };
  }
}

window.redoubt = {
  connection,
  get scene() {
    return scene;
  },
  /**
   * Point the camera from the console.
   *
   * Needed because the input loop sends a steer intent every single tick,
   * including a zero one — so anything injected out of band is overwritten
   * within 50 ms. Movement is camera-relative, so aiming is the only way to
   * drive the player from a script.
   */
  aim: (yaw: number, pitch = 0) => {
    firstPerson.adopt(yaw, pitch);
  },
  report: () => {
    const world = connection.world;
    const self = world.self;
    return {
      tick: world.tick,
      selfId: connection.welcome?.playerId,
      selfStatus: self?.status,
      selfPos: self === null ? null : { x: self.x, y: self.y },
      playersKnown: world.players.size,
      playersAlive: [...world.players.values()].filter((p) => p.status !== "deploying").length,
      bodiesDrawn: scene?.bodyCount ?? 0,
      nearest: [...world.players.values()]
        .filter((p) => p.id !== connection.welcome?.playerId && self !== null)
        .map((p) => ({
          id: p.id,
          team: p.team,
          status: p.status,
          dist: Math.round(Math.hypot(p.x - (self?.x ?? 0), p.y - (self?.y ?? 0))),
        }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 5),
      camera: scene === null ? null : {
        pos: scene.camera.position.toArray().map((n) => Math.round(n * 10) / 10),
        yaw: Math.round(scene.camera.rotation.y * 100) / 100,
      },
      bodies: scene === null ? [] : scene.debugBodies().slice(0, 4),
    };
  },
};

resize();
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------

/**
 * The friendly casualty you are standing over, if any.
 *
 * Reach is taken from the rules rather than guessed, so the prompt appears
 * exactly when the command would actually be accepted — a prompt that lies
 * about what is possible is worse than none.
 */
function casualtyInReach(): { id: number; x: number; y: number } | null {
  const world = connection.world;
  const self = world.self;
  if (self === null) return null;
  const me = predictedPosition();

  let best: { id: number; x: number; y: number } | null = null;
  let bestDistance = Math.max(rules.REVIVE_REACH_M, rules.DRAG_REACH_M);
  for (const player of world.players.values()) {
    if (player.team !== self.team || player.status !== "downed") continue;
    const d = Math.hypot(player.x - me.x, player.y - me.y);
    if (d > bestDistance) continue;
    bestDistance = d;
    best = { id: player.id, x: player.x, y: player.y };
  }
  return best;
}

function refreshCasualtyPrompt(): void {
  const self = connection.world.self;
  if (self === null || self.status !== "alive") {
    hud.setCasualtyPrompt(null);
    return;
  }
  if (self.dragging !== null) {
    hud.setCasualtyPrompt("Q  put down");
    return;
  }
  const casualty = casualtyInReach();
  hud.setCasualtyPrompt(casualty === null ? null : "F  revive     Q  drag");
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function nearest<T extends { x: number; y: number }>(
  items: readonly T[],
  to: { x: number; y: number },
): T | null {
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const d = Math.hypot(item.x - to.x, item.y - to.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = item;
    }
  }
  return best;
}
