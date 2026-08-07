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
import { Hud, type DeployOption } from "./hud.js";
import { InputState, SIMPLE_ACTION_INTENTS, type ActionKey } from "./input.js";
import { Connection } from "./net.js";
import { normaliseSteer } from "./prediction.js";
import { render } from "./render.js";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const ctx = canvas.getContext("2d");
if (ctx === null) throw new Error("canvas 2d context unavailable");

const connection = new Connection();
const input = new InputState();
const hud = new Hud();

input.attach(canvas);
hud.drawHelp();

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
  joinButton.disabled = true;
  joinStatus.textContent = "connecting…";
  connection.connect(defaultServerUrl(), joinName.value || "player", () => {
    joinScreen.classList.add("hidden");
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
  const steer = alive && self.vehicle === null ? normaliseSteer(input.steerVector()) : null;

  connection.sendInput(steer, queuedIntents);
  queuedIntents.length = 0;
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

  const waited = world.tick - self.deployingSinceTick;
  const options: DeployOption[] = [];

  for (const rally of world.rallies.values()) {
    options.push({
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
}
window.addEventListener("resize", resize);

function frame(): void {
  requestAnimationFrame(frame);

  const welcome = connection.welcome;
  if (welcome === null || ctx === null) return;
  if (canvas.width === 0) resize();

  const world = connection.world;
  const selfPos = predictedPosition();

  // Follow the soldier, unless the whole-map view is up.
  input.camera.centre = selfPos;

  // Render one snapshot interval in the past: that is the delay that
  // guarantees two samples to interpolate between, and it is why other
  // players glide instead of teleporting between updates.
  const interpolationDelayTicks = rules.TICK_RATE_HZ / welcome.snapshotRateHz;
  const renderTick = world.tick - interpolationDelayTicks;

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
  });

  hud.drawScoreboard(world, welcome.team as TeamId, welcome.lane.name);
  hud.drawStatus(world.self, world);
  hud.drawNetgraph(connection.stats(renderTick), world.tick);
  hud.drawFeed(connection.feed);
  refreshDeployScreen();
}

resize();
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------

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
