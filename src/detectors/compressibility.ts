import { clamp01 } from '../internal/tokenize.js';

export interface CompressibilityOptions {
  /** Sliding window for back-references, in characters. */
  window?: number;
  /** Only analyse the first N characters. */
  maxSample?: number;
  /** Shortest back-reference worth emitting. */
  minMatch?: number;
}

/**
 * Greedy LZ77 pass returning emitted-tokens / input-characters.
 *
 * Deliberately hand-rolled instead of node:zlib so the package stays
 * runtime-agnostic (browser, edge, Deno, Bun) and dependency-free.
 * This is not a real compressor; it only needs to move monotonically
 * with redundancy, which is all the score requires.
 *
 * Measured against the fixture corpus: healthy output lands at 0.67-0.97,
 * degenerate collapse at 0.007-0.042, and tail loops in between at 0.17-0.20.
 * The gap either side of that middle band is what the pivot below trades on.
 */
export function compressionRatio(text: string, options: CompressibilityOptions = {}): number {
  const { window = 1024, maxSample = 4000, minMatch = 4 } = options;
  const s = text.slice(0, maxSample);
  if (s.length < 64) return 1;

  let i = 0;
  let emitted = 0;
  while (i < s.length) {
    let bestLen = 0;
    const start = i > window ? i - window : 0;
    for (let j = start; j < i; j++) {
      let k = 0;
      while (k < 255 && i + k < s.length && s[j + k] === s[i + k]) k++;
      if (k > bestLen) {
        bestLen = k;
        if (bestLen >= 255) break;
      }
    }
    emitted++;
    i += bestLen >= minMatch ? bestLen : 1;
  }
  return emitted / s.length;
}

/**
 * Suspicion score derived from {@link compressionRatio}.
 * `pivot` is the ratio treated as fully healthy; lower ratios scale up toward 1.
 *
 * At the default 0.32 every healthy fixture clamps to exactly 0, with the
 * nearest one still twice the pivot away -- so this detector is deliberately
 * tuned for outright entropy collapse and abstains on everything milder.
 * Tail loops score 0.37-0.48 here and are left to `tailLoopScore`, which
 * separates them far more cleanly (0.90 against a healthy max of 0.00).
 * Raising the pivot would make this fire on loops too, buying redundant
 * coverage with the margin that currently makes a false positive so unlikely.
 */
export function compressibilityScore(
  text: string,
  options: CompressibilityOptions & { pivot?: number } = {},
): number {
  const { pivot = 0.32, ...rest } = options;
  if (text.trim().length < 64) return 0;
  return clamp01(1 - compressionRatio(text, rest) / pivot);
}
