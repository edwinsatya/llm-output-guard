import type { CheckOptions, Reason, ReasonCode, Verdict } from './types.js';
import { repetitionScore, tailLoopScore } from './detectors/repetition.js';
import { compressibilityScore } from './detectors/compressibility.js';
import { emptinessScore, shortnessScore } from './detectors/emptiness.js';
import { truncationScore } from './detectors/truncation.js';
import { jsonScore } from './detectors/json.js';
import { languageMismatchScore } from './detectors/language.js';
import { excerpt } from './internal/tokenize.js';

const DEFAULTS: Required<
  Pick<CheckOptions,
    'minLength' | 'maxRepetition' | 'maxTailLoop' | 'maxCompressibility' |
    'maxTruncation' | 'expectJson' | 'allowJsonFence' | 'maxLangMismatch' | 'ngram'>
> = {
  minLength: 1,
  maxRepetition: 0.35,
  maxTailLoop: 0.5,
  maxCompressibility: 0.75,
  maxTruncation: null as unknown as number,
  expectJson: false,
  allowJsonFence: true,
  maxLangMismatch: 0.6,
  ngram: 3,
};

/**
 * Runs every enabled detector and returns a structured verdict.
 *
 * Pure and synchronous: no network, no clock, no randomness. The same input
 * always produces the same verdict, which is what makes it safe to put on a
 * hot path and easy to unit test.
 *
 * Every detector runs even after one fails, so `reasons` shows the full picture
 * rather than whichever check happened to be ordered first.
 */
export function checkOutput(text: string, options: CheckOptions = {}): Verdict {
  const opts = { ...DEFAULTS, ...options };
  const reasons: Reason[] = [];
  const scores: Partial<Record<ReasonCode, number>> = {};
  let parsedJson: unknown;

  const add = (code: ReasonCode, score: number, threshold: number, message: string) => {
    scores[code] = score;
    if (score > threshold) reasons.push({ code, score, threshold, message });
  };

  const empty = emptinessScore(text);
  add('EMPTY', empty, 0.5, 'Response contains no usable content.');

  // Once the response is empty, the remaining content signals are noise.
  if (empty >= 1) {
    return { ok: false, reasons, scores };
  }

  if (opts.minLength > 0) {
    add(
      'TOO_SHORT',
      shortnessScore(text, opts.minLength),
      0,
      `Response is ${text.trim().length} chars, below the ${opts.minLength} minimum.`,
    );
  }

  if (opts.maxRepetition != null) {
    const s = repetitionScore(text, { n: opts.ngram });
    add('REPETITION', s, opts.maxRepetition,
      `${Math.round(s * 100)}% of ${opts.ngram}-grams are duplicates.`);
  }

  if (opts.maxTailLoop != null) {
    const s = tailLoopScore(text);
    add('TAIL_LOOP', s, opts.maxTailLoop,
      `Response ends in a repeating block covering ${Math.round(s * 100)}% of the tail.`);
  }

  if (opts.maxCompressibility != null) {
    const s = compressibilityScore(text);
    add('LOW_ENTROPY', s, opts.maxCompressibility,
      'Response is far more compressible than natural language.');
  }

  if (opts.maxTruncation != null || opts.finishReason) {
    const s = truncationScore(text, { finishReason: opts.finishReason });
    add('TRUNCATED', s, opts.maxTruncation ?? 0.75,
      `Response appears cut off near: "${excerpt(text.trim().slice(-60), 60)}"`);
  }

  if (opts.expectJson) {
    const result = jsonScore(text, {
      allowFence: opts.allowJsonFence,
      requiredKeys: opts.requiredKeys,
    });
    parsedJson = result.value;
    add('INVALID_JSON', result.score, 0,
      result.reason === 'missing-keys'
        ? `JSON is missing required keys: ${result.missingKeys?.join(', ')}.`
        : 'Response is not parseable JSON.');
  }

  if (opts.expectLang) {
    const s = languageMismatchScore(text, opts.expectLang);
    add('LANG_MISMATCH', s, opts.maxLangMismatch,
      `Response does not look like '${opts.expectLang}'.`);
  }

  return { ok: reasons.length === 0, reasons, scores, json: parsedJson };
}

/** Error thrown by {@link assertOutput}, carrying the full verdict. */
export class DegenerateOutputError extends Error {
  readonly verdict: Verdict;
  /** Marks this as safe to retry against another provider. */
  readonly retryable = true;

  constructor(verdict: Verdict) {
    super(`Degenerate LLM output: ${verdict.reasons.map((r) => r.code).join(', ')}`);
    this.name = 'DegenerateOutputError';
    this.verdict = verdict;
  }
}

/**
 * Throwing wrapper, for dropping straight into an existing retry or fallback
 * chain that already keys off thrown errors.
 */
export function assertOutput(text: string, options: CheckOptions = {}): string {
  const verdict = checkOutput(text, options);
  if (!verdict.ok) throw new DegenerateOutputError(verdict);
  return text;
}
