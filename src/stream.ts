import type { CheckOptions, Verdict } from './types.js';
import { checkOutput } from './check.js';

/**
 * Detectors that mean nothing until the response is complete.
 *
 * This is the whole problem with judging a stream. Partial output is short,
 * is cut off, and does not parse as JSON -- not because the model is failing
 * but because it has not finished talking. Run the full check on a half-built
 * response and `TOO_SHORT`, `TRUNCATED` and `INVALID_JSON` fire on every
 * healthy generation in the first few tokens, which is worse than no check at
 * all: it trains you to ignore the guard.
 *
 * What *is* meaningful early is redundancy. A model stuck in a loop is already
 * looping by the time it has emitted a few hundred characters, and no amount
 * of further generation makes it less true. So mid-stream runs exactly the
 * three detectors that measure repetition, and defers the rest to `end()`.
 */
const DEFERRED_TO_END: CheckOptions = {
  minLength: 0,
  maxTruncation: null,
  expectJson: false,
  expectLang: null,
  finishReason: undefined,

  /*
   * SCRIPT_MISMATCH is deferred for a reason none of the others share: it is
   * the *window* that makes it unsafe, not the partial text.
   *
   * Which language a model answered in is a property of the whole response.
   * Every mid-stream check reads the trailing `window` characters, so what it
   * would actually measure is the language of the last few paragraphs -- and an
   * English answer that ends by quoting a Chinese passage is a real thing that
   * happens. Measured on exactly that shape: 0.114 across the document, 0.206
   * over the last 1000 characters, and 0.500 over the last 400. The document is
   * healthy and the window says it is half wrong, so a smaller `window` would
   * buy earlier detection by manufacturing false positives out of quotations.
   *
   * The detector itself is decisive from about a dozen letters, so there is a
   * real early-abort here for someone who wants it -- it just has to read the
   * whole buffer rather than a window:
   *
   *   const v = checkOutput(guard.text, { expectScript: 'latin' });
   *
   * Deliberately left to the caller. The guard cannot run one detector over a
   * different span than the rest without becoming a per-detector span router,
   * and this is one line for the callers who need it.
   */
  expectScript: null,

  /*
   * PROMPT_ECHO is deferred for the same reason as SCRIPT_MISMATCH, and it
   * bites harder. The score is the share of the *whole* output copied from the
   * prompt, so a trailing window measures the share of that window -- and a
   * response that opens by echoing the system prompt and then answers properly
   * reads as 1.000 over its first window and 0.000 over its last. Neither
   * number describes the response.
   *
   * Dilution is the point of the measure: an output that is 10% leaked prompt
   * and 90% answer should score 0.1, and only the finished response knows what
   * that ratio is.
   */
  prompt: null,

  /*
   * LOW_ENTROPY is deferred for a second reason: cost. The LZ77 pass is
   * 0.4ms at 500 characters and 11ms at its 4000-character sample cap, which
   * is 100x the other two detectors combined -- affordable once per response,
   * ruinous every few hundred characters of every stream.
   *
   * DEFERRING IT IS CONDITIONAL, NOT FREE. The condition is that the redundancy
   * detectors still running here reach a verdict *earlier* than LOW_ENTROPY
   * would have, on every script. Two things make that true today:
   *
   *   - For spaced scripts, REPETITION catches what LOW_ENTROPY would, because
   *     character-level collapse is also n-gram collapse.
   *   - For Han, Kana and Thai, REPETITION is blind -- a loop with no
   *     punctuation is a single word token -- and TAIL_LOOP's character mode is
   *     what covers it. Measured at the 240-character warmup, that mode scores
   *     0.854-1.000 on every degenerate CJK fixture and fires on the first
   *     check. At that same moment LOW_ENTROPY reads 0.453-0.805, i.e. below
   *     its own 0.75 threshold on most of them: running it here would detect
   *     these *later*, at 100x the cost.
   *
   * SO THIS BREAKS IF: character dispatch is disabled (`maxCharTailLoop: null`,
   * or `nonSpacedCutoff` raised out of reach), or `warmup` is raised past the
   * point where a loop's periodicity has established itself in the window. A
   * 15-character loop unit repeats 16 times in 240 characters against a
   * `minRepeats` of 3, so there is room -- but it is room, not immunity. If you
   * change either, re-measure before assuming this deferral is still safe;
   * otherwise CJK streams silently lose mid-stream detection entirely and the
   * only thing left is the end() check, which is after you have paid.
   */
  maxCompressibility: null,
};

/**
 * Characters that must have arrived before a prefix is allowed to condemn a
 * response, and the score it has to reach. Both are measured, not chosen.
 *
 * The problem is that a prefix score is not the document score. These
 * detectors report a **share**, and a response that opens in one script and
 * continues in another -- or leaks the prompt and then answers -- is at its
 * worst exactly when the least of it has arrived. Measured on that shape:
 *
 *   opens with a Chinese quote, then answers in English (want latin)
 *     240 chars 1.00   640 0.42   1040 0.26   1440 0.19   final 0.186
 *   a long English preamble, then answers in Chinese (want han)
 *     240 chars 1.00   640 0.66   1040 0.39            final 0.359
 *   leaks the prompt, then answers at length
 *     240 chars 0.00   640 0.54   1040 0.33   1440 0.24  final 0.093
 *
 * Every one of those is a healthy response, and every one reads as totally
 * degenerate at 240 characters. So the floor is 600 rather than the guard's
 * own 240 warmup, and the bar is 0.9 rather than whatever threshold the caller
 * configured: a prefix is only allowed to prove the extreme case, where the
 * whole buffer so far is in the wrong script or copied from the prompt.
 *
 * At those numbers the worst healthy case above reads 0.66 against a bar of
 * 0.9. That margin is 0.24, which is the whole reason this is opt-in.
 */
const EARLY_DOCUMENT_MIN = 600;
const EARLY_DOCUMENT_CERTAINTY = 0.9;

/**
 * The head of the buffer these detectors actually read, and the schedule on
 * which they read it. Both exist because the naive version is quadratic.
 *
 * Measured before this: a 32,000-character stream cost 9.06ms with the feature
 * off and **65.48ms** with it on, because every check re-scanned the whole
 * buffer. That is the cost `window` exists to prevent, reintroduced by a
 * second span that had no window of its own.
 *
 * Two facts make it cheap instead. Both detectors sample the *first*
 * `maxSample` characters, so the span never needs to be longer than that -- and
 * once the buffer passes it, the sample stops changing and the score is frozen,
 * so any further check is provably re-computing a number that cannot move.
 *
 * So the buffer is capped at the sample size, checks stop once it saturates,
 * and until then they run on a doubling schedule rather than on every check.
 * The answer stabilises as the buffer grows, so looking less often costs
 * nothing: a stream of any length gets about five of these, not one per check.
 */
const EARLY_DOCUMENT_SAMPLE = 8000;

/**
 * Everything except the document detectors, off.
 *
 * Those two are the only ones this can turn back on, and the only ones worth
 * turning back on: both measure a property of the whole response rather than of
 * a window, so both are meaningless against the trailing slice the other checks
 * read and meaningful against the buffer so far. Everything else either belongs
 * on the window (redundancy) or belongs at the end (`TRUNCATED`,
 * `INVALID_JSON`, `TOO_SHORT`) for the reasons `DEFERRED_TO_END` gives.
 *
 * Expressed as an options overlay rather than as a list of codes, so a detector
 * added later is off here until someone decides otherwise -- the safe
 * direction, and the one that does not need this file edited to stay correct.
 */
const DOCUMENT_ONLY: CheckOptions = {
  minLength: 0,
  maxRepetition: null,
  maxTailLoop: null,
  maxCharTailLoop: null,
  maxCompressibility: null,
  maxTruncation: null,
  expectJson: false,
  expectLang: null,
  finishReason: undefined,
  maxScriptMismatch: EARLY_DOCUMENT_CERTAINTY,
  maxPromptEcho: EARLY_DOCUMENT_CERTAINTY,
};

/**
 * Fold an early document verdict into the window verdict for the same check.
 *
 * Scores are merged whether or not the document detectors failed, because
 * `scores` carries the passing ones everywhere else in this package and a
 * caller feeding `push()` into their metrics should see the same. Only
 * `reasons` decides `ok`.
 */
function mergeEarly(windowVerdict: Verdict, document: Verdict | null): Verdict {
  if (!document) return windowVerdict;
  const reasons = [...windowVerdict.reasons, ...document.reasons];
  return {
    ...windowVerdict,
    ok: reasons.length === 0,
    reasons,
    scores: { ...windowVerdict.scores, ...document.scores },
    ...(document.modes || windowVerdict.modes
      ? { modes: { ...windowVerdict.modes, ...document.modes } }
      : {}),
  };
}

export interface StreamGuardOptions extends CheckOptions {
  /**
   * Judge `SCRIPT_MISMATCH` and `PROMPT_ECHO` mid-stream, against the whole
   * buffer rather than the trailing window. Default `false`.
   *
   * Both are deferred to `end()` by default because they measure the whole
   * response, and a window measures the window. This reads the buffer instead,
   * which is the right span -- but the buffer is a *prefix*, and a prefix
   * over-reports both: a response that opens with a quotation in another
   * script, or leaks the prompt before answering, is at its worst when the
   * least of it has arrived.
   *
   * So a prefix is only allowed to condemn a response it is **entirely**
   * wrong about: nothing is judged under 600 characters, and the bar is 0.9
   * regardless of the threshold you configured. Even then, the worst healthy
   * case measured here reads 0.66 at 640 characters.
   *
   * **What you buy is tokens.** A model answering in the wrong language commits
   * to it in the first sentence, and this aborts at around 600 characters
   * instead of at the end. **What you risk** is discarding a healthy response
   * that happens to open in another script for longer than that.
   *
   * Off by default because this package treats a false positive as worse than
   * a miss, and `end()` already catches every one of these with no such risk.
   */
  earlyDocumentChecks?: boolean;
  /**
   * Characters of *new* text between checks. Default 400.
   *
   * Checking on every chunk would re-scan the buffer per token and turn a
   * linear stream into quadratic work. Batching costs a little detection
   * latency and buys a bounded cost per stream.
   */
  checkEvery?: number;
  /**
   * Characters that must arrive before any judgement. Default 240.
   *
   * A loop is not visible in the first sentence, and neither is its absence.
   * Below this the guard abstains rather than guessing -- the same rule the
   * detectors already follow for short samples.
   */
  warmup?: number;
  /**
   * Trailing characters each mid-stream check looks at. Default 2000.
   *
   * Two reasons, and the second matters more. Cost: without a window every
   * check re-scans the whole buffer, so a stream costs quadratic work in its
   * own length. Sensitivity: a model that produced four healthy paragraphs
   * and then began looping is diluted to nothing when measured across all
   * five, which is the same reasoning that makes `tailLoopScore` a separate
   * detector from `repetitionScore`. Recent text is the text in question.
   */
  window?: number;
}

export interface StreamGuard {
  /**
   * Feed the next chunk.
   *
   * Returns a verdict only on the chunks where a check actually ran, and
   * `null` on the rest -- so `null` means "not judged yet", never "healthy".
   * Read `.ok` on what you get back.
   */
  push(chunk: string): Verdict | null;
  /**
   * Full check on the complete text, including the detectors deferred above.
   * Pass the provider's stop reason if you have it; truncation keys off it.
   */
  end(finishReason?: string): Verdict;
  /** Everything pushed so far. */
  readonly text: string;
  /** How many mid-stream checks have run. Useful when tuning `checkEvery`. */
  readonly checks: number;
}

/**
 * Watches a response as it arrives and reports degeneration before it finishes.
 *
 * The reason to bother: a model that has started looping will keep looping
 * until it hits `max_tokens`, and you pay for every one of those tokens plus
 * the latency of waiting for them. Catching it at character 300 of a 4000
 * character run and aborting turns a slow bad answer into a fast one.
 *
 * This never aborts anything itself -- it holds no controller and knows
 * nothing about your provider. It tells you; you decide.
 */
export function createStreamGuard(options: StreamGuardOptions = {}): StreamGuard {
  const {
    checkEvery = 400,
    warmup = 240,
    window = 2000,
    earlyDocumentChecks = false,
    ...checkOptions
  } = options;

  /*
   * Nothing to do unless a document detector is actually configured. Asked
   * once, because the answer cannot change over the life of a stream, and
   * because it keeps the per-check path free of work for the callers who have
   * neither option set -- which is most of them.
   */
  const earlyDocument =
    earlyDocumentChecks && Boolean(checkOptions.expectScript || checkOptions.prompt);

  /** Buffer length at which the next document check is due, doubling each time. */
  let nextDocumentAt = EARLY_DOCUMENT_MIN;
  /** Set once the sample has saturated, after which the score cannot change. */
  let documentSettled = false;

  let text = '';
  let sinceCheck = 0;
  let checks = 0;

  /*
   * The first check fires as soon as `warmup` is met; `checkEvery` only
   * spaces out the ones after it. Gating the first on both would make the
   * earlier of the two settings dead -- and it is the first check that
   * decides how many wasted tokens a loop gets to emit, which is the entire
   * point of watching a stream instead of its result.
   */
  const due = () => (checks === 0 ? text.length >= warmup : sinceCheck >= checkEvery);

  return {
    get text() {
      return text;
    },
    get checks() {
      return checks;
    },

    push(chunk: string): Verdict | null {
      if (typeof chunk !== 'string' || chunk.length === 0) return null;

      text += chunk;
      sinceCheck += chunk.length;

      if (!due()) return null;

      sinceCheck = 0;
      checks += 1;
      // The tail, not the head -- the detectors' own `maxSample` takes the
      // first N characters, which for a stream is the part already judged.
      const recent = text.length > window ? text.slice(-window) : text;
      const verdict = checkOutput(recent, { ...checkOptions, ...DEFERRED_TO_END });

      /*
       * The second span. The window is right for redundancy and wrong for the
       * document detectors, so those read the head of the buffer instead --
       * capped, scheduled, and stopped once the sample saturates. See
       * `EARLY_DOCUMENT_SAMPLE` for why all three are needed.
       */
      if (!earlyDocument || documentSettled || text.length < nextDocumentAt) return verdict;

      nextDocumentAt = text.length * 2;
      const head =
        text.length > EARLY_DOCUMENT_SAMPLE ? text.slice(0, EARLY_DOCUMENT_SAMPLE) : text;
      if (head.length >= EARLY_DOCUMENT_SAMPLE) documentSettled = true;

      return mergeEarly(verdict, checkOutput(head, { ...checkOptions, ...DOCUMENT_ONLY }));
    },

    end(finishReason?: string): Verdict {
      return checkOutput(text, {
        ...checkOptions,
        finishReason: finishReason ?? checkOptions.finishReason,
      });
    },
  };
}

export interface GuardStreamOptions extends StreamGuardOptions {
  /**
   * Called the first time a mid-stream check fails. Abort your request here.
   *
   * The guard deliberately does not own the AbortController: the thing that
   * knows how to cancel a generation is the code that started it, and a
   * detection library that reaches into your transport is a library you
   * cannot use with the next transport.
   */
  onDegenerate?: (verdict: Verdict) => void;
  /**
   * Called once with the final verdict when the source ends normally. Skipped
   * when the stream was cut short, because a verdict on a deliberately
   * abandoned response would describe your own abort, not the model.
   */
  onEnd?: (verdict: Verdict) => void;
  /**
   * Stop yielding once degeneration is detected. Default true.
   *
   * Set false to keep passing chunks through while still being told -- useful
   * for a logging-only rollout, where you want the signal without changing
   * what the user sees.
   */
  stopOnDegenerate?: boolean;
}

/**
 * Wraps a chunk stream and cuts it off when the model starts looping.
 *
 * ```ts
 * const controller = new AbortController();
 * const guarded = guardStream(model.textStream, {
 *   ...presets.chat,
 *   onDegenerate: () => controller.abort(),
 * });
 * for await (const chunk of guarded) process.stdout.write(chunk);
 * ```
 *
 * Yields the source's chunks unchanged until then, so it drops into an
 * existing loop without touching what you do with the text.
 */
export async function* guardStream(
  source: AsyncIterable<string>,
  options: GuardStreamOptions = {},
): AsyncGenerator<string, void, undefined> {
  const { onDegenerate, onEnd, stopOnDegenerate = true, ...guardOptions } = options;
  const guard = createStreamGuard(guardOptions);
  let degenerate = false;

  for await (const chunk of source) {
    yield chunk;

    const verdict = guard.push(chunk);
    if (!verdict || verdict.ok || degenerate) continue;

    // Once, not on every subsequent check -- a loop keeps failing by
    // definition, and an abort handler called forty times is a bug report.
    degenerate = true;
    onDegenerate?.(verdict);
    if (stopOnDegenerate) return;
  }

  if (!degenerate) onEnd?.(guard.end());
}
