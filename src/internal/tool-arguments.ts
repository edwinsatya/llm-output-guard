/**
 * Redundancy inside the arguments a model passed to a tool.
 *
 * ## The hole this fills
 *
 * `tool-calls.ts` established that a tool-calling turn is judged by its
 * preamble, because the text beside a tool call is not the answer. That is
 * right, and it left the actual answer unmeasured: the arguments. Until now the
 * README said so in as many words, and pointed at the provider's schema
 * validation as the thing covering it.
 *
 * Schema validation covers *types*. It does not cover a `string` that is a
 * string. A model that emits
 *
 *     { "query": "site reliability site reliability site reliability ..." }
 *
 * has produced a schema-valid payload, and the provider will hand it to your
 * tool without complaint. If that tool is a search, you have just issued a
 * garbage query; if it is a write, you have just persisted a loop.
 *
 * ## What is measured, and what deliberately is not
 *
 * Only redundancy, and only per string value. The reasoning is the same one
 * behind `redundancyScope: 'jsonValues'`, and it applies here more strongly:
 * arguments are a small structured object, so
 *
 * - measuring the serialised form would score the key scaffolding rather than
 *   the content, and two tool calls with the same schema are legitimately
 *   near-identical documents;
 * - `LOW_ENTROPY` is off for the same reason `presets.strictJson` turns it off,
 *   because JSON is legitimately repetitive at the character level;
 * - `TRUNCATED`, `TOO_SHORT` and `INVALID_JSON` are off because the provider
 *   already guarantees the arguments parse and match the declared schema. They
 *   would be answering a question that has been answered.
 * - `SCRIPT_MISMATCH` and `LANG_MISMATCH` are off because an argument is not
 *   prose addressed to a user. A search query in a different language than the
 *   conversation is ordinary, not degenerate.
 *
 * What is left is exactly the failure that gets through everything else: a
 * value that loops.
 *
 * ## This module is INTERNAL. It is not public API, at 1.0 or after.
 *
 * What is public is the `checkToolArguments` option on each adapter, and the
 * behaviour it selects.
 */
import type { CheckOptions, Reason, Verdict } from '../types.js';
import { checkOutput } from '../check.js';
import { redundancySpans } from './json-scope.js';

/**
 * The detectors that mean something for a tool argument, with everything else
 * switched off. See the module comment for why each one is absent.
 */
const ARGUMENT_SCOPE: CheckOptions = {
  minLength: 0,
  maxTruncation: null,
  maxCompressibility: null,
  expectJson: false,
  expectLang: null,
  expectScript: null,
  finishReason: undefined,
  redundancyScope: 'jsonValues',
};

/**
 * Normalise one call's arguments to the JSON text `redundancyScope` reads.
 *
 * Providers disagree about the shape: OpenAI sends `function.arguments` as a
 * JSON **string**, Anthropic sends `input` as an already-parsed **object**, and
 * the AI SDK sends `input` either way depending on version. Serialising the
 * parsed forms and passing strings through untouched puts all of them on the
 * one path, and an unparseable string still behaves -- `redundancySpans` falls
 * back to measuring it as a document.
 */
export function argumentsToText(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args === null || args === undefined) return '';
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    // Circular, or a BigInt. Neither is something a provider sends, and
    // neither is evidence of degeneration.
    return '';
  }
}

/**
 * A verdict over every argument of every tool call in one response, or `null`
 * when there is nothing to judge.
 *
 * `null` follows `checkPreamble`'s rule and for the same reason: a response
 * whose arguments carry no strings has nothing to measure, and a manufactured
 * passing verdict would report a check that never ran.
 */
export function checkArguments(calls: readonly unknown[], options: CheckOptions): Verdict | null {
  const texts = calls.map(argumentsToText).filter(hasMeasurableContent);
  if (texts.length === 0) return null;

  let worst: Verdict | null = null;
  for (const text of texts) {
    const verdict = checkOutput(text, { ...options, ...ARGUMENT_SCOPE });
    // The worst call decides, because one looping argument is one looping
    // argument regardless of how many healthy ones sit beside it.
    if (!worst || (worst.ok && !verdict.ok)) worst = verdict;
    else if (!verdict.ok && !worst.ok && maxScore(verdict) > maxScore(worst)) worst = verdict;
  }
  return worst;
}

const maxScore = (verdict: Verdict): number =>
  verdict.reasons.reduce((hi, reason) => Math.max(hi, reason.score), 0);

/**
 * Whether these arguments contain anything a redundancy detector can read.
 *
 * This is not an optimisation, it is the tool-call `EMPTY` bug again in a new
 * place. A tool that takes no parameters is called with `{}`, and `{}` is one
 * of the shapes `emptinessScore` exists to catch -- so handing it to
 * `checkOutput` scores `EMPTY: 1` and fails a completely ordinary call.
 * `emptinessScore` is right, and it is being asked about a document when the
 * question is about the values inside one.
 *
 * The same reasoning covers `{"lat":-6.2,"zoom":11}` and `{"query":""}`: no
 * string content means nothing to measure, and silence is the honest answer.
 *
 * Asked through `redundancySpans` rather than by parsing here, so an argument
 * that does not parse follows the same fallback as everything else in the
 * package: it is measured as a document rather than skipped.
 */
const hasMeasurableContent = (text: string): boolean =>
  redundancySpans(text, 'jsonValues').some((span) => span.trim().length > 0);

/**
 * Fold an argument verdict into the preamble's, so a caller sees one verdict
 * per response rather than two to reconcile.
 *
 * Argument reasons keep their codes and are relabelled in `message` only.
 * `message` is explicitly outside this package's semver promise, which makes it
 * the right place to say where a loop was found: the code stays the one your
 * handler already switches on, and the string tells you it came from a tool
 * argument rather than from the prose beside it.
 */
export function mergeVerdicts(preamble: Verdict | null, args: Verdict | null): Verdict | null {
  if (!args) return preamble;

  const labelled: Reason[] = args.reasons.map((reason) => ({
    ...reason,
    message: `In a tool call argument: ${reason.message}`,
  }));

  if (!preamble) return { ...args, reasons: labelled };

  const scores = { ...preamble.scores };
  for (const [code, score] of Object.entries(args.scores)) {
    const key = code as keyof typeof scores;
    // The higher score wins: both measured the same detector over
    // model-generated text, and the response is as degenerate as its worst part.
    if (scores[key] === undefined || score > scores[key]!) scores[key] = score;
  }

  const reasons = [...preamble.reasons, ...labelled];
  return {
    ...preamble,
    ok: reasons.length === 0,
    reasons,
    scores,
  };
}
