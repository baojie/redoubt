/**
 * Building one client's view of the world.
 *
 * Two jobs, both from PLAN §4's bandwidth budget of under 30 KB/s per client:
 *
 *  - **Cull by distance.** A soldier does not need to know what is happening
 *    900 m away, and on a 1 km² map that removes most of the world most of
 *    the time.
 *  - **Send only what changed.** Each session remembers a signature per
 *    entity it has sent; an entity whose signature is unchanged is omitted.
 *    Absence therefore means "unchanged", which is why entities leaving view
 *    must be named explicitly in `removed` — otherwise clients accumulate
 *    ghosts of everything that ever walked past them.
 */

import {
  World,
  distance,
  habitatIsLive,
  rallyIsLive,
  rules,
  type GameState,
  type Player,
  type TeamId,
} from "@redoubt/core";
import {
  quantise,
  type ControlPointView,
  type DeployableView,
  type FobView,
  type PlayerView,
  type RallyView,
  type SelfView,
  type Snapshot,
  type TeamView,
  type VehicleView,
} from "@redoubt/protocol";

/**
 * Beyond this, entities are not sent at all. Generous relative to the 200 m
 * engagement range so that map awareness — a truck moving, a flag being
 * contested nearby — arrives before the shooting does.
 */
export const CULL_RADIUS_M = 500;

/**
 * A resync, sent this often even though WebSocket delivery is ordered and
 * reliable so deltas cannot actually be lost.
 *
 * It costs about half a percent of the stream and it means any bug in the
 * dirty-tracking below self-heals within ten seconds instead of leaving a
 * client quietly wrong. When PLAN's Phase 4 swaps WebSocket for unreliable
 * WebRTC, this stops being insurance and becomes mandatory.
 */
export const FULL_SNAPSHOT_INTERVAL_TICKS = rules.secondsToTicks(10);

type Signatures = Map<number, string>;

/** Everything the server remembers about what one client has already been told. */
export class ClientView {
  private readonly players: Signatures = new Map();
  private readonly fobs: Signatures = new Map();
  private readonly deployables: Signatures = new Map();
  private readonly rallies: Signatures = new Map();
  private readonly vehicles: Signatures = new Map();
  private readonly controlPoints: Signatures = new Map();
  private readonly teams: Signatures = new Map();
  private lastFullTick = -1;

  /** Forget everything, so the next snapshot is a complete one. */
  reset(): void {
    this.players.clear();
    this.fobs.clear();
    this.deployables.clear();
    this.rallies.clear();
    this.vehicles.clear();
    this.controlPoints.clear();
    this.teams.clear();
    this.lastFullTick = -1;
  }

  build(state: GameState, world: World, viewer: Player | null, ackSeq: number): Snapshot {
    const full =
      this.lastFullTick < 0 || state.tick - this.lastFullTick >= FULL_SNAPSHOT_INTERVAL_TICKS;
    if (full) {
      this.reset();
      this.lastFullTick = state.tick;
    }

    // Dead players watch from wherever their team's main is, so the deploy
    // screen still has a map to draw.
    const eye =
      viewer !== null && viewer.status !== "deploying"
        ? viewer.pos
        : state.teams[viewer?.team ?? 0].mainBase;
    const viewerTeam: TeamId = viewer?.team ?? 0;

    const inRange = (pos: { x: number; y: number }): boolean =>
      distance(pos, eye) <= CULL_RADIUS_M;

    const players: PlayerView[] = [];
    const seenPlayers = new Set<number>();
    for (const player of state.players) {
      // You always see your own squad, however far away — a squad leader needs
      // their people on the map to lead them at all.
      const visible =
        player.squad === viewer?.squad || (player.status !== "deploying" && inRange(player.pos));
      if (!visible) continue;
      seenPlayers.add(player.id);
      const view: PlayerView = {
        id: player.id,
        team: player.team,
        squad: player.squad,
        role: player.role,
        status: player.status,
        x: quantise(player.pos.x),
        y: quantise(player.pos.y),
        yaw: quantise(player.aimYaw),
        mounted: player.vehicle !== null,
      };
      if (this.changed(this.players, player.id, view)) players.push(view);
    }

    const fobs: FobView[] = [];
    const seenFobs = new Set<number>();
    for (const fob of state.fobs) {
      // Enemy FOBs are only visible once you are close enough to see them;
      // friendly ones are always on your map, as they would be in briefing.
      const friendly = fob.team === viewerTeam;
      if (fob.destroyed) continue;
      if (!friendly && !inRange(fob.pos)) continue;
      seenFobs.add(fob.id);
      const view: FobView = {
        id: fob.id,
        team: fob.team,
        x: quantise(fob.pos.x),
        y: quantise(fob.pos.y),
        // Supply numbers are a friendly-only concern.
        constructionPoints: friendly ? Math.round(fob.constructionPoints) : 0,
        ammoPoints: friendly ? Math.round(fob.ammoPoints) : 0,
        radioHealth: Math.round(fob.radioHealth),
      };
      if (this.changed(this.fobs, fob.id, view)) fobs.push(view);
    }

    const deployables: DeployableView[] = [];
    const seenDeployables = new Set<number>();
    for (const deployable of state.deployables) {
      if (deployable.destroyed) continue;
      const friendly = deployable.team === viewerTeam;
      if (!friendly && !inRange(deployable.pos)) continue;
      seenDeployables.add(deployable.id);
      const view: DeployableView = {
        id: deployable.id,
        fob: deployable.fob,
        team: deployable.team,
        kind: deployable.type,
        x: quantise(deployable.pos.x),
        y: quantise(deployable.pos.y),
        buildProgress:
          deployable.buildWorkRequired <= 0
            ? 1
            : quantise(deployable.buildProgressWork / deployable.buildWorkRequired),
        built: deployable.built,
        overrun: deployable.type === "habitat" ? !habitatIsLive(world, deployable) : false,
      };
      if (this.changed(this.deployables, deployable.id, view)) deployables.push(view);
    }

    const rallies: RallyView[] = [];
    const seenRallies = new Set<number>();
    for (const rally of state.rallyPoints) {
      if (rally.destroyed) continue;
      // A rally is your squad's business and nobody else's — the enemy finds
      // it by walking onto it, which is exactly the intended counterplay.
      if (rally.squad !== viewer?.squad) continue;
      seenRallies.add(rally.id);
      const view: RallyView = {
        id: rally.id,
        squad: rally.squad,
        team: rally.team,
        x: quantise(rally.pos.x),
        y: quantise(rally.pos.y),
        readyInTicks: Math.max(0, rally.availableAtTick - state.tick),
        live: rallyIsLive(world, rally),
      };
      if (this.changed(this.rallies, rally.id, view)) rallies.push(view);
    }

    const vehicles: VehicleView[] = [];
    const seenVehicles = new Set<number>();
    for (const vehicle of state.vehicles) {
      if (vehicle.destroyed) continue;
      const friendly = vehicle.team === viewerTeam;
      if (!friendly && !inRange(vehicle.pos)) continue;
      seenVehicles.add(vehicle.id);
      const view: VehicleView = {
        id: vehicle.id,
        team: vehicle.team,
        kind: vehicle.type,
        x: quantise(vehicle.pos.x),
        y: quantise(vehicle.pos.y),
        heading: quantise(vehicle.heading),
        occupants: vehicle.occupants.length,
        seats: rules.VEHICLE_SPECS[vehicle.type].seats,
        health: quantise(vehicle.health / rules.VEHICLE_SPECS[vehicle.type].maxHealth),
        cargoConstructionPoints: friendly ? Math.round(vehicle.cargoConstructionPoints) : 0,
        cargoAmmoPoints: friendly ? Math.round(vehicle.cargoAmmoPoints) : 0,
      };
      if (this.changed(this.vehicles, vehicle.id, view)) vehicles.push(view);
    }

    // Objectives and ticket counts are never culled: they are the scoreboard.
    const controlPoints: ControlPointView[] = [];
    for (const point of state.controlPoints) {
      const view: ControlPointView = {
        id: point.id,
        owner: point.owner,
        contestingTeam: point.contestingTeam,
        progress: quantise(point.progress),
      };
      if (this.changed(this.controlPoints, point.id, view)) controlPoints.push(view);
    }

    const teams: TeamView[] = [];
    for (const teamId of [0, 1] as const) {
      const view: TeamView = { id: teamId, tickets: state.teams[teamId].tickets };
      if (this.changed(this.teams, teamId, view)) teams.push(view);
    }

    return {
      tick: state.tick,
      ackSeq,
      full,
      self: viewer === null ? null : selfView(viewer),
      players,
      controlPoints,
      fobs,
      deployables,
      rallies,
      vehicles,
      // Whole list every snapshot. They live about three seconds and there are
      // rarely more than a handful, so diffing them would cost more than it
      // saves — and a missed grenade delta is a blast with no warning.
      grenades: state.grenades
        .filter((g) => inRange(g.pos))
        .map((g) => ({ id: g.id, x: g.pos.x, y: g.pos.y, z: g.pos.z })),
      teams,
      removed: {
        players: this.prune(this.players, seenPlayers),
        fobs: this.prune(this.fobs, seenFobs),
        deployables: this.prune(this.deployables, seenDeployables),
        rallies: this.prune(this.rallies, seenRallies),
        vehicles: this.prune(this.vehicles, seenVehicles),
      },
      doubleNeutral: state.doubleNeutral,
      phase: state.phase,
    };
  }

  /** Record the entity and report whether the client needs to be told. */
  private changed(store: Signatures, id: number, view: object): boolean {
    const signature = JSON.stringify(view);
    if (store.get(id) === signature) return false;
    store.set(id, signature);
    return true;
  }

  /** Drop anything no longer visible and return its ids for the `removed` list. */
  private prune(store: Signatures, seen: Set<number>): number[] {
    const gone: number[] = [];
    for (const id of store.keys()) {
      if (!seen.has(id)) gone.push(id);
    }
    for (const id of gone) store.delete(id);
    return gone;
  }
}

function selfView(player: Player): SelfView {
  return {
    id: player.id,
    team: player.team,
    squad: player.squad,
    role: player.role,
    status: player.status,
    x: quantise(player.pos.x),
    y: quantise(player.pos.y),
    yaw: quantise(player.aimYaw),
    mounted: player.vehicle !== null,
    health: Math.round(player.health),
    ammo: Math.round(player.ammo),
    vehicle: player.vehicle,
    deployingSinceTick: player.deployingSinceTick,
    bleedoutAtTick: player.bleedoutAtTick,
    aimYaw: quantise(player.aimYaw),
    aimPitch: quantise(player.aimPitch),
    magazine: player.magazine,
    reloadingUntilTick: player.reloadingUntilTick,
    suppression: quantise(player.suppression),
    aiming: player.aiming,
    dragging: player.dragging,
    grenades: player.grenades,
    runTicks: player.runTicks,
  };
}
