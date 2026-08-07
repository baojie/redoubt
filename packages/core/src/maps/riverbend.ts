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
 * ## Every lane is mirror-symmetric about x = 500
 *
 * This is a hard constraint on the layout, not an aesthetic one, and it was
 * learned the hard way. The first version of this map was drawn by eye and
 * looked fine: across a thousand matches the win split was 49.8% / 50.2%.
 * Per lane it was Ridge 13/87, Valley 79/21, Central 64/36, River 41/59 —
 * every single match wildly unfair, with the biases happening to cancel in
 * aggregate. An overall win rate cannot detect that, and a competitive layer
 * is judged one match at a time, not in aggregate.
 *
 * So: for every point at (x, y) there is a mirrored point at (1000 - x, y),
 * and every lane maps onto itself under that mirror. Neither side can have a
 * shorter walk, a closer flag, or better ground than the other, and any
 * remaining bias in the statistics belongs to the bots or the rules — which is
 * the whole point of having a balance harness.
 *
 * Check it with `pnpm sim --matches 100 --per-lane`.
 *
 * All names are invented for this project.
 */

import { MAP_SIZE_M } from "../rules.js";
import type { MapDefinition } from "../types.js";

const P = {
  // Column 1 and its mirror, column 5.
  quarry: 0,
  millrace: 1,
  depot: 2,
  bluff: 3,
  // Column 2 and its mirror, column 4.
  crossroads: 4,
  orchard: 5,
  pumpHouse: 6,
  sawmill: 7,
  // Column 3 sits on the mirror line itself.
  chapelHill: 8,
  grainSilo: 9,
  railYard: 10,
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
    // Column 1 / column 5 — each side's home flag.
    { id: P.quarry, name: "Quarry", pos: { x: 250, y: 300 } },
    { id: P.millrace, name: "Millrace", pos: { x: 250, y: 700 } },
    { id: P.depot, name: "Depot", pos: { x: 750, y: 300 } },
    { id: P.bluff, name: "Bluff", pos: { x: 750, y: 700 } },
    // Column 2 / column 4.
    { id: P.crossroads, name: "Crossroads", pos: { x: 375, y: 480 } },
    { id: P.orchard, name: "Orchard", pos: { x: 375, y: 780 } },
    { id: P.pumpHouse, name: "Pump House", pos: { x: 625, y: 480 } },
    { id: P.sawmill, name: "Sawmill", pos: { x: 625, y: 780 } },
    // Column 3, on the mirror line.
    { id: P.chapelHill, name: "Chapel Hill", pos: { x: 500, y: 250 } },
    { id: P.grainSilo, name: "Grain Silo", pos: { x: 500, y: 550 } },
    { id: P.railYard, name: "Rail Yard", pos: { x: 500, y: 820 } },
  ],
  lanes: [
    {
      // Northern route over the high ground.
      name: "Ridge",
      points: [P.quarry, P.crossroads, P.chapelHill, P.pumpHouse, P.depot],
    },
    {
      // Southern route through the low ground.
      name: "Valley",
      points: [P.millrace, P.orchard, P.railYard, P.sawmill, P.bluff],
    },
    {
      // North side out, straight through the middle.
      name: "Central",
      points: [P.quarry, P.crossroads, P.grainSilo, P.pumpHouse, P.depot],
    },
    {
      // South side out, straight through the middle.
      name: "River",
      points: [P.millrace, P.orchard, P.grainSilo, P.sawmill, P.bluff],
    },
  ],
};
