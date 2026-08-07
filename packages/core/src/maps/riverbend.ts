/**
 * "Riverbend" — the reference 1 km² layout.
 *
 * This file is map *geometry data*, not game rules: the coordinates here carry
 * no balance meaning and are exempt from the rules.ts constant policy (see
 * CLAUDE.md). Anything with rule semantics — capture radius, spacing minimums —
 * still comes from rules.ts.
 *
 * Layout is the classic five-column chain. Each column offers two or three
 * candidate points; a lane threads one point per column from team 0's side to
 * team 1's. RAAS draws one lane per match, so scouting the middle actually
 * matters — you do not know which way the chain runs until you find the flags.
 *
 * All names are invented for this project.
 */

import { MAP_SIZE_M } from "../rules.js";
import type { MapDefinition } from "../types.js";

const P = {
  quarry: 0,
  millrace: 1,
  crossroads: 2,
  orchard: 3,
  chapelHill: 4,
  grainSilo: 5,
  railYard: 6,
  pumpHouse: 7,
  sawmill: 8,
  depot: 9,
  bluff: 10,
} as const;

export const RIVERBEND: MapDefinition = {
  name: "Riverbend",
  sizeM: MAP_SIZE_M,
  mainBases: {
    0: { x: 80, y: 500 },
    1: { x: 920, y: 500 },
  },
  vehicleSpawns: {
    0: { x: 120, y: 500 },
    1: { x: 880, y: 500 },
  },
  controlPoints: [
    { id: P.quarry, name: "Quarry", pos: { x: 250, y: 300 } },
    { id: P.millrace, name: "Millrace", pos: { x: 250, y: 700 } },
    { id: P.crossroads, name: "Crossroads", pos: { x: 375, y: 480 } },
    { id: P.orchard, name: "Orchard", pos: { x: 375, y: 780 } },
    { id: P.chapelHill, name: "Chapel Hill", pos: { x: 500, y: 250 } },
    { id: P.grainSilo, name: "Grain Silo", pos: { x: 500, y: 550 } },
    { id: P.railYard, name: "Rail Yard", pos: { x: 500, y: 820 } },
    { id: P.pumpHouse, name: "Pump House", pos: { x: 625, y: 300 } },
    { id: P.sawmill, name: "Sawmill", pos: { x: 625, y: 680 } },
    { id: P.depot, name: "Depot", pos: { x: 750, y: 320 } },
    { id: P.bluff, name: "Bluff", pos: { x: 750, y: 700 } },
  ],
  lanes: [
    {
      name: "Ridge",
      points: [P.quarry, P.crossroads, P.chapelHill, P.pumpHouse, P.depot],
    },
    {
      name: "Valley",
      points: [P.millrace, P.orchard, P.railYard, P.sawmill, P.bluff],
    },
    {
      name: "Central",
      points: [P.quarry, P.crossroads, P.grainSilo, P.sawmill, P.bluff],
    },
    {
      name: "River",
      points: [P.millrace, P.orchard, P.grainSilo, P.pumpHouse, P.depot],
    },
  ],
};
