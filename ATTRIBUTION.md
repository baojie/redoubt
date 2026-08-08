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
