/**
 * What a guard should do when the model answered with a tool call.
 *
 * Shared by every adapter for the same reason as `adapter-options.ts`: this is
 * a policy, and two hand-maintained copies of a policy is how one of them
 * quietly stops matching the other.
 *
 * ## The bug this exists to prevent
 *
 * A tool call is not text. OpenAI returns `content: null` alongside
 * `tool_calls`, and the AI SDK returns a `content` array with no `text` part --
 * so an adapter that concatenates text parts and hands the result to
 * `checkOutput` passes it `''`, which scores `EMPTY: 1` and throws. The
 * detector is right; it was asked the wrong question. Every tool-calling turn
 * of every agent fails, which is a false positive on the most common shape of
 * modern LLM traffic.
 *
 * So the rule is: **the presence of tool calls means the text, if any, is a
 * preamble rather than the answer.** Judge it as one, or not at all.
 *
 * ## This type is INTERNAL. It is not public API, at 1.0 or after.
 *
 * It is exported from no subpath and is not reachable by any import path a user
 * has. What is observable is the behaviour: adapters do not fail a response for
 * being a tool call. That behaviour is covered by semver; this module is not.
 */
import type { CheckOptions, Verdict } from '../types.js';
import { checkOutput } from '../check.js';

/**
 * The detectors that ask "is this a complete answer", switched off.
 *
 * A preamble is not a complete answer and was never meant to be, so each of
 * these would be measuring the wrong thing:
 *
 * - `minLength` -- "Let me look that up" is sixteen characters and correct.
 *   Under `presets.longForm` its 200-character minimum fails every tool call.
 * - `maxTruncation` -- a preamble ends without terminal punctuation as a matter
 *   of course, which `truncationScore` reads as 0.55. Under a lowered
 *   `maxTruncation` that fires on healthy output.
 * - `expectJson` -- on a tool-calling turn the JSON is in the call arguments,
 *   which the provider has already validated against your schema. The prose
 *   beside it is prose, and `presets.strictJson` would fail it for being so.
 *
 * `finishReason` is cleared with them: it is the input `maxTruncation` keys off,
 * and leaving it set re-enables the detector that was just switched off.
 *
 * What deliberately stays on is redundancy -- `REPETITION`, `TAIL_LOOP`,
 * `LOW_ENTROPY`. A model that loops in its preamble is still a model that is
 * looping, and those detectors measure that without caring whether the text is
 * a whole answer.
 */
export const TOOL_CALL_PREAMBLE: CheckOptions = {
  minLength: 0,
  maxTruncation: null,
  expectJson: false,
  finishReason: undefined,
};

/**
 * The verdict for a response that carried tool calls, or `null` when there is
 * nothing to judge.
 *
 * `null` is the no-text case, and it is the whole point: a response consisting
 * only of tool calls has no prose to measure, so the honest answer is silence
 * rather than a verdict on the empty string. Callers must treat `null` as "not
 * judged" and skip both the action and the `onVerdict` report -- an `EMPTY`
 * logged here would poison a calibration run with a spike of `EMPTY: 1` samples
 * that describe nothing but the agent's tool use.
 */
export function checkPreamble(text: string, options: CheckOptions): Verdict | null {
  if (text.trim().length === 0) return null;
  return checkOutput(text, { ...options, ...TOOL_CALL_PREAMBLE });
}
