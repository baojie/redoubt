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
      "R       reload        (3D)",
      "Tab     3D / map view",
      "click   engage nearest enemy (map)",
      "E       resupply",
      "B       build nearest site",
      "R       place rally      (SL)",
      "F       place FOB radio  (SL)",
      "H       stake habitat    (SL)",
      "C       stake ammo crate (SL)",
      "G / V   enter / exit vehicle",
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
        button.addEventListener("click", () => row.option.onPick());
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
