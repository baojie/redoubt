# Changelog

All notable changes to **redoubt**, grouped by day. The package versions are
all `0.0.0` (nothing is released), so days stand in for versions here. Written
in English per the project convention in `CLAUDE.md`.

## [2026-08-09] — first-person polish

**Added**
- Real rifle model: `AssaultRifle.glb` (Quaternius, CC0) replaces the
  procedural rifle. The programmatic scope now sits on it at a height measured
  from the real receiver. Licence and source recorded in `ATTRIBUTION.md`.
- Event-delivery guarantee: core refuses to let an event go unhandled, so
  "nobody was listening" becomes impossible rather than merely unlikely.
  Route-gate tests prove it.

**Changed**
- Arms rebuilt so they read as human instead of two pipes: elbows and
  shoulders are placed explicitly to project onto the screen as visible bends,
  the forearm-to-upper-arm taper is corrected, and the hands grip the rifle.
- `README` documents LAN multiplayer: all-interface binding, the automatic
  server URL derived from the page's host, the `?server=` override, and the
  firewall ports that must be open.

## [2026-08-08] — vehicles, grenades, and the 3D world filling in

**Added**
- **M4 vehicles**: a drivable supply truck and armoured pickup — destructible,
  solid (a parked truck is cover), and repairable at FOB repair stations. Real
  vehicle models (CC0) with wheels, cab and cargo bed.
- **Grenades end to end**: every soldier carries three; they arc and bounce
  off geometry; the explosion travels in the snapshot and is visible in the
  client. Throw is bound to `4`, the HUD shows the grenade count, and the
  throw key is folded into the action table instead of ad-hoc input handling.
- **Grass**: textured field with patches and blades that sway in the wind.
- **Fabric**: cloth and leather materials on the sleeves and gloves.
- **Soldier model**: the animated Quaternius soldier (CC-BY 3.0) replaces the
  mannequin; only the uniform takes the team colour.
- **World detail**: brick/block/corrugated-steel building textures; an aerial
  satellite ground baked from the real heightfield; muzzle flash and
  enemy-visible tracers that leave the muzzle; a real magnification circle
  when aiming through the scope.
- **Playtest flags**: invulnerability and infinite ammo are switches driven
  through the command stream, not external state pokes.
- **Speed**: base move speed up to 4.5 m/s, accelerating to 1.7× while a
  direction key is held, with the missing tests filled in.

**Fixed**
- A and D were reversed (first-person right vector rotated the wrong way).
- A focus check swallowed key presses, and "did I actually move" became
  answerable.
- A reload bug that could permanently jam the gun; the infinite-ammo flag.
- Spawns no longer stack a whole wave on one coordinate.
- The restart UI was unclickable after a match ended; snapshot pacing is no
  longer pinned to the stopped simulation clock.
- The rifle was restored to soldiers' hands after the model swap — one version
  had them holding air.

## [2026-08-07] — M0 through M3

**Added**
- **M0 — deterministic rules engine**: tickets, RAAS objectives, FOBs, rally
  points, logistics, casualties. Pure, seed-driven, no clocks or randomness —
  bit-identical state on any machine.
- **M1 — layered bots**: roles split by layer, enemy discovery, a three-man
  raiding party hunting enemy radios, proactive reloading.
- **M2 — netcode**: a wire protocol shared by server and client, a 20 Hz
  authoritative server, and a 2D top-down playable client with prediction.
- **M3 — first person**: Three.js view, real ballistics replacing the
  hit-probability stand-in, hand-placed mirrored cover that stops rounds and
  people, aim-down-sights with recoil, downed-and-drag rescue, and the
  top-down map view re-implemented as a satellite image of the real terrain.
- **Balance**: per-lane win-rate statistics (`--per-lane`) and a gate that
  every lane must sit between 48% and 52%; the map is mirror-symmetric by
  construction and a test keeps it that way.

**Fixed**
- Same-tick damage now settles simultaneously, removing the first-shot
  advantage; three missing tests added after the speed change.
