/**
 * Drawing.
 *
 * The view is Squad's map screen, not a shooter's viewport: a top-down plan
 * with symbols rather than sprites. That is a deliberate choice for M2, whose
 * job per PLAN §5 is to prove the *rules* are fun before any art exists. If
 * this reads as a tactical map rather than a game, it is doing its job.
 *
 * Nothing here mutates state or talks to the network. It is handed a world and
 * a camera and paints one frame.
 */

import { rules, type TeamId } from "@redoubt/core";
import type { MapDefinition } from "@redoubt/core";
import { effectiveScale, worldToScreen, type Camera } from "./input.js";
import type { ClientWorld } from "./world.js";

const COLOURS = {
  ground: "#12161b",
  grid: "#1c232b",
  gridOverImagery: "rgba(226, 236, 245, 0.13)",
  mapEdge: "#2b3540",
  friendly: "#4da3ff",
  friendlySquad: "#8fd0ff",
  enemy: "#ff6b57",
  neutral: "#8b949e",
  self: "#ffffff",
  downed: "#c9a227",
  captureRing: "#3d4855",
  text: "#c9d4e0",
  dim: "#6b7785",
  warn: "#ffb454",
} as const;

const TEAM_COLOUR: Record<TeamId, string> = {
  0: COLOURS.friendly,
  1: COLOURS.enemy,
};

export interface RenderContext {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  camera: Camera;
  map: MapDefinition;
  world: ClientWorld;
  /** Our own team, for deciding friend from foe. */
  team: TeamId;
  squad: number;
  /** Our predicted position — drawn instead of the server's stale one. */
  selfPos: { x: number; y: number };
  /** Interpolation target, in server ticks. */
  renderTick: number;
  pointer: { x: number; y: number };
  /**
   * The baked aerial view of the ground — see satellite.ts. Optional because
   * it takes a moment to bake and because a canvas without a 2D context cannot
   * produce one; either way the map still draws, just on bare dark ground.
   */
  ground?: HTMLCanvasElement | null;
}

export function render(rc: RenderContext): void {
  const { ctx, canvas } = rc;
  // Off-map surround. Anything outside the playable square is nothing at all,
  // and saying so is more use than tiling scenery no one may walk on.
  ctx.fillStyle = COLOURS.ground;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawGround(rc);
  drawGrid(rc);
  drawMainBases(rc);
  drawControlPoints(rc);
  drawFobs(rc);
  drawDeployables(rc);
  drawRallies(rc);
  drawVehicles(rc);
  drawPlayers(rc);
  drawSelf(rc);
}

function px(rc: RenderContext, world: { x: number; y: number }): { x: number; y: number } {
  return worldToScreen(rc.camera, rc.canvas, rc.map.sizeM, world);
}

/** Convert a distance in metres to pixels at the current zoom. */
function metres(rc: RenderContext, m: number): number {
  return m / effectiveScale(rc.camera, rc.canvas, rc.map.sizeM);
}

/**
 * The aerial photograph of the ground, blitted under everything else.
 *
 * One `drawImage` per frame: the whole map is baked once into an offscreen
 * canvas, so the per-pixel terrain work never touches the frame budget however
 * far the camera is zoomed in.
 */
function drawGround(rc: RenderContext): void {
  if (rc.ground == null) return;
  const topLeft = px(rc, { x: 0, y: 0 });
  const size = metres(rc, rc.map.sizeM);
  // Smoothing off once a raster pixel covers more than a screen pixel: past
  // that the browser's blur is inventing detail the terrain does not have.
  rc.ctx.imageSmoothingEnabled = size < rc.ground.width;
  rc.ctx.drawImage(rc.ground, topLeft.x, topLeft.y, size, size);
}

function drawGrid(rc: RenderContext): void {
  const { ctx } = rc;
  const step = 100; // metres — matches the capture radius, a useful yardstick
  // Over imagery the grid has to be an overlay rather than ink: opaque lines
  // read as fences drawn on the ground instead of as a coordinate reference.
  ctx.strokeStyle = rc.ground == null ? COLOURS.grid : COLOURS.gridOverImagery;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let m = 0; m <= rc.map.sizeM; m += step) {
    const a = px(rc, { x: m, y: 0 });
    const b = px(rc, { x: m, y: rc.map.sizeM });
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    const c = px(rc, { x: 0, y: m });
    const d = px(rc, { x: rc.map.sizeM, y: m });
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
  }
  ctx.stroke();

  const topLeft = px(rc, { x: 0, y: 0 });
  const size = metres(rc, rc.map.sizeM);
  ctx.strokeStyle = COLOURS.mapEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(topLeft.x, topLeft.y, size, size);
}

function drawMainBases(rc: RenderContext): void {
  const { ctx } = rc;
  for (const teamId of [0, 1] as const) {
    const base = rc.map.mainBases[teamId];
    const centre = px(rc, base);
    const radius = metres(rc, rules.MAIN_BASE_RADIUS_M);
    ctx.strokeStyle = TEAM_COLOUR[teamId];
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    label(ctx, centre.x, centre.y - radius - 6, "MAIN", COLOURS.dim);
  }
}

function drawControlPoints(rc: RenderContext): void {
  const { ctx } = rc;
  for (const point of rc.world.controlPoints.values()) {
    const def = rc.map.controlPoints.find((c) => c.id === point.id);
    if (def === undefined) continue;
    const centre = px(rc, def.pos);
    const radius = metres(rc, rules.CAPTURE_RADIUS_M);

    ctx.strokeStyle = point.owner === null ? COLOURS.neutral : TEAM_COLOUR[point.owner];
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Contest progress as an arc, so a flag being taken reads at a glance.
    if (point.contestingTeam !== null && point.progress > 0) {
      ctx.strokeStyle = TEAM_COLOUR[point.contestingTeam];
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(
        centre.x,
        centre.y,
        radius,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * Math.min(1, point.progress),
      );
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    label(ctx, centre.x, centre.y - radius - 8, def.name.toUpperCase(), COLOURS.text);
  }
}

function drawFobs(rc: RenderContext): void {
  const { ctx } = rc;
  for (const fob of rc.world.fobs.values()) {
    const centre = px(rc, { x: fob.x, y: fob.y });
    const friendly = fob.team === rc.team;

    // The build radius matters constantly to a squad leader, so it is drawn.
    if (friendly) {
      ctx.strokeStyle = COLOURS.captureRing;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, metres(rc, rules.FOB_BUILD_RADIUS_M), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = TEAM_COLOUR[fob.team];
    ctx.fillRect(centre.x - 6, centre.y - 6, 12, 12);
    ctx.strokeStyle = COLOURS.ground;
    ctx.lineWidth = 2;
    ctx.strokeRect(centre.x - 6, centre.y - 6, 12, 12);

    if (friendly) {
      label(
        ctx,
        centre.x,
        centre.y + 18,
        `${fob.constructionPoints} CP / ${fob.ammoPoints} AP`,
        COLOURS.dim,
      );
    }
  }
}

function drawDeployables(rc: RenderContext): void {
  const { ctx } = rc;
  for (const deployable of rc.world.deployables.values()) {
    const centre = px(rc, { x: deployable.x, y: deployable.y });
    const colour = deployable.overrun
      ? COLOURS.enemy
      : deployable.built
        ? TEAM_COLOUR[deployable.team]
        : COLOURS.dim;

    ctx.fillStyle = colour;
    const size = deployable.kind === "habitat" ? 9 : 6;
    ctx.beginPath();
    ctx.moveTo(centre.x, centre.y - size);
    ctx.lineTo(centre.x + size, centre.y);
    ctx.lineTo(centre.x, centre.y + size);
    ctx.lineTo(centre.x - size, centre.y);
    ctx.closePath();
    ctx.fill();

    if (!deployable.built) {
      // A build site with a progress bar is the difference between "someone
      // should dig this" and "this is nearly done, hold on".
      const width = 26;
      ctx.fillStyle = COLOURS.grid;
      ctx.fillRect(centre.x - width / 2, centre.y + size + 4, width, 3);
      ctx.fillStyle = COLOURS.warn;
      ctx.fillRect(centre.x - width / 2, centre.y + size + 4, width * deployable.buildProgress, 3);
    }

    if (deployable.kind === "habitat") {
      label(
        ctx,
        centre.x,
        centre.y - size - 6,
        deployable.overrun ? "HAB OVERRUN" : "HAB",
        deployable.overrun ? COLOURS.enemy : COLOURS.text,
      );
    }
  }
}

function drawRallies(rc: RenderContext): void {
  const { ctx } = rc;
  for (const rally of rc.world.rallies.values()) {
    const centre = px(rc, { x: rally.x, y: rally.y });
    ctx.strokeStyle = rally.live ? COLOURS.friendlySquad : COLOURS.dim;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centre.x, centre.y - 8);
    ctx.lineTo(centre.x, centre.y + 4);
    ctx.lineTo(centre.x + 8, centre.y - 2);
    ctx.closePath();
    ctx.stroke();
    const seconds = Math.ceil(rules.ticksToSeconds(rally.readyInTicks));
    label(
      ctx,
      centre.x,
      centre.y + 16,
      rally.live ? "RALLY" : seconds > 0 ? `RALLY ${seconds}s` : "RALLY BLOCKED",
      rally.live ? COLOURS.friendlySquad : COLOURS.dim,
    );
  }
}

function drawVehicles(rc: RenderContext): void {
  const { ctx } = rc;
  for (const vehicle of rc.world.vehicles.values()) {
    const at = rc.world.interpolate(vehicle.track, rc.renderTick);
    const centre = px(rc, at);
    ctx.fillStyle = TEAM_COLOUR[vehicle.team];
    ctx.globalAlpha = vehicle.kind === "logistics" ? 0.9 : 1;
    ctx.fillRect(centre.x - 7, centre.y - 4, 14, 8);
    ctx.globalAlpha = 1;
    if (vehicle.team === rc.team && vehicle.kind === "logistics") {
      label(
        ctx,
        centre.x,
        centre.y - 10,
        `${vehicle.cargoConstructionPoints}/${vehicle.cargoAmmoPoints}`,
        COLOURS.dim,
      );
    }
  }
}

function drawPlayers(rc: RenderContext): void {
  const { ctx } = rc;
  for (const player of rc.world.players.values()) {
    if (player.status === "deploying") continue;
    if (player.id === rc.world.self?.id) continue;

    const at = rc.world.interpolate(player.track, rc.renderTick);
    const centre = px(rc, at);

    const colour =
      player.status === "downed"
        ? COLOURS.downed
        : player.team !== rc.team
          ? COLOURS.enemy
          : player.squad === rc.squad
            ? COLOURS.friendlySquad
            : COLOURS.friendly;

    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, player.status === "downed" ? 3 : 4.5, 0, Math.PI * 2);
    ctx.fill();

    // Squad leaders get a ring: knowing where yours is, is most of the game.
    if (player.role === "squadLeader" && player.team === rc.team) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawSelf(rc: RenderContext): void {
  const { ctx } = rc;
  if (rc.world.self === null || rc.world.self.status === "deploying") return;
  const centre = px(rc, rc.selfPos);

  // Engagement range, so "can I even shoot that" is answerable by looking.
  // Kept very faint: it is a reference, and at this zoom it is the largest
  // thing on screen, so at full strength it drowns out the actual battle.
  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.strokeStyle = COLOURS.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 8]);
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, metres(rc, rules.ENGAGEMENT_MAX_RANGE_M), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // A short facing stub toward the cursor, not a line to the screen edge —
  // it says which way you are looking without drawing a chord across the map.
  const dx = rc.pointer.x - rc.selfPos.x;
  const dy = rc.pointer.y - rc.selfPos.y;
  const length = Math.hypot(dx, dy);
  if (length > 0) {
    const stub = 18;
    ctx.strokeStyle = COLOURS.self;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(centre.x, centre.y);
    ctx.lineTo(centre.x + (dx / length) * stub, centre.y + (dy / length) * stub);
    ctx.stroke();
  }

  ctx.strokeStyle = COLOURS.self;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, 6, 0, Math.PI * 2);
  ctx.stroke();
}

function label(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  colour: string,
): void {
  ctx.fillStyle = colour;
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.fillText(text, x, y);
}

export { COLOURS, TEAM_COLOUR };
