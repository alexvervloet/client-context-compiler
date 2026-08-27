/**
 * A seeded generator, so a corpus is reproducible.
 *
 * Every number in the README came from a specific seed. If the generator drew
 * from Math.random the eval suite would be measuring a different firm each run
 * and a regression would be indistinguishable from a reroll.
 */

export type Rng = {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** One element. Throws on an empty array, which is always a bug here. */
  pick<T>(items: readonly T[]): T;
  /** A new array, shuffled. */
  shuffle<T>(items: readonly T[]): T[];
  /** True with probability p. */
  chance(p: number): boolean;
};

/** mulberry32. Small, fast, and good enough for generating fake emails. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));

  const pick = <T,>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)];
    if (item === undefined) throw new Error("pick() from an empty array");
    return item;
  };

  const shuffle = <T,>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      const a = out[i];
      const b = out[j];
      if (a === undefined || b === undefined) throw new Error("shuffle index out of range");
      out[i] = b;
      out[j] = a;
    }
    return out;
  };

  return { next, int, pick, shuffle, chance: (p) => next() < p };
}
