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
| **M1** — layered bots and balance harness | batch harness done, bots are a placeholder driver |
| **M2** — authoritative server + 2D playable client | **done** |
| M3 — 3D first person | not started |
| M4 — vehicles and logistics in 3D | not started |

## Play it

```bash
./run.sh setup   # first time only
./run.sh play    # starts the server and the client
```

Then open <http://localhost:5173/>. You take over a soldier a bot was already
playing; the rest of both teams stay under bot control. WASD to move, click to
engage, `/` for the full key list.

## Watch it instead

```bash
./run.sh              # one match, headless, prints a battle report
./run.sh batch 1000   # balance statistics over a thousand matches
./run.sh test         # unit, property and balance-gate tests
./run.sh check        # typecheck, then tests
```

A 1000-match run takes about 40 seconds and currently reports a 49.8% / 50.2%
win split with a mean match length of 42.6 minutes.

## Layout

```
packages/
  core/       pure deterministic rules engine — no rendering, network, I/O or clocks
  bots/       decision layer: reads state, returns commands. fills empty slots
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

Combat is a hit-probability stand-in, not ballistics — real projectiles,
suppression and lag-compensated hit registration are M3's job and are meant to
drop in without touching anything above.

## Netcode

Server authoritative at 20 Hz, snapshots at 10 Hz, per PLAN §4. The client
predicts its own movement and replays unacknowledged input over each
correction; everyone else is interpolated one snapshot interval in the past.
Snapshots are culled at 500 m and diffed per entity, which currently costs
about 13 KB/s per client against a 30 KB/s budget.

The diagnostics panel in the top-right is the thing to watch: **prediction
error** should sit at 0.00 m. Anything else means the client and server
disagree about movement, which is a bug rather than a network condition.

## Known gaps

- `packages/bots` is still the M0 placeholder driver. It plays the objective
  and runs the logistics loop competently, but it never assaults an enemy FOB,
  so FOB destruction — a rule that works and is unit-tested — is not exercised
  in batch statistics, and the FOB-lifetime and radio-ticket figures in those
  statistics are therefore unmeasured rather than good.
- No squad leader, human or bot, ever repositions a FOB as the front moves.
- Vehicles exist and work, but nothing in the client renders their interior or
  seat assignment — you can drive and haul supply, and that is all.
- JSON on the wire. Fine at this scale, and the first thing to change if the
  bandwidth number starts climbing.

## Legal

Game mechanics, rules and numbers are not copyrightable, and the design table in
`PLAN.md` is transcribed from publicly documented conventions of the genre. No
names, logos, maps, models, textures, audio, UI art or code from any commercial
game are used here. The map, its place names and the project name are original.
