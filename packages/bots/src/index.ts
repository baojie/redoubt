/**
 * @redoubt/bots — the decision layer.
 *
 * Reads authoritative state, returns commands. It never mutates state and
 * never reaches into `core` internals, which is what lets the same code drive
 * a headless balance run and fill empty slots on a live server.
 *
 * Layered by role, per PLAN §5's M1: soldiers move, fight and build; squad
 * leaders site rallies and radios; drivers run the supply loop; raiders go and
 * kill the enemy's respawns. Role assignment is by squad index and therefore
 * deterministic — a balance harness whose bots reorganise differently on every
 * run measures nothing.
 */

export { createDriverMemory, forgetPlayer, type DriverMemory, type Sighting } from "./memory.js";
export { decide, type DecideOptions } from "./driver.js";
export {
  SIGHT_RADIUS_M,
  knownEnemyFobs,
  knownEnemyRallies,
  likelyEnemyFobArea,
  objectiveFor,
  rearguardFor,
  updateSightings,
} from "./awareness.js";
export { FOB_STALE_DISTANCE_M, fobSite } from "./roles/squadLeader.js";
