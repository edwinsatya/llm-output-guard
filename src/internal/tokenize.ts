import type { TokenMode } from '../types.js';

/**
 * Word tokenizer for scripts that separate words -- with spaces, punctuation,
 * or anything else that is not a letter or digit. Latin, Cyrillic, Greek,
 * Hangul, Arabic, Devanagari and friends all tokenize correctly here.
 *
 * It does *not* work for Han, Kana or Thai. Those write without inter-word
 * spaces, so a whole punctuation-delimited clause matches as one token, and a
 * loop with no punctuation inside it matches as one token for the entire
 * response. See {@link nonSpacedRatio} for how that case is detected and
 * `tailLoopScore` for what runs instead.
 */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/** Character tokens, whitespace dropped. The fallback where `words` cannot see. */
export function chars(text: string): string[] {
  return [...text.replace(/\s+/g, '')];
}

/** Scripts that do not put spaces between words. */
const NON_SPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/gu;

/**
 * Share of a span written in a script `words()` cannot tokenize, 0..1.
 *
 * The denominator counts marks as well as letters on purpose.
 * `\p{Script=Thai}` matches Thai vowel and tone marks, which are `\p{M}` and
 * not `\p{L}` -- so counting `\p{L}` underneath returned ratios above 1 for
 * Thai and made any cutoff meaningless there. Numerator and denominator have
 * to count the same set.
 */
export function nonSpacedRatio(text: string): number {
  const total = text.match(/[\p{L}\p{M}]/gu)?.length ?? 0;
  if (total === 0) return 0;
  return (text.match(NON_SPACED)?.length ?? 0) / total;
}

/**
 * Which tokenizer suits this span.
 *
 * Decide it from the span a detector actually reads, never from the whole
 * response. A reply that answers in English and then loops in Chinese measures
 * 0.35 overall and 1.00 across its tail: judging the tail by the whole
 * response's ratio puts the tail detector in word mode on text that has no
 * words in it, which is the exact failure this dispatch exists to prevent.
 */
export function tokenModeOf(text: string, cutoff = 0.5): TokenMode {
  return nonSpacedRatio(text) >= cutoff ? 'char' : 'word';
}

/** Clamp a raw signal into the 0..1 suspicion range. */
export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Short, safe excerpt for messages. Never leaks a full response into logs. */
export function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max) + '\u2026';
}
