# Squad-like tactical FPS replica — plan

> Audience: Claude Code. Drop this file into the root of an empty repository,
> rename it to `PLAN.md`, and have Claude Code execute it milestone by
> milestone.

---

## 0. Core judgement: what to copy first

A saying floats around the Squad community — that it is **a scoring game
disguised as a tactical game**. What sets it apart from other FPS games is not
the gunplay, but this:

**Respawn rights are a scarce resource, and respawn rights are decided by
logistics.**

- When you die, your team loses 1 ticket. Tickets are finite; at zero the team
  loses.
- Where you respawn depends on whether the squad leader laid down a rally
  point and whether the team trucked supplies to the front to build a FOB/HAB.
- So the outcome of a match is an economics problem of "whose respawn point is
  closer to the front and survives longer", not a gunplay problem.

**Conclusion: the priority order should be "rules economy → bot validation →
network sync → first-person shooting → graphics", not the other way around.**

Most "I'm going to make a Squad" projects die on the very first step by
hand-building a 3D character controller and gun recoil, and after three months
they have a shooting demo nobody wants to play a second match of. This plan
deliberately does the reverse.

---

## 1. Scope trimming (realities that must be accepted)

| Dimension | Real Squad | This project's target |
|---|---|---|
| Player count | 50v50 | **8v8 or 12v12**, shortfall filled by bots |
| Map | 2×2 km ~ 4×4 km | **1×1 km** |
| Engine | Unreal Engine | TypeScript full stack (see §3) |
| Vehicles | dozens, helicopters included | 2: logistics truck + light armoured vehicle |
| Factions | a dozen-plus, each with its own loadouts | 2 symmetric factions |
| Voice | built-in proximity + radio | Phase 5 optional, WebRTC |

Reasons for trimming:

1. **Technical ceiling**: Godot's built-in replication hits bandwidth and CPU
   walls past 32 players; even hand-rolled netcode, an authoritative 100-player
   server is an engineering problem of another magnitude.
2. **Social dynamics cannot be copied**: half of Squad's fun is nine-person
   squad voice coordination and squad-leader command. At the prototype stage
   there is no one to test with 100 people; 8v8 + bots is the scale you can
   iterate on repeatedly.
3. **Maps are the most expensive asset**: one Squad map is months of art work.
   1 km² procedural generation plus a handful of hand-placed landmarks is the
   only viable path.

---

## 2. Numbers table (copy it directly — this is the cheapest "already-validated
design" you will find)

The following values come from the Squad official wiki and community guides.
**Game mechanics and numbers are not copyrightable and can be used freely**;
what you may not use are names, logos, maps, models, sounds, and UI art (see
§8).

### 2.1 Tickets

| Event | Ticket change |
|---|---|
| Infantry death (bleed-out / give-up / forced respawn) | −1 |
| Commander death | −2 |
| FOB radio destroyed | −20 |
| Vehicle loss | by type (light −5, armoured −10~−20, tunable) |
| First capture of a never-occupied point | +20 |
| One side holds every control point → opposing **mercy bleed** | 60 tickets drained evenly over 60 s |
| Both sides neutralise each other's defence points (double neutral) | **all bleed paused** until the stalemate breaks |

Suggested starting tickets: 300 (the order of magnitude of vanilla AAS/RAAS).

### 2.2 Control points and RAAS

- Both teams start from main bases at the two ends of the map; between them
  sits a string of control points.
- **Must be taken in order**: you cannot capture the next point until the
  previous one is yours. Attack / Defence markers on the map show the way.
- **RAAS (Random AAS)**: each match draws one lane at random from a preset
  set of control-point connection graphs, and the full route is not revealed
  at the start — this is the key to playability, it forces recon and on-the-fly
  decisions.
- Capture rules: friendly presence outnumbering the enemy for a sustained time
  inside the point → neutralise → capture. Suggested parameters: radius 100 m,
  neutralise 30 s, capture 30 s, each extra friendly soldier accelerating the
  count.

### 2.3 Rally point (squad spawn)

- Placed by the **squad leader**, requires ≥1 teammate within 8 m (versions
  differ between 1 and 2 people; take 1).
- Costs **50 ammo** (replenished from ammo bags / vehicles / FOB ammo boxes).
- **Only your own squad can use it**; has a **wave cooldown** (roughly one
  wave per 60 s).
- Costs no construction points, no tickets, needs no build action, and can be
  picked back up and re-placed.
- **Bullets and explosions cannot destroy it**; only an enemy walking onto it
  can disable it.
- Design intent: this is the "cheap but fragile" spawn point, opposite to the
  FOB's "expensive but sturdy". The tension between the two is the engine of
  the whole tactical layer.

### 2.4 FOB / HAB (forward operating base and spawn bunker)

```
FOB Radio Hub
  ├─ Placement: squad leader + 2 teammates within 15 m
  ├─ ≥ 400 m from any other friendly FOB
  ├─ ≥ 150 m from main base
  ├─ Starts at 0 CP (construction) / 0 AP (ammo); must be supplied by truck
  ├─ Cap of 20000 CP + 20000 AP
  └─ Build radius 150 m — inside it you can build:
       ├─ HAB (spawn bunker)     500 CP   ← 1 per FOB
       ├─ Ammo box               100 CP
       ├─ Heavy machine gun      200~350 CP
       ├─ Anti-tank missile      600 CP + 500 AP
       └─ Repair station         500 CP
  → so "a usable FOB" costs at least 600 CP (HAB + ammo box)
```

**HAB rules (the single most important rule)**:

- The whole team can respawn here, with a 45 s respawn delay, no wave limit.
- **Build time shrinks with more builders**: one builder takes 40 s before
  respawns open; five builders together take only 4 s. → This rule directly
  creates the "build first, then fight" team-coordination pressure — implement
  it.
- **Overrun**: 2 enemies within 20 m, or 8 within 80 m → the HAB turns red and
  respawning is disabled until the enemy is cleared. A damaged radio also
  causes overrun.
- Radio destroyed → every tech structure in its radius (HAB, ammo boxes,
  repair stations) and weapon emplacement **vanishes at once**; pure works
  like sandbags survive.
- Dismantling your own radio costs no tickets — the correct move when your
  position is exposed.

### 2.5 Logistics

- The logistics truck loads supplies at main base, with the driver choosing
  the CP/AP split (typically 1200 CP + 1800 AP, enough for 2 FOBs).
- Drive to the front, unload inside the FOB build radius. FOB-to-FOB transfer
  is also possible.
- Loading and unloading is impossible while moving.
- **This is the heartbeat of the whole game.** Whether logistics run well
  decides the match. Bots must be able to run logistics, or every balance test
  is fake.

---

## 3. Tech stack

### Recommended: a TypeScript monorepo

```
squad-like/
├─ packages/
│  ├─ core/        pure rules engine: no rendering, no network, no I/O, deterministic
│  ├─ server/      authoritative server: Node + uWebSockets.js + Rapier3D
│  ├─ client/      Three.js client (2D top-down first, then 3D first person)
│  ├─ bots/        bot AI (runs server-side)
│  └─ sim/         headless batch matches + balance statistics CLI
├─ CLAUDE.md
└─ PLAN.md         (this file)
```

**Why TypeScript rather than Godot / Unreal:**

| | TypeScript + Three.js | Godot 4 | Unreal 5 |
|---|---|---|---|
| Driveable by Claude Code | ★★★ fully textual, unit-testable, headless | ★★ .tscn scene files need an editor | ★ Blueprint is essentially non-automatable |
| Linux native | ★★★ | ★★★ | ★ painful |
| Headless automated tests | ★★★ vitest runs a thousand matches in seconds | ★★ `godot --headless` works but is slow | ★ |
| 3D graphics ceiling | ★★ | ★★★ | ★★★ |
| Network sync | you write it (controllable) | built-in replication can't hold 32+ players; needs netfox | ★★★ industrial-grade |
| Sharing with others | ★★★ just send a URL | ★★ must package a build | ★ |

The key trade-off: **what you want is "a playable system Claude Code can
iterate on efficiently", not "a commercial FPS that meets the graphics bar".**
TypeScript dominates at the former and loses at the latter.

**Stack-escape hatch**: `packages/core` must be pure logic, zero dependencies,
with all rule constants concentrated in one `rules.ts`. If you ever migrate to
Godot, this layer can be rewritten one-for-one in GDScript or C#, or a Godot
client can simply connect to the Node server. **This is the one architectural
constraint in this plan that cannot be compromised.**

### Key libraries

- **Physics / ballistics**: `@dimforge/rapier3d-compat` (same copy on server
  and client, WASM)
- **Network**: `uWebSockets.js` first (WebSocket, good enough); switch to
  `geckos.io` (WebRTC unreliable UDP) in Phase 4 if latency becomes the
  bottleneck
- **Rendering**: `three` (r184+)
- **Tests**: `vitest` + `fast-check` (property tests)
- **Open-source implementations to read** (learn the architecture, do not
  fork):
  - `MavonEngine/Core` — Three.js + Rapier3D + geckos.io, server/client shared
    entity classes, Source-engine-style tick command buffering; the closest
    existing reference to this plan
  - `iErcann/Notblox` — Three.js + Node authoritative server, includes vehicle
    physics
  - `foxssake/netfox` — if you end up on Godot, use it for client
    prediction/rollback

---

## 4. Network model

The standard triple, following Valve/Source practice:

1. **Server authoritative, 20 Hz tick.** Every rule adjudication runs once,
   only in `core`.
2. **Client prediction**: respond to input locally and immediately, sending
   the server sequence-numbered input at the same time.
3. **Server reconcile + replay**: the server's reply carries "the last input
   sequence number I processed"; the client adopts the authoritative state and
   replays unacknowledged input over it.
4. **Other players interpolated**: rendered 100 ms in the past, smooth.
5. **Lag-compensated hit detection**: the server keeps ~1 s of position
   history per player and rewinds the world to the moment the client actually
   saw it before adjudicating a shot.

Bandwidth budget: **cull entities by distance** (nothing sent beyond 500 m),
send only deltas (dirty-bit detection + hashing). At 12 players the target is
< 30 KB/s per client.

---

## 5. Milestones (this is the task breakdown for Claude Code)

Every milestone must have a **runnable acceptance criterion**; do not move on
until it is met.

### M0 — Rules engine (no rendering, no network)

**Output**: `packages/core` + `packages/sim`; one CLI command runs a complete
match and prints a text battle report.

- [ ] `rules.ts`: every §2 constant lives here; not one magic number scattered
      anywhere else
- [ ] Entity model: Player / Squad / Team / ControlPoint / RallyPoint / FOB /
      Deployable / Vehicle / Supply
- [ ] State machines: tickets, control-point capture (incl. double neutral and
      mercy bleed), random RAAS lane draw
- [ ] Full FOB lifecycle: placement validation (400 m / 150 m / 15 m distance
      constraints) → supply → construction (builder speed-up) → overrun
      adjudication → destruction cascade
- [ ] Rally point: placement, ammo cost, wave cooldown, enemy-proximity disable
- [ ] Logistics: load split, transport, unload, FOB-to-FOB transfer
- [ ] **Determinism**: `Math.random()` / `Date.now()` are forbidden inside
      `core`; everything goes through the injected seeded RNG and tick count.
      The same seed + the same input sequence must produce bit-identical state
      every tick.
- [ ] Unit tests cover every §2 rule; `fast-check` property tests guarantee
      the invariants (tickets monotonic, CP never negative, FOB distance
      constraints never violated)

**Acceptance**: `pnpm sim --seed 42` prints a complete battle report for one
match (per-minute tickets, control-point handovers, FOB built/destroyed log),
reproducibly.

### M1 — Bots and balance

**Output**: `packages/bots` + batch match statistics.

- [ ] Layered bots: soldier (move / fight / build), squad leader (place rally,
      choose FOB positions), logistics (run the supply loop)
- [ ] Simplified combat resolution (no ballistics needed at this stage; use a
      hit-probability model)
- [ ] `pnpm sim --matches 1000` prints: mean match length, ticket curves, mean
      FOB lifetime, rally usage, win/loss distribution

**Acceptance**: 1000 matches, no crashes, no deadlocks; mean match length in
the 30–60 minute band; both sides between 45% and 55% win rate. **If this is
not met, either the copied numbers are wrong or the implementation has a bug —
go back to M0 and fix it, do not push forward.**

### M2 — Authoritative server + playable 2D client

**Output**: a 2D top-down build real humans can connect to and fight in
alongside bots.

- [ ] Server: 20 Hz tick, input queue, state snapshots, distance culling
- [ ] Client: Canvas 2D top-down view (i.e. Squad's map screen), WASD movement,
      click to shoot, squad-leader command panel
- [ ] Human/bot mix: humans take slots, the rest stay under bot control
- [ ] Network diagnostics HUD: ping, bandwidth, tick deviation, prediction error

**Acceptance**: 4 humans + 12 bots finish a match with no disconnects and no
state drift. At this point the game **is already playable** — this is the most
important milestone in the plan: it proves the fun comes from the rules, not
the graphics.

### M3 — 3D first person

- [ ] Three.js scene + Rapier character controller + first-person camera
- [ ] Weapons: fire rate, recoil, bullet drop, reload, optics
- [ ] Server-side lag-compensated hit detection
- [ ] Wounded / downed / drag / medical rescue (Squad's downed system gives
      teammates a rescue window; it is the team glue — must do)
- [ ] Suppression effect: rounds flying past → blurred vision + more recoil.
      **This is the soul of Squad's feel, far more important than weapon
      models.**
- [ ] Procedural 1 km² terrain + a handful of hand-placed landmark buildings

### M4 — Vehicles and logistics

- [ ] Logistics truck (Rapier vehicle physics) + light armoured vehicle
- [ ] Load / unload UI, multi-player vehicle seats
- [ ] Vehicle destroyed → tickets; repair station

### M5 — Team-coordination layer (optional)

- [ ] WebRTC proximity voice + squad-leader channel
- [ ] Commander role: global resources, airdropped supplies, recon drone
- [ ] Map marking system

---

## 6. The `CLAUDE.md` for Claude Code (use this directly)

```markdown
# Project constraints (non-negotiable)

## Architecture
- `packages/core` is a pure-function rules engine: it must not import any
  rendering, networking, filesystem, or timer module. It must not use
  `Math.random()`, `Date.now()`, or `performance.now()`. Randomness may only
  come from an injected seeded RNG; time may only come from the tick counter.
- All gameplay numeric constants must be defined in `packages/core/src/rules.ts`.
  A bare number (other than 0/1/-1) anywhere else is a bug.
- The server is the single authority. The client may predict, but the client's
  computed results are never written back to authoritative state.

## Invariants (must hold after every change; written as property tests)
1. At any moment, either team's tickets are ≥ 0 and monotonic non-increasing
   (except for explicit ticket-gain events)
2. Distance between FOBs is always ≥ 400 m; FOB-to-main is always ≥ 150 m
3. FOB CP/AP always lies in [0, 20000]
4. Control-point capture order always obeys the current lane's topology
5. Same seed + same input sequence → per-tick bit-identical state hash

## Test gates
Must pass before every commit:
- `pnpm test` (unit + property tests)
- `pnpm sim --matches 100` (100 headless matches, zero crashes, zero deadlocks,
  mean match length in the 30–60 minute band)
State hashes are written to snapshot files and compared on regression.

## Forbidden
- "Squad" must not be used as the project, module, or class name, or in any
  user-visible text
- No art, audio, or map data from Squad or any other commercial game
- Do not modify tests or relax invariants to make tests pass; fix the
  implementation first
```
