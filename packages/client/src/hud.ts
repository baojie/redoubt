/**
 * The overlays: scoreboard, soldier status, network diagnostics, event feed,
 * and the deploy screen.
 *
 * The diagnostics panel is not a debug afterthought — PLAN §5 lists it as an
 * M2 deliverable. Ping, bandwidth, tick drift and prediction error are the
 * four numbers that distinguish "the netcode is wrong" from "the game feels
 * bad", and without them every latency complaint is guesswork.
 */

import { rules, type GameEvent, type TeamId } from "@redoubt/core";
import type { SelfView } from "@redoubt/protocol";
import type { NetStats } from "./net.js";
import type { ClientWorld } from "./world.js";

export interface DeployOption {
  /** Stable identity, so the button is not rebuilt while it is being clicked. */
  key: string;
  label: string;
  detail: string;
  readyInTicks: number;
  enabled: boolean;
  onPick: () => void;
}

export class Hud {
  private readonly scoreboard = must("scoreboard");
  private readonly status = must("status");
  private readonly netgraph = must("netgraph");
  private readonly feed = must("feed");
  private readonly help = must("help");
  private readonly deploy = must("deploy");
  private readonly deploySub = must("deploy-sub");
  private readonly deployOptions = must("deploy-options");
  private readonly weapon = must("weapon");
  private readonly crosshair = must("crosshair");
  private readonly suppression = must("suppression");

  private helpShown = true;

  toggleHelp(): void {
    this.helpShown = !this.helpShown;
    this.help.style.display = this.helpShown ? "" : "none";
  }

  /** A one-off line in the feed, for things the player needs told once. */
  note(text: string): void {
    this.notes.push(text);
    while (this.notes.length > 3) this.notes.shift();
  }

  private readonly notes: string[] = [];

  setCrosshair(shown: boolean): void {
    this.crosshair.classList.toggle("shown", shown);
  }

  /**
   * Being shot at narrows the world. PLAN §5 puts this above weapon models in
   * importance, and it is driven by the authoritative suppression value rather
   * than by anything the client decides for itself.
   */
  setSuppression(value: number): void {
    this.suppression.style.opacity = String(Math.max(0, Math.min(1, value)));
  }

  /**
   * What the soldier in front of you needs.
   *
   * The downed system is the team glue PLAN §5 describes, and glue that
   * nobody can see is not glue: without a prompt, a casualty lying in the
   * grass is a shape you walk past.
   */
  setCasualtyPrompt(text: string | null): void {
    this.prompt.textContent = text ?? "";
    this.prompt.style.display = text === null ? "none" : "block";
  }

  private readonly prompt = must("prompt");

  /**
   * The logistics panel: what is in the truck, and what the nearest FOB still
   * has room for.
   *
   * PLAN §2.5 calls the supply run the heartbeat of the game, and until now it
   * was bot-only — a human in a truck had no way to see a load, let alone move
   * one. Showing the deficit rather than just the cargo is the point: the
   * decision is "does this FOB need what I am carrying", not "am I full".
   */
  drawSupply(world: ClientWorld, at: { x: number; y: number }): void {
    const self = world.self;
    if (self === null || self.vehicle === null) {
      this.supply.style.display = "none";
      return;
    }
    const truck = world.vehicles.get(self.vehicle);
    if (truck === undefined || truck.kind !== "logistics") {
      this.supply.style.display = "none";
      return;
    }

    let nearestFob: { id: number; cp: number; ap: number; range: number } | null = null;
    for (const fob of world.fobs.values()) {
      if (fob.team !== self.team) continue;
      const range = Math.hypot(fob.x - at.x, fob.y - at.y);
      if (nearestFob !== null && range >= nearestFob.range) continue;
      nearestFob = {
        id: fob.id,
        cp: rules.FOB_MAX_CONSTRUCTION_POINTS - fob.constructionPoints,
        ap: rules.FOB_MAX_AMMO_POINTS - fob.ammoPoints,
        range,
      };
    }

    const lines = [
      `CARGO   ${Math.round(truck.cargoConstructionPoints)} CP  ` +
        `${Math.round(truck.cargoAmmoPoints)} AP`,
    ];
    if (nearestFob === null) {
      lines.push("no friendly FOB — Z to load at main");
    } else if (nearestFob.range <= rules.SUPPLY_UNLOAD_REACH_M) {
      lines.push(`FOB needs ${nearestFob.cp} CP  ${nearestFob.ap} AP`);
      lines.push("C  unload here");
    } else {
      lines.push(`nearest FOB ${Math.round(nearestFob.range)} m`);
      lines.push("Z  load at main");
    }
    this.supply.textContent = lines.join("\n");
    this.supply.style.display = "block";
  }

  private readonly supply = must("supply");

  drawWeapon(self: SelfView | null, tick: number): void {
    if (self === null || self.status !== "alive") {
      this.weapon.textContent = "";
      return;
    }
    const reloading = self.reloadingUntilTick > tick;
    if (reloading) {
      const left = rules.ticksToSeconds(self.reloadingUntilTick - tick);
      this.weapon.innerHTML = `<span class="warn">RELOADING ${left.toFixed(1)}s</span>`;
      return;
    }
    const dry = self.magazine === 0;
    this.weapon.innerHTML =
      `<span class="${dry ? "warn" : ""}">${self.magazine}</span>` +
      ` / ${self.ammo}` +
      (dry ? "   <span class=\"warn\">R to reload</span>" : "");
  }

  drawHelp(): void {
    this.help.textContent = [
      "WASD    move",
      "mouse   look          (3D)",
      "click   fire          (3D)",
      "right   aim down sights (3D)",
      "R       reload        (3D)",
      "F       revive a casualty",
      "Q       pick up / drop a casualty",
      "Tab     3D / map view",
      "click   engage nearest enemy (map)",
      "E       resupply",
      "B       build nearest site",
      "R       place rally      (SL)",
      "T       place FOB radio  (SL)",
      "H       stake habitat    (SL)",
      "Y       stake ammo crate (SL)",
      "G / V   enter / exit vehicle",
      "WASD    drive, when mounted",
      "Z / C   load / unload supply",
      "X       give up when downed",
      "M       whole-map view",
      "wheel   zoom",
      "/       hide this",
    ].join("\n");
  }

  drawScoreboard(world: ClientWorld, team: TeamId, laneName: string): void {
    const blue = world.teams.get(0)?.tickets ?? 0;
    const red = world.teams.get(1)?.tickets ?? 0;
    const you = team === 0 ? "BLUE" : "RED";

    const flags = [...world.controlPoints.values()];
    const owned = (t: TeamId): number => flags.filter((f) => f.owner === t).length;

    const banner =
      world.phase === "staging"
        ? "STAGING"
        : world.phase === "finished"
          ? "MATCH OVER"
          : world.doubleNeutral
            ? "DOUBLE NEUTRAL — bleed paused"
            : `lane ${laneName}`;

    this.scoreboard.innerHTML =
      `<span class="blue">BLUE ${blue}</span>   ` +
      `${owned(0)} : ${owned(1)}   ` +
      `<span class="red">${red} RED</span>\n` +
      `<span style="color:var(--dim)">${banner} · you are ${you}</span>`;
  }

  drawStatus(self: SelfView | null, world: ClientWorld): void {
    if (self === null) {
      this.status.textContent = "connecting…";
      return;
    }
    if (self.status === "downed") {
      const seconds = Math.max(
        0,
        Math.ceil(rules.ticksToSeconds(self.bleedoutAtTick - world.tick)),
      );
      this.status.innerHTML =
        `<span class="warn">DOWN — bleeding out in ${seconds}s</span>\n` +
        `press X to give up (costs 1 ticket)`;
      return;
    }

    const bar = (value: number, max: number, width = 12): string => {
      const filled = Math.round((Math.max(0, value) / max) * width);
      return "█".repeat(filled) + "·".repeat(Math.max(0, width - filled));
    };

    this.status.textContent = [
      `${self.role.toUpperCase()}   squad ${self.squad}`,
      `health  ${bar(self.health, rules.PLAYER_MAX_HEALTH)} ${Math.round(self.health)}`,
      `ammo    ${bar(self.ammo, rules.PLAYER_MAX_AMMO)} ${Math.round(self.ammo)}`,
      self.vehicle !== null ? "mounted — V to dismount" : "",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  /**
   * Movement telemetry.
   *
   * "WASD does nothing" is not answerable by looking at the world: at walking
   * pace, with every landmark two hundred metres away, real movement and no
   * movement look identical. Showing the keys the client thinks are held, and
   * the speed the server says you have, separates "the input never arrived"
   * from "you are moving and cannot tell".
   */
  drawMovement(heldKeys: readonly string[], speedMps: number, at: { x: number; y: number }): void {
    const keys = heldKeys.length === 0 ? "—" : heldKeys.join(" ");
    const stalled = heldKeys.length > 0 && speedMps < 0.1;
    this.movement.innerHTML =
      `keys     ${keys}\n` +
      `<span class="${stalled ? "warn" : ""}">speed    ${speedMps.toFixed(1)} m/s</span>\n` +
      `pos      ${Math.round(at.x)}, ${Math.round(at.y)}`;
  }

  private readonly movement = must("movement");

  drawNetgraph(stats: NetStats, serverTick: number): void {
    // Prediction error above a metre or so means the client and server
    // disagree about movement, which is a bug rather than a network condition.
    const errorClass = stats.predictionErrorM > 1 ? "warn" : "";
    this.netgraph.innerHTML = [
      `${stats.connected ? "connected" : "OFFLINE"}`,
      `ping     ${stats.pingMs.toFixed(0)} ms`,
      `down     ${stats.kbPerSecond.toFixed(1)} KB/s`,
      `tick     ${serverTick}`,
      `drift    ${stats.tickDrift} ticks`,
      `<span class="${errorClass}">pred err ${stats.predictionErrorM.toFixed(2)} m</span>`,
      `pending  ${stats.pendingInputs}`,
    ].join("\n");
  }

  drawFeed(entries: ReadonlyArray<{ tick: number; event: GameEvent }>): void {
    const lines = [...this.notes, ...entries.map((e) => describe(e.event))];
    this.feed.textContent = lines.join("\n");
  }

  /**
   * The deploy screen, refreshed every frame but rebuilt only when the set of
   * spawns actually changes.
   *
   * Rebuilding the buttons each frame looked harmless and made them
   * unclickable: a click is a mousedown and a mouseup on the *same* element,
   * and at 60 fps the element was replaced in between. The countdowns still
   * update every frame — only the DOM identity is preserved.
   */
  showDeploy(options: DeployOption[], world: ClientWorld): void {
    this.deploy.classList.add("shown");
    this.deploySub.textContent =
      world.phase === "finished" ? "match over — next round shortly" : "choose a spawn";

    const signature = options.map((o) => o.key).join("|");
    if (signature !== this.deploySignature) {
      this.deploySignature = signature;
      this.deployButtons = [];
      this.deployOptions.replaceChildren();
      for (const option of options) {
        const button = document.createElement("button");
        // Held in a closure that is replaced along with the button, so a
        // stale option can never be what actually fires.
        const row = { button, option };
        button.addEventListener("click", () => {
          button.blur();
          row.option.onPick();
        });
        this.deployButtons.push(row);
        this.deployOptions.append(button);
      }
    }

    for (let i = 0; i < this.deployButtons.length; i++) {
      const row = this.deployButtons[i];
      const option = options[i];
      if (row === undefined || option === undefined) continue;
      row.option = option;
      const seconds = Math.ceil(rules.ticksToSeconds(option.readyInTicks));
      row.button.textContent =
        seconds > 0
          ? `${option.label} — ${seconds}s\n${option.detail}`
          : `${option.label}\n${option.detail}`;
      row.button.disabled = !option.enabled || option.readyInTicks > 0;
    }
  }

  private deploySignature = "";
  private deployButtons: Array<{ button: HTMLButtonElement; option: DeployOption }> = [];

  hideDeploy(): void {
    this.deploy.classList.remove("shown");
    this.deploySignature = "";
    this.deployButtons = [];
  }

  get deployShown(): boolean {
    return this.deploy.classList.contains("shown");
  }
}

function must(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing #${id} in the page`);
  return element;
}

/** One line of plain English per event. */
function describe(event: GameEvent): string {
  const side = (team: TeamId): string => (team === 0 ? "BLUE" : "RED");
  switch (event.t) {
    case "matchStarted":
      return `match started — lane ${event.lane}`;
    case "matchEnded":
      return `match over — ${event.winner === null ? "draw" : side(event.winner)} (${event.reason})`;
    case "controlPointCaptured":
      return `${side(event.by)} captured a point${event.firstEver ? " (+20)" : ""}`;
    case "controlPointNeutralised":
      return `${side(event.by)} neutralised a point`;
    case "doubleNeutralStarted":
      return "double neutral — bleed paused";
    case "doubleNeutralEnded":
      return "double neutral resolved";
    case "mercyBleedStarted":
      return `${side(event.bleeding)} is bleeding out fast`;
    case "fobPlaced":
      return `${side(event.team)} placed a FOB`;
    case "fobDestroyed":
      return event.selfDismantled
        ? `${side(event.team)} pulled a FOB radio`
        : `${side(event.team)} lost a FOB radio (-20)`;
    case "deployableBuilt":
      return `${side(event.team)} built ${event.kind}`;
    case "deployableDestroyed":
      return `${side(event.team)} lost ${event.kind}`;
    case "rallyPlaced":
      return `${side(event.team)} rally up`;
    case "rallyDestroyed":
      return event.byEnemy ? `${side(event.team)} rally overrun` : `${side(event.team)} rally moved`;
    case "playerDowned":
      return `${side(event.team)} soldier down`;
    case "playerRevived":
      return `${side(event.team)} soldier revived`;
    case "playerDied":
      return `${side(event.team)} casualty (-1)`;
    case "supplyUnloaded":
      return `${side(event.team)} delivered ${Math.round(event.constructionPoints)} CP`;
    default:
      return "";
  }
}
