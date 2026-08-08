# Third-party assets

This project is otherwise asset-free by design: the terrain is generated from
the match seed and every other shape is built from primitives at runtime. The
one exception is listed here.

## RiggedFigure

`packages/client/public/models/RiggedFigure.glb` — the soldier model.

- **Source**: [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/RiggedFigure)
- **Licence**: Creative Commons Attribution 4.0 International (CC-BY 4.0)
- **Full licence text**: `packages/client/public/models/RiggedFigure.LICENSE.md`

Used unmodified, scaled at runtime to match the hit cylinder the server tests
rounds against. Attribution is required by the licence and is the reason this
file exists; keep it if you redistribute the client.

Deliberately *not* used: Khronos's `CesiumMan`, which is otherwise a better
looking model, because it carries an additional trademark limitation on top of
CC-BY. A trademark obligation is a worse thing to inherit than a blocky
silhouette.

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
