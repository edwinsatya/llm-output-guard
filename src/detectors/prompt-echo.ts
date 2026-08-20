/**
 * Output copied out of the prompt rather than generated from it.
 *
 * The failure looks like this: you send a system prompt and a question, and
 * what comes back is your own system prompt, or your own question, or the
 * few-shot example you included to demonstrate the format. Fluent, correctly
 * formatted, non-empty, not repetitive, in the right language, and worth
 * nothing. Every other detector here reads it as healthy, because by every
 * measure they take it is.
 *
 * It happens most with quantised and self-hosted models, and with a chat
 * template that has drifted from the one the weights were trained on: the
 * model loses track of which turn it is in and continues the transcript
 * instead of answering it.
 *
 * ## Why runs of tokens rather than a similarity score
 *
 * The question is not "how similar are these two texts", it is "how much of
 * this output did the model actually write". Those differ. A good answer to a
 * question about connection pooling shares a lot of vocabulary with the
 * question and almost no *sequences* with it. Matching on runs of five words
 * asks the second question, and a model that is genuinely writing does not
 * reproduce five-word runs from its input by accident.
 *
 * ## The false positive this cannot avoid, and does not try to
 *
 * Rewriting, translating, summarising, fixing grammar, extracting fields:
 * every one of these is a task where copying from the input **is** the job,
 * and a correct answer scores high here. No signal separates those from a
 * degenerate echo, because there is no difference in the text. The difference
 * is in what you asked for.
 *
 * So this is opt-in, absent from every preset, and requires the prompt to be
 * passed deliberately. Do not enable it on a rewrite endpoint.
 */
import type { TokenMode } from '../types.js';
import { words, chars, clamp01, tokenModeOf } from '../internal/tokenize.js';

export interface PromptEchoOptions {
  /**
   * Run length that counts as copied, in word tokens. Default 5.
   *
   * Five is where shared *vocabulary* stops and shared *text* begins. At 3,
   * ordinary phrasing collides ("in order to make sure", "one of the most
   * important") and healthy answers to a detailed question score well into the
   * twenties. At 7 a model that echoes with light paraphrase slips through.
   */
  n?: number;
  /**
   * Run length in char mode, for scripts written without spaces. Default 12.
   *
   * Not `n` scaled. A Chinese run of five characters is a phrase rather than a
   * sentence fragment, so the word-mode number would match far too readily.
   */
  charN?: number;
  /** Below this many tokens the sample is too short to judge. Default 40. */
  minTokens?: number;
  /** Force a tokenizer instead of dispatching on the output's script. */
  mode?: TokenMode;
  /** Non-spaced-script share at which char mode takes over. Default 0.5. */
  nonSpacedCutoff?: number;
  /** Only analyse the first N characters of each side. Default 8000. */
  maxSample?: number;
}

export interface PromptEchoResult {
  /** Fraction of the output's runs that also appear in the prompt. */
  score: number;
  /** Which tokenizer produced `score`. */
  mode: TokenMode;
}

/**
 * Share of the output's token runs that appear verbatim in the prompt.
 *
 * Returns 0, abstaining, with no prompt, with an output too short to judge, or
 * when either side has fewer tokens than the run length. Never throws.
 */
export function promptEchoDetail(
  text: string,
  prompt: string | null | undefined,
  options: PromptEchoOptions = {},
): PromptEchoResult {
  const {
    n = 5,
    charN = 12,
    minTokens = 40,
    nonSpacedCutoff = 0.5,
    maxSample = 8000,
  } = options;

  const output = text.slice(0, maxSample);
  const mode = options.mode ?? tokenModeOf(output, nonSpacedCutoff);

  if (typeof prompt !== 'string' || prompt.length === 0) return { score: 0, mode };

  const tokenize = mode === 'char' ? chars : words;
  const run = mode === 'char' ? charN : n;

  const out = tokenize(output);
  const src = tokenize(prompt.slice(0, maxSample));

  /*
   * Two floors, not one. `minTokens` is the judgement floor: below it any
   * score is noise. The run-length check after it is a correctness floor. With
   * fewer tokens than `run` there are no runs to compare, `total` stays 0, and
   * the ratio would be NaN, which is a score that sits below every threshold
   * and so silently disables the detector rather than failing loudly.
   */
  if (out.length < minTokens) return { score: 0, mode };
  if (out.length < run || src.length < run) return { score: 0, mode };

  const seen = new Set<string>();
  for (let i = 0; i + run <= src.length; i++) {
    seen.add(src.slice(i, i + run).join(' '));
  }

  let matched = 0;
  let total = 0;
  for (let i = 0; i + run <= out.length; i++) {
    if (seen.has(out.slice(i, i + run).join(' '))) matched++;
    total++;
  }

  return { score: total === 0 ? 0 : clamp01(matched / total), mode };
}

/** {@link promptEchoDetail} without the mode, for callers that only want the score. */
export function promptEchoScore(
  text: string,
  prompt: string | null | undefined,
  options: PromptEchoOptions = {},
): number {
  return promptEchoDetail(text, prompt, options).score;
}
