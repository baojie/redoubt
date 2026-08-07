# redoubt

A tactical team-shooter built rules-first, inspired by Squad and Project Reality.

The premise, from `PLAN.md`: what makes this genre work is not gunplay, it is that
**respawns are a scarce resource and logistics decide who has them.** So the
rules engine comes first and the graphics come last. Right now there are no
graphics at all — and the game is already playable enough to measure.

## Where it is

| Milestone | State |
|---|---|
| **M0** — deterministic rules engine + headless match report | **done** |
| **M1** — layered bots and balance harness | **done** |
| **M2** — authoritative server + 2D playable client | **done** |
| **M3** — 3D first person, real ballistics | **done** |
| M4 — vehicles and logistics in 3D | not started |

## Play it

```bash
./run.sh setup   # first time only
./run.sh play    # starts the server and the client
```

Then open <http://localhost:5173/>. You take over a soldier a bot was already
playing; the rest of both teams stay under bot control.

It opens in first person: click to capture the mouse, WASD to move, mouse to
look, left click to fire, **right click to aim down the sights**, `R` to
reload. Stand over a downed teammate and `F` revives them, `Q` drags them
somewhere safer first. `Tab` switches to the top-down map view — which is the
whole M2 client, still running on the same connection, not a minimap. `/` for
the full key list.

If your machine has no WebGL the page falls back to the map view rather than
breaking; the map view is a complete client on its own.

## Watch it instead

```bash
./run.sh              # one match, headless, prints a battle report
./run.sh batch 1000   # balance statistics over a thousand matches
./run.sh test         # unit, property and balance-gate tests
./run.sh check        # typecheck, then tests
```

A 1000-match run takes about a minute. Current numbers: 48.3% / 51.7% win
split, 44.6 minute mean match length, 95.5% of matches inside the 30-60 band,
zero deadlocks.

**Check `--per-lane`, not just the total.** An aggregate win rate cannot see an
unfair map. The original layout measured 49.8% / 50.2% across a thousand
matches while its four RAAS lanes ran 13/87, 79/21, 64/36 and 41/59 — every
single match unfair, the biases cancelling out in the average. It is now
mirror-symmetric by construction, with a test to keep it that way, and every
lane sits between 48% and 52%.

```bash
./run.sh batch 250 --per-lane
```

## Layout

```
packages/
  core/       pure deterministic rules engine — no rendering, network, I/O or clocks
  bots/       decision layer, split by role. reads state, returns commands
  protocol/   the wire format, shared by server and client and owned by neither
  server/     authoritative 20Hz simulation host
  client/     Canvas 2D top-down view. predicts, never decides
  sim/        headless match runner, battle report, batch balance statistics
```

`packages/core` is the only part that matters long term. It has zero
dependencies, never calls `Math.random()` or `Date.now()`, and takes all
randomness from an injected seeded generator and all time from a tick counter.
Given a seed and a command stream it produces bit-identical state on any
machine, which is what makes headless balance testing, server authority, client
prediction and replay possible at all. See `CLAUDE.md` for the constraints and
the invariants that keep it that way.

## What is implemented

- **Tickets**: deaths, commander deaths, FOB radios, first-capture bonuses,
  positional bleed, mercy bleed, and the double-neutral pause.
- **RAAS objectives**: a lane drawn at random from the map's chain graph, with
  the sequential-attack rule and two-phase neutralise-then-capture contests.
- **FOBs**: placement constraints (squad leader plus two, 400 m from the next
  friendly FOB, 150 m from any main), supply pools, deployables, construction
  that spends supply as it progresses and speeds up super-linearly with more
  builders, overrun, and the destruction cascade.
- **Rally points**: squad-only, 50 rounds out of the leader's own pouch, wave
  cooldowns, and immunity to everything except an enemy walking onto them.
- **Logistics**: load at main, drive, unload into a FOB, at a real transfer
  rate, only while stationary.
- **Casualties**: downed and revivable, with the ticket only spent once nobody
  comes.

- **Ballistics**: rounds leave along the shooter's aim plus a dispersion cone,
  fly at 780 m/s, drop under gravity, and are stopped by terrain. Where a round
  goes is geometry, not a dice roll. Magazines, reloads and a reserve that only
  logistics can refill.
- **Suppression**: rounds passing close rattle a soldier, widening their own
  dispersion and darkening their view until it decays. PLAN §5 rates this above
  weapon models, and it is the reason a machine gun is useful without hitting
  anyone.
- **Terrain and cover**: a 1 km² heightfield generated from the match seed
  alone — nothing is shipped, and server and client compute the identical
  ground — plus hand-placed buildings and walls that stop both rounds and
  people. Cover is authored for one half of the map and mirrored, so
  asymmetry is unrepresentable.
- **Casualties**: downed, revivable, and draggable to somewhere safer. A body
  on the ground is still a target: shooting it again finishes it, which is the
  rule that stops a squad reviving each other faster than anyone can kill them.

The M0/M1 hit-probability stand-in is gone. Everything above it — tickets,
FOBs, capture, logistics — was untouched by the swap, which is what building
the rules engine first was for.

## Netcode

Server authoritative at 20 Hz, snapshots at 10 Hz, per PLAN §4. The client
predicts its own movement and replays unacknowledged input over each
correction; everyone else is interpolated one snapshot interval in the past.
Snapshots are culled at 500 m and diffed per entity, and tracers are culled
separately because gunfire is the highest-volume and most local event there is.

Hit registration is lag-compensated: each shot rewinds the world up to a second
to what the shooter was actually looking at. The client's claimed render tick is
clamped into that window, so it cannot pick its own moment in history.

The diagnostics panel in the top-right is the thing to watch: **prediction
error** should sit at 0.00 m. Anything else means the client and server
disagree about movement, which is a bug rather than a network condition.

## Known gaps

- **Deep raids barely work, and that is a fact about the combat model.** Bots
  now detach a raiding party to hunt enemy radios, and it lands a kill in about
  1.4% of matches. The reason it is not higher: the M0/M1 combat stand-in has
  no cover, no concealment and no suppression, so hit chance is purely a
  function of range and the last 200 m to a defended radio is an open-field
  fight against equal numbers. There is no mechanism by which infiltration
  could work yet. M3's suppression should change this, and the FOB-lifetime
  figures should be re-read then; today they are thin rather than wrong.
- Vehicles exist and work, but nothing in the client renders their interior or
  seat assignment — you can drive and haul supply, and that is all.
- JSON on the wire. Fine at this scale, and the first thing to change if the
  bandwidth number starts climbing.

## Legal

Game mechanics, rules and numbers are not copyrightable, and the design table in
`PLAN.md` is transcribed from publicly documented conventions of the genre. No
names, logos, maps, models, textures, audio, UI art or code from any commercial
game are used here. The map, its place names and the project name are original.
