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
| M2 — authoritative server + 2D client | not started |
| M3 — 3D first person | not started |
| M4 — vehicles and logistics in 3D | not started |

## Try it

```bash
pnpm install
pnpm sim --seed 42       # play one match, print a battle report
pnpm sim --matches 1000  # balance statistics over a thousand matches
pnpm test                # unit, property and balance-gate tests
pnpm typecheck
```

A 1000-match run takes about 40 seconds and currently reports a 49.8% / 50.2%
win split with a mean match length of 42.6 minutes.

## Layout

```
packages/
  core/   pure deterministic rules engine — no rendering, network, I/O or clocks
  sim/    headless match runner, battle report, batch balance statistics
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

## Known gaps

- The match driver in `packages/sim/src/driver.ts` is a placeholder for M1's
  real bots. It plays the objective and runs the logistics loop competently,
  but it never assaults an enemy FOB, so FOB destruction — a rule that works
  and is unit-tested — is not being exercised in batch statistics.
- No squad leader ever repositions a FOB as the front moves.

## Legal

Game mechanics, rules and numbers are not copyrightable, and the design table in
`PLAN.md` is transcribed from publicly documented conventions of the genre. No
names, logos, maps, models, textures, audio, UI art or code from any commercial
game are used here. The map, its place names and the project name are original.
