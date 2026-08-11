import type { CheckOptions } from './types.js';

/**
 * Starting configurations. Tuned against the fixture corpus in test/fixtures,
 * so treat them as calibrated defaults rather than arbitrary numbers -- and
 * still re-tune against your own traffic before trusting them in production.
 */
export const presets = {
  /** Conversational replies. Tolerant of quoted or listed repetition. */
  chat: {
    minLength: 12,
    maxRepetition: 0.4,
    maxTailLoop: 0.5,
    maxCompressibility: 0.75,
  } satisfies CheckOptions,

  /** Structured output. Parseability is non-negotiable; prose checks relax. */
  strictJson: {
    minLength: 2,
    expectJson: true,
    maxRepetition: 0.6,
    maxTailLoop: 0.6,
    maxCompressibility: null,
    maxTruncation: 0.75,
  } satisfies CheckOptions,

  /** Long-form generation, where truncation matters most. */
  longForm: {
    minLength: 200,
    maxRepetition: 0.35,
    maxTailLoop: 0.4,
    maxCompressibility: 0.7,
    maxTruncation: 0.75,
  } satisfies CheckOptions,

  /** Catches only unambiguous garbage. Use when false positives cost more than misses. */
  lenient: {
    minLength: 1,
    maxRepetition: 0.7,
    maxTailLoop: 0.7,
    maxCompressibility: 0.9,
  } satisfies CheckOptions,
} as const;
