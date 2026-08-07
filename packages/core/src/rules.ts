/**
 * The single source of truth for every tunable number in the game.
 *
 * PLAN.md §6 constraint: a bare numeric literal anywhere else in `core`
 * (other than 0 / 1 / -1, array indices, and the algorithm constants inside
 * rng.ts and hash.ts) is a bug. Change balance here and nowhere else.
 *
 * Values are transcribed from the design table in PLAN.md §2, which in turn
 * derives from publicly documented tactical-shooter conventions. Game
 * mechanics and numbers are not copyrightable; names and assets are, and none
 * are used here.
 */

// ---------------------------------------------------------------------------
// Simulation clock
// ---------------------------------------------------------------------------

/** Authoritative simulation rate. Every duration below is quantised to this. */
export const TICK_RATE_HZ = 20;

export const SECONDS_PER_MINUTE = 60;

/** Convert seconds to whole ticks. Rounds up so a duration is never short. */
export function secondsToTicks(seconds: number): number {
  return Math.ceil(seconds * TICK_RATE_HZ);
}

/** Convert ticks to seconds. Display/reporting only. */
export function ticksToSeconds(ticks: number): number {
  return ticks / TICK_RATE_HZ;
}

/**
 * Cadence dividers. Expensive spatial queries run on a fixed sub-multiple of
 * the tick rate rather than every tick. Deterministic (driven by tick % N),
 * and the difference is imperceptible for 30s-scale mechanics.
 */
export const CAPTURE_EVAL_INTERVAL_TICKS = 10; // 2 Hz
export const OVERRUN_EVAL_INTERVAL_TICKS = 10; // 2 Hz
export const BLEED_EVAL_INTERVAL_TICKS = 20; // 1 Hz

/** Hard match cap. A match that reaches this ends in a draw-on-tickets. */
export const MATCH_MAX_DURATION_S = 75 * SECONDS_PER_MINUTE;
export const MATCH_MAX_TICKS = secondsToTicks(MATCH_MAX_DURATION_S);

/** Staging phase before the flags unlock, as in a real match warm-up. */
export const STAGING_DURATION_S = 30;
export const STAGING_TICKS = secondsToTicks(STAGING_DURATION_S);

// ---------------------------------------------------------------------------
// Teams and squads
// ---------------------------------------------------------------------------

export const TEAM_COUNT = 2;
/** Per PLAN §1: 12v12 is the target scale, bots fill the gaps. */
export const PLAYERS_PER_TEAM = 12;
export const SQUAD_MAX_SIZE = 6;
export const SQUADS_PER_TEAM = Math.ceil(PLAYERS_PER_TEAM / SQUAD_MAX_SIZE);

// ---------------------------------------------------------------------------
// Tickets (PLAN §2.1)
// ---------------------------------------------------------------------------

export const START_TICKETS = 300;

export const TICKET_COST_INFANTRY_DEATH = 1;
export const TICKET_COST_COMMANDER_DEATH = 2;
export const TICKET_COST_FOB_RADIO_DESTROYED = 20;
export const TICKET_COST_VEHICLE_LOGISTICS = 5;
export const TICKET_COST_VEHICLE_ARMOURED = 10;

/** First team to ever own a given control point banks this. Once per point. */
export const TICKET_GAIN_FIRST_CAPTURE = 20;

/**
 * Standard positional bleed: the team behind on flags loses tickets over time.
 * Scaled by how many flags it is behind by.
 */
export const BLEED_TICKETS_PER_FLAG_LEAD_PER_MINUTE = 3;

/** Mercy rule: one team owns every point, the other bleeds out fast. */
export const MERCY_BLEED_TOTAL_TICKETS = 60;
export const MERCY_BLEED_DURATION_S = 60;

/**
 * Double neutral: two or more points in the active lane are neutral at once,
 * i.e. both teams have cracked the other's defended flag. All bleed pauses
 * until the stalemate resolves.
 */
export const DOUBLE_NEUTRAL_MIN_NEUTRAL_POINTS = 2;

// ---------------------------------------------------------------------------
// Control points (PLAN §2.2)
// ---------------------------------------------------------------------------

export const CAPTURE_RADIUS_M = 100;

/** Time for an uncontested single attacker to strip an owned point to neutral. */
export const NEUTRALISE_DURATION_S = 30;
/** Time for an uncontested single attacker to take a neutral point. */
export const CAPTURE_DURATION_S = 30;

export const NEUTRALISE_TICKS = secondsToTicks(NEUTRALISE_DURATION_S);
export const CAPTURE_TICKS = secondsToTicks(CAPTURE_DURATION_S);

/** Each player of numeric advantage beyond the first adds this much rate. */
export const CAPTURE_SPEEDUP_PER_EXTRA_PLAYER = 0.25;
/** Ceiling on the above, so a 12-man zerg cannot instantly flip a flag. */
export const CAPTURE_MAX_SPEED_MULTIPLIER = 3;

/** With no attacker present, contest progress unwinds at this rate multiple. */
export const CAPTURE_DECAY_MULTIPLIER = 0.5;

// ---------------------------------------------------------------------------
// Rally points (PLAN §2.3)
// ---------------------------------------------------------------------------

/** Squad leader plus this many squadmates must stand within the radius. */
export const RALLY_PLACE_MIN_SQUADMATES = 1;
export const RALLY_PLACE_SQUADMATE_RADIUS_M = 8;

/** Paid out of the placing leader's personal ammo pool. */
export const RALLY_AMMO_COST = 50;

/** Enemies this close block spawning outright. */
export const RALLY_ENEMY_BLOCK_RADIUS_M = 50;
/** Enemies this close overrun and destroy it. Bullets and explosives cannot. */
export const RALLY_ENEMY_DESTROY_RADIUS_M = 5;

/** A rally releases one wave, then locks for this long. */
export const RALLY_WAVE_COOLDOWN_S = 60;
export const RALLY_WAVE_COOLDOWN_TICKS = secondsToTicks(RALLY_WAVE_COOLDOWN_S);
/** How long a wave stays open once the first player spawns on it. */
export const RALLY_WAVE_WINDOW_S = 5;
export const RALLY_WAVE_WINDOW_TICKS = secondsToTicks(RALLY_WAVE_WINDOW_S);

export const RALLY_SPAWN_DELAY_S = 10;
export const RALLY_SPAWN_DELAY_TICKS = secondsToTicks(RALLY_SPAWN_DELAY_S);

/** Keep rallies from being planted on top of the enemy main. */
export const RALLY_MIN_DISTANCE_FROM_MAIN_BASE_M = 150;

// ---------------------------------------------------------------------------
// FOB radio and build radius (PLAN §2.4)
// ---------------------------------------------------------------------------

/** Squad leader plus this many squadmates must stand within the radius. */
export const FOB_PLACE_MIN_SQUADMATES = 2;
export const FOB_PLACE_SQUADMATE_RADIUS_M = 15;

/** Hard spacing invariants — see CLAUDE.md invariant #2. */
export const FOB_MIN_DISTANCE_FROM_FRIENDLY_FOB_M = 400;
export const FOB_MIN_DISTANCE_FROM_MAIN_BASE_M = 150;

export const FOB_BUILD_RADIUS_M = 150;

/** Supply pool ceilings — see CLAUDE.md invariant #3. */
export const FOB_MAX_CONSTRUCTION_POINTS = 20000;
export const FOB_MAX_AMMO_POINTS = 20000;

export const FOB_RADIO_MAX_HEALTH = 1000;

/** Manually dismantling your own radio is free; losing it to the enemy is not. */
export const FOB_SELF_DISMANTLE_TICKET_COST = 0;

/**
 * Enemies have to physically reach a radio or deployable to tear it down —
 * standing off and shooting it does nothing. This is what forces an assault
 * onto the position rather than a firing line 200m away.
 */
export const ENEMY_TEARDOWN_RADIUS_M = 5;
export const ENEMY_TEARDOWN_DAMAGE_PER_SECOND = 100;

// ---------------------------------------------------------------------------
// Deployables
// ---------------------------------------------------------------------------

export const DEPLOYABLE_TYPES = [
  "habitat",
  "ammoCrate",
  "heavyMachineGun",
  "antiTankMissile",
  "repairStation",
  "sandbag",
] as const;

export type DeployableType = (typeof DEPLOYABLE_TYPES)[number];

export interface DeployableSpec {
  /** Construction points consumed over the course of building it. */
  readonly constructionCost: number;
  /** Ammo points consumed over the course of building it. */
  readonly ammoCost: number;
  /** Seconds of work for a single builder working alone. */
  readonly buildWorkSeconds: number;
  readonly maxHealth: number;
  /** Per-FOB cap. */
  readonly maxPerFob: number;
  /**
   * "Tech" deployables vanish instantly when their radio dies. Pure earthworks
   * (sandbags) survive — PLAN §2.4.
   */
  readonly isTech: boolean;
}

export const DEPLOYABLE_SPECS: Readonly<Record<DeployableType, DeployableSpec>> = {
  habitat: {
    constructionCost: 500,
    ammoCost: 0,
    buildWorkSeconds: 40,
    maxHealth: 1500,
    maxPerFob: 1,
    isTech: true,
  },
  ammoCrate: {
    constructionCost: 100,
    ammoCost: 0,
    buildWorkSeconds: 15,
    maxHealth: 500,
    maxPerFob: 2,
    isTech: true,
  },
  heavyMachineGun: {
    constructionCost: 250,
    ammoCost: 0,
    buildWorkSeconds: 25,
    maxHealth: 800,
    maxPerFob: 4,
    isTech: true,
  },
  antiTankMissile: {
    constructionCost: 600,
    ammoCost: 500,
    buildWorkSeconds: 30,
    maxHealth: 800,
    maxPerFob: 2,
    isTech: true,
  },
  repairStation: {
    constructionCost: 500,
    ammoCost: 0,
    buildWorkSeconds: 30,
    maxHealth: 800,
    maxPerFob: 1,
    isTech: true,
  },
  sandbag: {
    constructionCost: 30,
    ammoCost: 0,
    buildWorkSeconds: 10,
    maxHealth: 600,
    maxPerFob: 20,
    isTech: false,
  },
};

/**
 * Build speed as a function of how many players are working on a deployable.
 * Index = builder count, value = work-rate multiplier. This is the curve that
 * makes a habitat take 40s solo and 4s with five people (PLAN §2.4) — the rule
 * that manufactures the "everyone dig, then fight" moment.
 */
export const BUILD_SPEED_BY_BUILDER_COUNT = [0, 1, 2.5, 4.5, 7, 10] as const;
/** Builders beyond the end of the curve add nothing. */
export const BUILD_SPEED_MAX_MULTIPLIER =
  BUILD_SPEED_BY_BUILDER_COUNT[BUILD_SPEED_BY_BUILDER_COUNT.length - 1] ?? 1;

/** A player must stand this close to a build site to contribute. */
export const BUILD_REACH_M = 5;

// ---------------------------------------------------------------------------
// Habitat spawn rules (PLAN §2.4)
// ---------------------------------------------------------------------------

export const HABITAT_SPAWN_DELAY_S = 45;
export const HABITAT_SPAWN_DELAY_TICKS = secondsToTicks(HABITAT_SPAWN_DELAY_S);

/** Overrun thresholds: either condition alone disables the habitat. */
export const OVERRUN_CLOSE_ENEMY_COUNT = 2;
export const OVERRUN_CLOSE_RADIUS_M = 20;
export const OVERRUN_FAR_ENEMY_COUNT = 8;
export const OVERRUN_FAR_RADIUS_M = 80;

/** A radio below this health fraction also puts its habitat into overrun. */
export const OVERRUN_RADIO_HEALTH_FRACTION = 0.5;

// ---------------------------------------------------------------------------
// Main base
// ---------------------------------------------------------------------------

export const MAIN_BASE_RADIUS_M = 100;
export const MAIN_BASE_SPAWN_DELAY_S = 15;
export const MAIN_BASE_SPAWN_DELAY_TICKS = secondsToTicks(MAIN_BASE_SPAWN_DELAY_S);

// ---------------------------------------------------------------------------
// Soldier state
// ---------------------------------------------------------------------------

export const PLAYER_MAX_HEALTH = 100;
export const PLAYER_MAX_AMMO = 100;

export const PLAYER_SPEED_MPS = 3.5;
export const PLAYER_SPEED_M_PER_TICK = PLAYER_SPEED_MPS / TICK_RATE_HZ;

/** Downed players bleed out over this long unless a medic reaches them. */
export const BLEEDOUT_DURATION_S = 90;
export const BLEEDOUT_TICKS = secondsToTicks(BLEEDOUT_DURATION_S);

export const REVIVE_REACH_M = 2;
export const REVIVE_DURATION_S = 8;
export const REVIVE_TICKS = secondsToTicks(REVIVE_DURATION_S);
/** Health a revived player stands up with. */
export const REVIVE_HEALTH = 25;

/** Ammo restored per resupply pull from a crate or vehicle. */
export const RESUPPLY_AMMO_PER_PULL = 50;
export const RESUPPLY_REACH_M = 5;
/** Ammo points a FOB spends per unit of ammo handed to a soldier. */
export const RESUPPLY_AMMO_POINT_COST_PER_UNIT = 1;

// ---------------------------------------------------------------------------
// Simplified combat model (M0/M1 — replaced by real ballistics in M3)
// ---------------------------------------------------------------------------

export const ENGAGEMENT_MAX_RANGE_M = 200;
/** Hit chance per shot at point-blank range. */
export const HIT_CHANCE_AT_MIN_RANGE = 0.35;
/** Hit chance per shot at maximum engagement range. */
export const HIT_CHANCE_AT_MAX_RANGE = 0.04;
export const DAMAGE_PER_HIT = 45;
/** Firing costs ammo; a dry soldier cannot shoot. */
export const AMMO_PER_ENGAGEMENT = 1;

/**
 * Rate of fire. Enforced in `core` rather than left to the caller's cadence,
 * so a client that spams the engage command gains nothing.
 */
export const ENGAGEMENT_COOLDOWN_S = 0.5;
export const ENGAGEMENT_COOLDOWN_TICKS = secondsToTicks(ENGAGEMENT_COOLDOWN_S);

// ---------------------------------------------------------------------------
// Vehicles (PLAN §2.5)
// ---------------------------------------------------------------------------

export const VEHICLE_TYPES = ["logistics", "armoured"] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export interface VehicleSpec {
  readonly speedMps: number;
  readonly maxHealth: number;
  readonly ticketCost: number;
  readonly seats: number;
  readonly maxCargoConstructionPoints: number;
  readonly maxCargoAmmoPoints: number;
  readonly respawnDelayS: number;
}

export const VEHICLE_SPECS: Readonly<Record<VehicleType, VehicleSpec>> = {
  logistics: {
    speedMps: 12,
    maxHealth: 800,
    ticketCost: TICKET_COST_VEHICLE_LOGISTICS,
    seats: 2,
    maxCargoConstructionPoints: 1200,
    maxCargoAmmoPoints: 1800,
    respawnDelayS: 5 * SECONDS_PER_MINUTE,
  },
  armoured: {
    speedMps: 16,
    maxHealth: 2500,
    ticketCost: TICKET_COST_VEHICLE_ARMOURED,
    seats: 3,
    maxCargoConstructionPoints: 0,
    maxCargoAmmoPoints: 0,
    respawnDelayS: 10 * SECONDS_PER_MINUTE,
  },
};

/** How close a soldier must be to climb into a vehicle. */
export const VEHICLE_MOUNT_REACH_M = 5;

export const LOGISTICS_TRUCKS_PER_TEAM = 2;
export const ARMOURED_VEHICLES_PER_TEAM = 1;

/** Supply transfer rate while parked. */
export const SUPPLY_TRANSFER_POINTS_PER_SECOND = 300;
export const SUPPLY_TRANSFER_POINTS_PER_TICK =
  SUPPLY_TRANSFER_POINTS_PER_SECOND / TICK_RATE_HZ;

/** A vehicle must be under this speed to load or unload — PLAN §2.5. */
export const SUPPLY_TRANSFER_MAX_SPEED_MPS = 0.1;

/** How close a truck must be to a radio to unload into it. */
export const SUPPLY_UNLOAD_REACH_M = FOB_BUILD_RADIUS_M;

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

/** Playable area is a square this many metres on a side — PLAN §1. */
export const MAP_SIZE_M = 1000;

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** Work-rate multiplier for a given number of simultaneous builders. */
export function buildSpeedMultiplier(builderCount: number): number {
  if (builderCount <= 0) return 0;
  const capped = Math.min(builderCount, BUILD_SPEED_BY_BUILDER_COUNT.length - 1);
  return BUILD_SPEED_BY_BUILDER_COUNT[capped] ?? BUILD_SPEED_MAX_MULTIPLIER;
}

/** Capture-rate multiplier for a given numeric advantage on a flag. */
export function captureSpeedMultiplier(advantage: number): number {
  if (advantage <= 0) return 0;
  const raw = 1 + (advantage - 1) * CAPTURE_SPEEDUP_PER_EXTRA_PLAYER;
  return Math.min(raw, CAPTURE_MAX_SPEED_MULTIPLIER);
}

/** Linear falloff of hit chance with range, for the M0/M1 combat stand-in. */
export function hitChanceAtRange(rangeM: number): number {
  if (rangeM >= ENGAGEMENT_MAX_RANGE_M) return 0;
  const t = Math.max(0, rangeM) / ENGAGEMENT_MAX_RANGE_M;
  return HIT_CHANCE_AT_MIN_RANGE + (HIT_CHANCE_AT_MAX_RANGE - HIT_CHANCE_AT_MIN_RANGE) * t;
}
