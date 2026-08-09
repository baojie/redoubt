# Project constraints (non-negotiable)

Project codename **redoubt**. Full plan in `PLAN.md`; milestone breakdown in its §5.

## Architecture
- `packages/core` is a pure-function rules engine: it must not import any
  rendering, networking, filesystem, or timer module. It must not use
  `Math.random()`, `Date.now()`, or `performance.now()`. Randomness may only
  come from an injected seeded RNG; time may only come from the tick counter.
- All gameplay numeric constants must be defined in `packages/core/src/rules.ts`.
  A bare number (other than 0/1/-1) anywhere else is a bug.
- The server is the single authority. The client may predict, but the client's
  computed results are never written back to authoritative state.

### Two exemptions to the "bare number" rule above
1. `packages/core/src/maps/*.ts` is **map geometry data** (control-point
   coordinates, main-base positions, lane topology), not tunable numbers.
   Coordinates in data files are fine, but any quantity with rule meaning
   (radius, duration, cost) must still come from `rules.ts`.
2. Bitwise constants (FNV hash prime/offset, RNG multiplier) are algorithm
   definitions; they live inside `rng.ts` / `hash.ts`, not in `rules.ts`.

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

## Documentation and commit language
- README, CHANGELOG, and daily logs must be written in English.
- Commit messages must be in English.
- Committed history (Chinese commits, Chinese comments) is not rewritten; this
  convention only binds changes going forward.

## Common commands
```
pnpm test                    # vitest: unit + fast-check property + balance gates
pnpm sim --seed 42           # run one match, print a text battle report
pnpm sim --matches 1000      # batch matches + balance stats (~40 s)
pnpm sim --seed 7 --hash     # per-tick state hash, for desync hunting
pnpm typecheck               # tsc type-check only, no build output
```

## Code organization conventions
- `packages/*/src` is implementation, `packages/*/test` is tests; both are
  type-checked.
- Tests that need to drive a whole match go in `packages/sim/test`, not in core —
  core makes no decisions, only adjudicates, and tests should not make it depend
  on sim in reverse.
- Sustained actions (building, rescuing, loading/unloading supplies) accumulate
  **per tick** in core. Any driver layer (bot, server) must re-send these
  commands every tick, otherwise the effective rate is divided by its decision
  frequency.
