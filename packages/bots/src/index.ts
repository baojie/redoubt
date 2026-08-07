/**
 * @redoubt/bots — the decision layer.
 *
 * Reads authoritative state, returns commands. It never mutates state and
 * never reaches into `core` internals, which is what lets the same code drive
 * a headless balance run and fill empty slots on a live server.
 */

export {
  createDriverMemory,
  decide,
  objectiveFor,
  type DecideOptions,
  type DriverMemory,
} from "./driver.js";
