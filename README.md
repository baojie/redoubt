# redoubt

A tactical team-shooter built rules-first, inspired by Squad and Project Reality.

The premise, from `ref/PLAN.md`: what makes this genre work is not gunplay, it is that
**respawns are a scarce resource and logistics decide who has them.** So the
rules engine comes first and the graphics come last. The rules engine is the
whole game; the first-person client is a view into it.

## Where it is

| Milestone | State |
|---|---|
| **M0** — deterministic rules engine + headless match report | **done** |
| **M1** — layered bots and balance harness | **done** |
| **M2** — authoritative server + 2D playable client | **done** |
| **M3** — 3D first person, real ballistics | **done** |
| **M4** — vehicles and logistics in 3D | **playable** |

## Play it

```bash
./run.sh setup   # first time only
./run.sh play    # starts the server and the client
```

Then open <http://localhost:5173/>. You take over a soldier a bot was already
playing; the rest of both teams stay under bot control.

It opens in first person: click to capture the mouse, WASD to move, mouse to
look, left click to fire, **right click to aim down the sights**, `R` to
reload, `4` to throw one of your three grenades. Stand over a downed teammate
and `F` revives them, `Q` drags them somewhere safer first. `Tab` switches to
the top-down map view — which is the whole M2 client, still running on the same
connection, not a minimap. `/` for the full key list.

If your machine has no WebGL the page falls back to the map view rather than
breaking; the map view is a complete client on its own.

### Play it with friends on a LAN

Everyone joins the same server; each browser tab is a player, and the server
puts people on whichever team is emptier.

```bash
./run.sh play
```

Then find your machine's LAN address (`ip addr`, or the "Network" lines vite
prints when it starts), and have friends open:

```
http://<your-LAN-ip>:5173/
```

The page binds all interfaces (`host: true` in `vite.config.ts`) and the game
server listens on `:8787` on all interfaces too. The client derives the server
URL from the page's own hostname, so a friend who opens your IP connects back
to your machine automatically — no per-player setup. The join screen takes a
name; there is no team picker yet, the server balances sides for you.

To point at a different server (e.g. a remote box), override it:

```
http://<host>:5173/?server=ws://<game-server>:8787
```

The two TCP ports that must be open in the host's firewall are **5173** (page)
and **8787** (game server).

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
  client/     Three.js first-person client + top-down map view. predicts, never decides
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
- **Grenades**: every soldier carries three, arcing and bouncing off geometry,
  and they come back as an actual explosion in the snapshot — visible, audible,
  and fatal in the right room. Fuse is long enough to cook, short enough to
  punish holding.
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
- **Vehicles**: driven directly with throttle and wheel, destructible, and
  solid — a truck parked across a street is cover for whoever is behind it.
  Armour shrugs off small arms, which is what the anti-tank emplacement is
  for. Repair stations mend them out of the FOB's construction points.

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
  1.4% of matches. That figure predates M3 — cover, concealment and suppression
  all exist now, and the raid numbers have not been re-read since. The last
  200 m to a defended radio is still open ground against equal numbers, and
  suppression helps the defender hold ground as much as it helps the assault.
  The FOB-lifetime figures should be re-read once real fire teams land; today
  they are thin rather than wrong.
- Vehicles have no interior: the one you are riding in is hidden rather than
  modelled, and passengers cannot shoot out.
- JSON on the wire. Fine at this scale, and the first thing to change if the
  bandwidth number starts climbing.

## Assets

Four small models, all from the Quaternius library on Poly Pizza: the soldier,
the supply truck, the armoured pickup, and the rifle every soldier carries. The
soldier is CC-BY 3.0 — attribution is required, and that is what `ATTRIBUTION.md`
exists for; the rest are CC0. Everything else, terrain included, is generated
at runtime from the match seed.

The models are optional: if one fails to load the client draws that thing from
primitives instead. A missing art asset should cost fidelity, not the ability
to see the enemy.

## Legal

Game mechanics, rules and numbers are not copyrightable, and the design table in
`ref/PLAN.md` is transcribed from publicly documented conventions of the genre. No
names, logos, maps, models, textures, audio, UI art or code from any commercial
game are used here. The map, its place names and the project name are original.

## Changelog

See `CHANGELOG.md` for the full history.
