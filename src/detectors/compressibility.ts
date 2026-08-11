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
 * Healthy prose lands around 0.30-0.55. Degenerate output collapses toward 0.
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
 */
export function compressibilityScore(
  text: string,
  options: CompressibilityOptions & { pivot?: number } = {},
): number {
  const { pivot = 0.32, ...rest } = options;
  if (text.trim().length < 64) return 0;
  return clamp01(1 - compressionRatio(text, rest) / pivot);
}
