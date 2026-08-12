import type { CheckOptions } from './types.js';

/**
 * Starting configurations. Tuned against the fixture corpus in test/fixtures,
 * so treat them as calibrated defaults rather than arbitrary numbers -- and
 * still re-tune against your own traffic before trusting them in production.
 *
 * Every preset sets `maxCharTailLoop` as well as `maxTailLoop`. They are not
 * the same number scaled: character n-grams duplicate at a higher base rate, so
 * a char threshold reads roughly 0.2 above its word counterpart for the same
 * strictness. Leaving one null while the other is set is how a script-shaped
 * blind spot gets rebuilt, so none of them do.
 */
export const presets = {
  /** Conversational replies. Tolerant of quoted or listed repetition. */
  chat: {
    minLength: 12,
    maxRepetition: 0.4,
    maxTailLoop: 0.5,
    maxCharTailLoop: 0.7,
    maxCompressibility: 0.75,
  } satisfies CheckOptions,

  /**
   * Structured output. Parseability is non-negotiable; prose checks relax.
   *
   * `maxCompressibility` is null here because a JSON payload is legitimately
   * repetitive at the character level. `maxCharTailLoop` is *not* null for the
   * same reason it is safe to keep: the tail detector needs exact periodicity,
   * which repeated key scaffolding never produces -- a 40-element array of
   * Chinese strings scores 0.000. Nulling it would restore the CJK blind spot
   * on the one preset most likely to be pointed at non-English payloads.
   */
  strictJson: {
    minLength: 2,
    expectJson: true,
    maxRepetition: 0.6,
    maxTailLoop: 0.6,
    maxCharTailLoop: 0.75,
    maxCompressibility: null,
    maxTruncation: 0.75,
  } satisfies CheckOptions,

  /** Long-form generation, where truncation matters most. */
  longForm: {
    minLength: 200,
    maxRepetition: 0.35,
    maxTailLoop: 0.4,
    maxCharTailLoop: 0.6,
    maxCompressibility: 0.7,
    maxTruncation: 0.75,
  } satisfies CheckOptions,

  /** Catches only unambiguous garbage. Use when false positives cost more than misses. */
  lenient: {
    minLength: 1,
    maxRepetition: 0.7,
    maxTailLoop: 0.7,
    maxCharTailLoop: 0.85,
    maxCompressibility: 0.9,
  } satisfies CheckOptions,
} as const;
