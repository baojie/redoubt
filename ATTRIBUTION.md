# Third-party assets

Most of this project is asset-free by design: the terrain is generated from the
match seed, the buildings are textured procedurally, and the weapons, gear and
effects are built from primitives at runtime. The exceptions — the soldier and
the two vehicles — are listed here, with their licences.

## Soldier

`packages/client/public/models/Soldier.glb` — every soldier on the map.

- **Source**: "Soldier" by Quaternius, via [Poly Pizza](https://poly.pizza/m/oAArCNHjFB)
- **Licence**: Creative Commons Attribution 3.0 (CC-BY 3.0), as stated by the host
- **Licence note**: `packages/client/public/models/Soldier.LICENSE.md`

Attribution is required by this licence and is the reason this entry exists;
keep it if you redistribute the client. Note that Quaternius releases most work
as CC0 and the vehicles here are CC0 — Poly Pizza states CC-BY for this model
specifically, so it is treated as the stricter of the two.

Used unmodified. Scaled at runtime to the hit cylinder the server tests rounds
against, and its own animation clips are played as authored: idle, walk, run
and death. Only the uniform material takes a team colour; the face, hair and
boots keep theirs.

### Replaced: RiggedFigure

Khronos's `RiggedFigure` (CC-BY 4.0) was the soldier until this model arrived.
It was an unclothed mannequin with no face, posed by hand — two shoulder bones
and two hip bones driven by a sine wave — and because every mesh on it was
painted the team colour it read as a flat red or blue silhouette. It has been
removed rather than left in the tree: nothing references it, and an unused
binary with an attribution obligation is a liability, not an asset.

Also deliberately *not* used: Khronos's `CesiumMan`, which carries an additional
trademark limitation on top of its CC-BY licence.

## Vehicle models

`packages/client/public/models/LogisticsTruck.glb` — the supply truck.
`packages/client/public/models/ArmouredPickup.glb` — the armoured vehicle.

- **Source**: Quaternius, via [Poly Pizza](https://poly.pizza/) —
  [Truck](https://poly.pizza/m/cXw6oiFtZ8) and
  [Pickup Truck Armored](https://poly.pizza/m/RUwMItmU4B)
- **Licence**: CC0 1.0 Universal (public domain dedication)
- **Licence note**: `packages/client/public/models/Quaternius.LICENSE.md`

CC0 requires no attribution at all. They are recorded here anyway: knowing
where a binary in the repository came from is worth more than the licence
minimum, and if provenance is ever questioned this is the answer.

Used unmodified. Scaled at runtime to fit inside the hull box the server tests
rounds against — uniformly, so they keep their proportions; see
`vehicleModel.ts` for why that was chosen over an exact per-axis fit.

Both were checked against the constraint in PLAN §8: they are generic civilian
and utility vehicles from a public-domain asset library, not extracted from any
commercial game.
