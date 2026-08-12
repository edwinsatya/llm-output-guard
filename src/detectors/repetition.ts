import type { TokenMode } from '../types.js';
import { words, chars, clamp01, tokenModeOf } from '../internal/tokenize.js';

export interface RepetitionOptions {
  /** N-gram size. 3 suits prose; 2 is noisy, 4 misses short loops. */
  n?: number;
  /** Only analyse the first N characters. Keeps cost bounded on long outputs. */
  maxSample?: number;
}

/**
 * Fraction of n-grams that are duplicates. 0 = every n-gram unique, 1 = total collapse.
 *
 * Healthy prose sits near 0.00-0.10. A model stuck in a loop passes 0.5 quickly.
 * Returns 0 for text too short to judge rather than guessing.
 *
 * **Word mode only, and knowingly blind to non-spaced scripts.** In Chinese,
 * Japanese or Thai a punctuation-delimited clause is one token and a loop with
 * no punctuation is one token for the whole response, so this scores 0.000 on
 * an obvious Chinese loop.
 *
 * A character n-gram fallback was built and rejected. Not because no threshold
 * exists -- one does, around 0.7 -- but because **it would buy no coverage and
 * cost a false-positive surface.**
 *
 * Coverage: `tailLoopScore`'s character mode already catches every degenerate
 * non-Latin fixture in the corpus, at a margin of 0.538. There is nothing left
 * for a character-mode `REPETITION` to find.
 *
 * Cost: healthy *structured* CJK output scores high here. Repeated key
 * scaffolding around short CJK values is genuinely redundant character by
 * character, and `json-zh-keys-valid` measures 0.543 over twenty distinct
 * items. The curve flattens rather than diverging -- 0.396 at eight, 0.577 at
 * thirty, 0.597 at forty, converging on the scaffolding's own proportion -- so
 * the plateau near 0.6 against the weakest pure loop at 0.872 leaves about
 * 0.19. That is under this package's own 0.2 bar, and the healthy side rises
 * with the number of keys a payload carries, which nothing bounds.
 *
 * A detector with no coverage to add and a structure-sensitive margin is a
 * false positive waiting for someone's payload shape to change.
 *
 * `tailLoopScore` covers the gap instead: it requires *exact periodicity*, which
 * scaffolding never produces, and it caught every degenerate CJK sample in the
 * corpus. See the `Limitations` section of the README.
 */
export function repetitionScore(text: string, options: RepetitionOptions = {}): number {
  const { n = 3, maxSample = 8000 } = options;
  const w = words(text.slice(0, maxSample));
  if (w.length < n * 4) return 0;

  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i + n <= w.length; i++) {
    seen.add(w.slice(i, i + n).join(' '));
    total++;
  }
  if (total === 0) return 0;
  return clamp01(1 - seen.size / total);
}

export interface TailLoopOptions {
  /** How many trailing words to inspect in word mode. */
  tailWords?: number;
  /** Longest loop period to look for, in words. */
  maxPeriod?: number;
  /** A block must repeat at least this many times to count as a loop. */
  minRepeats?: number;
  /** How many trailing characters to inspect in char mode. Default 400. */
  tailChars?: number;
  /** Longest loop period to look for in char mode, in characters. Default 80. */
  maxCharPeriod?: number;
  /**
   * Characters required before char mode will judge at all. Default 80.
   *
   * Word mode's floor is a word count, which on a non-spaced script can be
   * satisfied by a single token, so char mode needs its own. Below this the
   * detector abstains: three short sentences ending a 40-character reply are
   * indistinguishable from a loop by coverage alone, and abstaining is the
   * rule everywhere else in this package.
   */
  minCharSample?: number;
  /** Force a tokenizer instead of dispatching on the tail's script. */
  mode?: TokenMode;
  /** Non-spaced-script share at which char mode takes over. Default 0.5. */
  nonSpacedCutoff?: number;
}

export interface TailLoopResult {
  /** Fraction of the inspected tail covered by the repeating block. */
  score: number;
  /** Which tokenizer produced `score`. */
  mode: TokenMode;
}

/**
 * Largest share of `tail` covered by a block repeating to its end.
 *
 * Shared by both modes so the two cannot drift apart: word mode passes word
 * tokens, char mode passes characters, and the periodicity search is the same
 * code either way.
 */
function periodicCoverage(
  tail: readonly string[],
  maxPeriod: number,
  minRepeats: number,
): number {
  if (tail.length < minRepeats * 2) return 0;

  let best = 0;
  const periodCap = Math.min(maxPeriod, Math.floor(tail.length / minRepeats));
  for (let p = 1; p <= periodCap; p++) {
    const block = tail.slice(tail.length - p);
    let repeats = 1;
    let cursor = tail.length - p;
    while (cursor - p >= 0) {
      let same = true;
      for (let k = 0; k < p; k++) {
        if (tail[cursor - p + k] !== block[k]) { same = false; break; }
      }
      if (!same) break;
      repeats++;
      cursor -= p;
    }
    if (repeats >= minRepeats) {
      best = Math.max(best, clamp01((repeats * p) / tail.length));
    }
  }
  return best;
}

/**
 * Detects the specific failure where a model terminates in a repeating tail --
 * the same clause emitted over and over until max_tokens runs out.
 *
 * Whole-output repetition misses this when the first half of the response was
 * fine. Returns the fraction of the inspected tail covered by the loop, plus
 * the tokenizer that measured it.
 *
 * **The mode is decided from the tail, not the whole response.** A reply that
 * answers in English and then loops in Chinese is 0.35 non-spaced overall and
 * 1.00 across its final 400 characters; dispatching on the former would run
 * word tokenization over text that yields one token, and score 0.000 on an
 * obvious loop. Measured on that shape, whole-response dispatch missed it
 * entirely and tail dispatch scored 1.000.
 *
 * The two modes are **not interchangeable numbers**. Character n-grams
 * duplicate at a different base rate, so each has its own threshold
 * (`maxTailLoop`, `maxCharTailLoop`) and `Verdict.modes` reports which one ran.
 */
export function tailLoopDetail(text: string, options: TailLoopOptions = {}): TailLoopResult {
  const {
    tailWords = 200,
    maxPeriod = 40,
    minRepeats = 3,
    tailChars = 400,
    maxCharPeriod = 80,
    minCharSample = 80,
    nonSpacedCutoff = 0.5,
  } = options;

  const charTail = chars(text).slice(-tailChars);
  const mode = options.mode ?? tokenModeOf(charTail.join(''), nonSpacedCutoff);

  if (mode === 'char') {
    if (charTail.length < minCharSample) return { score: 0, mode };
    return { score: periodicCoverage(charTail, maxCharPeriod, minRepeats), mode };
  }

  const tail = words(text).slice(-tailWords);
  return { score: periodicCoverage(tail, maxPeriod, minRepeats), mode };
}

/** {@link tailLoopDetail} without the mode, for callers that only want the score. */
export function tailLoopScore(text: string, options: TailLoopOptions = {}): number {
  return tailLoopDetail(text, options).score;
}
