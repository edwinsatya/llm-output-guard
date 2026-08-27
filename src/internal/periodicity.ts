import { clamp01 } from './tokenize.js';

export interface PeriodicityOptions {
  /** Longest loop period to look for, in tokens. */
  maxPeriod: number;
  /** A block must repeat at least this many times to count as a loop. */
  minRepeats: number;
  /**
   * Tokens required before the search will judge at all. Defaults to
   * `minRepeats * 2`.
   *
   * Callers whose tokens are expensive want a lower floor than callers whose
   * tokens are characters. An agent turn is a whole model call, so five
   * identical ones is a great deal of evidence; five identical characters is
   * none. The default preserves the character and word behaviour exactly.
   */
  minSample?: number;
}

export interface PeriodicityResult {
  /** Fraction of the inspected window covered by the repeating block, 0..1. */
  score: number;
  /** Length of the repeating block, in tokens. 0 when nothing repeated. */
  period: number;
  /** How many times it repeated. 0 when nothing repeated. */
  repeats: number;
}

/**
 * Largest share of `tail` covered by a block repeating to its end, with the
 * block that produced it.
 *
 * Tokenizer-agnostic on purpose. Word tokens, characters and agent-turn
 * fingerprints are three different granularities asking one question -- does
 * this sequence end in an exact cycle -- and a second copy of this search is
 * how two of them quietly stop agreeing. What differs per caller is the
 * tokens, the period cap and the floor, which are the arguments.
 *
 * Requires *exact* periodicity, which is what makes it safe on structured
 * output: repeated key scaffolding, a repeated preamble or a repeated tool name
 * never produce it unless the whole block repeats.
 */
export function periodicDetail(
  tail: readonly string[],
  { maxPeriod, minRepeats, minSample = minRepeats * 2 }: PeriodicityOptions,
): PeriodicityResult {
  const none: PeriodicityResult = { score: 0, period: 0, repeats: 0 };
  if (tail.length < minSample) return none;

  let best = none;
  const periodCap = Math.min(maxPeriod, Math.floor(tail.length / minRepeats));
  for (let p = 1; p <= periodCap; p++) {
    const block = tail.slice(tail.length - p);
    let repeats = 1;
    let cursor = tail.length - p;
    while (cursor - p >= 0) {
      let same = true;
      for (let k = 0; k < p; k++) {
        if (tail[cursor - p + k] !== block[k]) { same = false; break; }
      }
      if (!same) break;
      repeats++;
      cursor -= p;
    }
    if (repeats >= minRepeats) {
      const score = clamp01((repeats * p) / tail.length);
      if (score > best.score) best = { score, period: p, repeats };
    }
  }
  return best;
}

/** {@link periodicDetail} without the block, for callers that only want the score. */
export function periodicCoverage(
  tail: readonly string[],
  options: PeriodicityOptions,
): number {
  return periodicDetail(tail, options).score;
}
