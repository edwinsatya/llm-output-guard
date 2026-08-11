import { words } from '../internal/tokenize.js';

/**
 * 1 when the response carries no usable content at all.
 *
 * Covers the cases a plain `!text` check misses: whitespace-only, a lone
 * punctuation mark, an empty code fence, or an empty JSON envelope.
 */
export function emptinessScore(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 1;
  if (words(trimmed).length === 0) return 1;
  const stripped = trimmed
    .replace(/```[a-z]*\s*```/gi, '')
    .replace(/^[{}[\]"'\s,.:;!?-]+$/g, '');
  return stripped.trim().length === 0 ? 1 : 0;
}

/** 1 when the response is shorter than `minChars`, scaling down to 0 at the threshold. */
export function shortnessScore(text: string, minChars: number): number {
  if (minChars <= 0) return 0;
  const len = text.trim().length;
  if (len >= minChars) return 0;
  return 1 - len / minChars;
}
