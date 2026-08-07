/**
 * @redoubt/core — the rules engine.
 *
 * Pure, deterministic, dependency-free. No rendering, no network, no I/O, no
 * clocks. Everything above this layer (server, bots, sim, client) is
 * replaceable; this layer is the game. See CLAUDE.md.
 */

export * as rules from "./rules.js";
export { Rng, type RngState } from "./rng.js";
export * from "./math.js";
export * from "./types.js";
export * from "./commands.js";
export * from "./events.js";
export { createInitialState, TEAM_IDS, type MatchOptions } from "./state.js";
export { Simulation } from "./step.js";
export { hashState, Hasher } from "./hash.js";
export { World } from "./world.js";
export { RIVERBEND } from "./maps/riverbend.js";

export { canTeamContest, flagCounts } from "./systems/capture.js";
export {
  habitatIsLive,
  nearestFriendlyFob,
  validateDeployablePlacement,
  validateFobPlacement,
} from "./systems/fob.js";
export { rallyIsLive, validateRallyPlacement } from "./systems/rally.js";
export { isDriver } from "./systems/logistics.js";
