import type { CheckOptions, Reason, ReasonCode, TokenMode, Verdict } from './types.js';
import { repetitionScore, tailLoopDetail } from './detectors/repetition.js';
import { compressibilityScore } from './detectors/compressibility.js';
import { emptinessScore, shortnessScore } from './detectors/emptiness.js';
import { truncationScore } from './detectors/truncation.js';
import { jsonScore } from './detectors/json.js';
import { languageMismatchScore } from './detectors/language.js';
import { scriptMismatchScore } from './detectors/script.js';
import { promptEchoDetail } from './detectors/prompt-echo.js';
import { excerpt } from './internal/tokenize.js';
import { redundancySpans } from './internal/json-scope.js';

const DEFAULTS: Required<
  Pick<CheckOptions,
    'minLength' | 'maxRepetition' | 'maxTailLoop' | 'maxCompressibility' |
    'maxTruncation' | 'expectJson' | 'allowJsonFence' | 'maxLangMismatch' | 'ngram' |
    'maxCharTailLoop' | 'nonSpacedCutoff' | 'redundancyScope' | 'maxScriptMismatch' |
    'maxPromptEcho'>
> = {
  minLength: 1,
  maxRepetition: 0.35,
  maxTailLoop: 0.5,
  maxCharTailLoop: 0.7,
  nonSpacedCutoff: 0.5,
  maxCompressibility: 0.75,
  maxTruncation: null as unknown as number,
  expectJson: false,
  allowJsonFence: true,
  maxLangMismatch: 0.6,
  maxScriptMismatch: 0.5,
  maxPromptEcho: 0.6,
  ngram: 3,
  redundancyScope: 'document',
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
 *
 * Never throws. A `null`, `undefined`, or otherwise non-string input is a
 * verdict (`EMPTY`), not an exception -- see the guard below for why.
 */
export function checkOutput(
  text: string | null | undefined,
  options: CheckOptions = {},
): Verdict {
  const opts = { ...DEFAULTS, ...options };
  const reasons: Reason[] = [];
  const scores: Partial<Record<ReasonCode, number>> = {};
  const modes: Partial<Record<ReasonCode, TokenMode>> = {};
  let parsedJson: unknown;

  const add = (
    code: ReasonCode,
    score: number,
    threshold: number,
    message: string,
    mode?: TokenMode,
  ) => {
    scores[code] = score;
    if (mode) modes[code] = mode;
    if (score > threshold) reasons.push({ code, score, threshold, message, ...(mode && { mode }) });
  };

  /*
   * A caller who has `undefined` where the text should be is in exactly the
   * situation this package exists for: the request "succeeded" and produced
   * nothing. Types do not stop it -- an SDK whose field is optional, a JSON
   * envelope that shaped differently than documented, a `.content[0].text`
   * that was never there. Throwing a TypeError here would be the worst
   * possible answer, because it is not a DegenerateOutputError and so slips
   * straight through the very retry predicate the README recommends.
   */
  if (typeof text !== 'string') {
    scores.EMPTY = 1;
    reasons.push({
      code: 'EMPTY',
      score: 1,
      threshold: 0.5,
      message: `Response was ${text === null ? 'null' : typeof text}, not a string.`,
    });
    return { ok: false, reasons, scores };
  }

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

  /*
   * The spans the redundancy detectors read. One span -- the whole response --
   * unless `redundancyScope` says otherwise and the payload parses. See
   * `internal/json-scope.ts` for why a JSON array needs a different span.
   */
  const spans = redundancySpans(text, opts.redundancyScope);

  if (opts.maxRepetition != null) {
    // The worst span, not the average: a loop confined to one array element is
    // still a loop, and averaging is what hides it.
    const s = Math.max(...spans.map((span) => repetitionScore(span, { n: opts.ngram })));
    add('REPETITION', s, opts.maxRepetition,
      `${Math.round(s * 100)}% of ${opts.ngram}-grams are duplicates.`);
  }

  /*
   * The tail detector picks its own tokenizer from its own tail, so the
   * threshold has to be picked the same way -- `maxTailLoop` and
   * `maxCharTailLoop` describe different distributions and are not
   * interchangeable. Either can be null independently, which is what disabling
   * one mode looks like.
   */
  {
    // The mode travels with the span that produced the score, because the
    // threshold is chosen by it -- reporting the worst score against another
    // span's tokenizer would compare a number to the wrong distribution.
    let worst = { score: -1, mode: 'word' as TokenMode };
    for (const span of spans) {
      const detail = tailLoopDetail(span, { nonSpacedCutoff: opts.nonSpacedCutoff });
      if (detail.score > worst.score) worst = detail;
    }
    const { score, mode } = worst;
    const threshold = mode === 'char' ? opts.maxCharTailLoop : opts.maxTailLoop;
    if (threshold != null) {
      add('TAIL_LOOP', score, threshold,
        `Response ends in a repeating block covering ${Math.round(score * 100)}% of the tail.`,
        mode);
    }
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
      schema: opts.schema,
    });
    parsedJson = result.value;

    /*
     * One code for three ways of failing the same contract: the caller asked
     * for a payload of a given shape and did not get one. A schema mismatch
     * wants exactly the handling `INVALID_JSON` already gets -- retry, or fall
     * through to another provider -- so giving it a code of its own would widen
     * a frozen union and split existing handling for no gain.
     */
    add('INVALID_JSON', result.score, 0,
      result.reason === 'missing-keys'
        ? `JSON is missing required keys: ${result.missingKeys?.join(', ')}.`
        : result.reason === 'schema'
          ? `JSON does not match the schema: ${result.issues?.join('; ')}.`
          : 'Response is not parseable JSON.');
  }

  /*
   * Script before language, because where both fire the script answer is the
   * one worth reading: it measured characters, and the other guessed from
   * twenty function words. They keep separate codes rather than sharing
   * `LANG_MISMATCH` for the same reason `TAIL_LOOP` reports its mode -- a share
   * of letters and a relative share of function-word hits are different
   * distributions, and one histogram holding both describes neither.
   */
  if (opts.expectScript) {
    const wanted = Array.isArray(opts.expectScript) ? opts.expectScript : [opts.expectScript];
    const s = scriptMismatchScore(text, opts.expectScript);
    add('SCRIPT_MISMATCH', s, opts.maxScriptMismatch,
      `${Math.round(s * 100)}% of letters are not in ${wanted.join(' or ')}.`);
  }

  /*
   * Last, because it is the only detector that reads something other than the
   * response, and the only one whose usefulness depends on what the caller
   * asked the model to do. See `detectors/prompt-echo.ts` for the task types
   * it must not be pointed at.
   *
   * The mode is reported for the same reason `TAIL_LOOP` reports it, but a
   * single threshold serves both: this measures the share of output copied
   * verbatim, which is 1.000 for a full echo and 0.000 for a healthy answer in
   * either tokenizer. `TAIL_LOOP` needed two because periodicity has a
   * different base rate per script; a copy either happened or it did not.
   */
  if (opts.prompt) {
    const { score, mode } = promptEchoDetail(text, opts.prompt, {
      nonSpacedCutoff: opts.nonSpacedCutoff,
    });
    add('PROMPT_ECHO', score, opts.maxPromptEcho,
      `${Math.round(score * 100)}% of the response is copied from the prompt.`, mode);
  }

  if (opts.expectLang) {
    const s = languageMismatchScore(text, opts.expectLang);
    add('LANG_MISMATCH', s, opts.maxLangMismatch,
      `Response does not look like '${opts.expectLang}'.`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    scores,
    ...(Object.keys(modes).length > 0 && { modes }),
    json: parsedJson,
  };
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
export function assertOutput(
  text: string | null | undefined,
  options: CheckOptions = {},
): string {
  const verdict = checkOutput(text, options);
  if (!verdict.ok) throw new DegenerateOutputError(verdict);
  // Unreachable for non-strings: those score EMPTY 1 and throw above.
  return text as string;
}
