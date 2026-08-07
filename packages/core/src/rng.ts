/**
 * Deterministic seeded RNG.
 *
 * `core` must never call Math.random(). Every stochastic decision in the rules
 * engine draws from an instance of this, whose entire state is one uint32, so
 * it serialises into a snapshot and replays bit-identically.
 *
 * Algorithm: mulberry32. Fast, tiny state, good enough distribution for game
 * logic, and — critically — expressible in exact uint32 arithmetic so it gives
 * the same stream on every platform.
 *
 * The magic constants below are part of the algorithm definition, not game
 * balance, so they live here rather than in rules.ts (see CLAUDE.md).
 */

const MULBERRY_INCREMENT = 0x6d2b79f5;
const MIX_SHIFT_A = 15;
const MIX_SHIFT_B = 7;
const MIX_SHIFT_C = 14;
const MIX_MUL_A = 1 | 0;
const MIX_MUL_B = 61 | 0;
const UINT32_DIVISOR = 4294967296;

export interface RngState {
  seed: number;
}

export class Rng {
  private state: number;

  constructor(seed: number) {
    // Force to uint32 so a float or negative seed still behaves.
    this.state = seed >>> 0;
  }

  /** Snapshot the generator so a whole game state can be cloned or hashed. */
  save(): RngState {
    return { seed: this.state };
  }

  /** Restore from a snapshot. */
  static restore(state: RngState): Rng {
    return new Rng(state.seed);
  }

  /** Raw uint32 draw. */
  nextUint32(): number {
    this.state = (this.state + MULBERRY_INCREMENT) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> MIX_SHIFT_A), t | MIX_MUL_A);
    t = (t ^ (t + Math.imul(t ^ (t >>> MIX_SHIFT_B), t | MIX_MUL_B))) >>> 0;
    return (t ^ (t >>> MIX_SHIFT_C)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / UINT32_DIVISOR;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Uniform pick. Returns undefined only for an empty array. */
  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[this.int(0, items.length - 1)];
  }

  /** In-place Fisher-Yates. Deterministic for a given state. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = items[i] as T;
      const b = items[j] as T;
      items[i] = b;
      items[j] = a;
    }
    return items;
  }
}
