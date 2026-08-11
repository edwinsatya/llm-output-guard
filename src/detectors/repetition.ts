import { words, clamp01 } from '../internal/tokenize.js';

export interface RepetitionOptions {
  /** N-gram size. 3 suits prose; 2 is noisy, 4 misses short loops. */
  n?: number;
  /** Only analyse the first N characters. Keeps cost bounded on long outputs. */
  maxSample?: number;
}

/**
 * Fraction of n-grams that are duplicates. 0 = every n-gram unique, 1 = total collapse.
 *
 * Healthy prose sits near 0.00-0.10. A model stuck in a loop passes 0.5 quickly.
 * Returns 0 for text too short to judge rather than guessing.
 */
export function repetitionScore(text: string, options: RepetitionOptions = {}): number {
  const { n = 3, maxSample = 8000 } = options;
  const w = words(text.slice(0, maxSample));
  if (w.length < n * 4) return 0;

  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i + n <= w.length; i++) {
    seen.add(w.slice(i, i + n).join(' '));
    total++;
  }
  if (total === 0) return 0;
  return clamp01(1 - seen.size / total);
}

export interface TailLoopOptions {
  /** How many trailing words to inspect. */
  tailWords?: number;
  /** Longest loop period to look for, in words. */
  maxPeriod?: number;
  /** A block must repeat at least this many times to count as a loop. */
  minRepeats?: number;
}

/**
 * Detects the specific failure where a model terminates in a repeating tail --
 * the same clause emitted over and over until max_tokens runs out.
 *
 * Whole-output repetition misses this when the first half of the response was fine.
 * Returns the fraction of the inspected tail covered by the loop.
 */
export function tailLoopScore(text: string, options: TailLoopOptions = {}): number {
  const { tailWords = 200, maxPeriod = 40, minRepeats = 3 } = options;
  const all = words(text);
  const tail = all.slice(-tailWords);
  if (tail.length < minRepeats * 2) return 0;

  let best = 0;
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
      best = Math.max(best, clamp01((repeats * p) / tail.length));
    }
  }
  return best;
}
