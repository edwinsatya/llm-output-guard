import type { StandardSchemaV1 } from './standard-schema.js';
import type { ScriptName } from './detectors/script.js';

export type ReasonCode =
  | 'EMPTY'
  | 'TOO_SHORT'
  | 'REPETITION'
  | 'TAIL_LOOP'
  | 'LOW_ENTROPY'
  | 'TRUNCATED'
  | 'INVALID_JSON'
  | 'SCRIPT_MISMATCH'
  | 'LANG_MISMATCH'
  | 'PROMPT_ECHO';

/**
 * Which tokenizer produced a score.
 *
 * `word` splits on runs of letters and digits, which is every script that puts
 * spaces or punctuation between words. `char` counts code points instead, for
 * Chinese, Japanese and Thai, where a whole clause is a single `word` token and
 * a word-based detector has nothing to measure.
 *
 * The two are different distributions, not two ways of saying the same number,
 * so a score is only meaningful next to the mode that produced it.
 */
export type TokenMode = 'word' | 'char';

export interface Reason {
  code: ReasonCode;
  /** 0..1. Higher means more suspicious. */
  score: number;
  /** The threshold this score crossed. */
  threshold: number;
  /** Human-readable explanation, safe to log. */
  message: string;
  /**
   * Which tokenizer produced `score`, on the detectors that have more than
   * one. Absent on detectors that do not tokenize, or tokenize one way only.
   */
  mode?: TokenMode;
}

export interface Verdict {
  /** True when nothing crossed its threshold. */
  ok: boolean;
  /** Every failing signal, not just the first -- more useful when debugging. */
  reasons: Reason[];
  /** Every score computed, including passing ones. Feed these to your metrics. */
  scores: Partial<Record<ReasonCode, number>>;
  /**
   * Which tokenizer produced each score, for the detectors that have more than
   * one. Log this alongside `scores`: a `TAIL_LOOP` of 0.6 means different
   * things in the two modes, and aggregating both into one histogram produces a
   * number that describes neither. `calibrate` segments on it for that reason.
   */
  modes?: Partial<Record<ReasonCode, TokenMode>>;
  /** Parsed JSON payload when `json` was enabled and parsing succeeded. */
  json?: unknown;
}

export interface CheckOptions {
  /** Minimum acceptable length in characters. Set 0 to disable. Default 1. */
  minLength?: number;
  /** Duplicate-n-gram threshold. Set null to disable. Default 0.35. */
  maxRepetition?: number | null;
  /** Tail-loop threshold, word mode. Set null to disable. Default 0.5. */
  maxTailLoop?: number | null;
  /**
   * Tail-loop threshold for text in a script written without spaces between
   * words. Set null to disable. Default 0.7.
   *
   * A separate option because it is a separate distribution, not a stricter
   * reading of the same one. Character n-grams duplicate at a different base
   * rate than word n-grams, so one number cannot describe both -- and a
   * threshold you calibrated on Latin traffic would be numerically wrong here,
   * not merely conservative.
   */
  maxCharTailLoop?: number | null;
  /**
   * Share of a span's letters that must be in a non-spaced script (Han,
   * Hiragana, Katakana, Thai) before character tokenization takes over.
   * Default 0.5.
   *
   * Applied per detector, to the span that detector actually reads -- so a
   * response that answers in English and then loops in Chinese puts the tail
   * detector in character mode without dragging the rest of the check with it.
   */
  nonSpacedCutoff?: number;
  /** Compressibility threshold. Set null to disable. Default 0.75. */
  maxCompressibility?: number | null;
  /** Truncation threshold. Set null to disable. Default null. */
  maxTruncation?: number | null;
  /** Provider stop reason, used by the truncation detector when present. */
  finishReason?: string;
  /** Require a parseable JSON payload. Default false. */
  expectJson?: boolean;
  /** Allow the JSON payload to be wrapped in a fence. Default true. */
  allowJsonFence?: boolean;
  /** Top-level keys the JSON payload must contain. */
  requiredKeys?: string[];
  /**
   * A Standard Schema validator the JSON payload must satisfy -- Zod 4,
   * Valibot, ArkType, or your own. Requires `expectJson`.
   *
   * Strictly stronger than `requiredKeys`: that asks only whether a name is
   * present, and a model returning `{ score: "very good" }` where you wanted a
   * number satisfies it. The two compose, and keys are checked first, so a
   * missing key is still reported as a missing key.
   *
   * On success `Verdict.json` is the schema's *output* -- defaults, coercions
   * and transforms applied -- rather than the raw parse.
   *
   * **Must validate synchronously.** `checkOutput` is synchronous by design, so
   * a schema carrying an async refinement throws a `TypeError` rather than
   * silently passing. Everything Zod, Valibot and ArkType produce otherwise is
   * synchronous.
   */
  schema?: StandardSchemaV1;
  /**
   * Script the response must be written in, or several. Off by default.
   *
   * The blunt half of language checking, and the reliable half. `expectLang`
   * asks *which language is this* from function words and knows three of them;
   * this asks *is this even the right alphabet*, which needs no word list and
   * is decisive from about a dozen letters. Measured on this repo's corpus, a
   * response answered entirely in the wrong script scores 1.000, and a healthy
   * response measured against its own script scores 0.000-0.028.
   *
   * Pass every script an answer may legitimately contain. Japanese is
   * `['han', 'kana']`; a technical answer in any non-Latin script usually wants
   * `'latin'` alongside it, because a Chinese answer about React still contains
   * `useEffect`. Code fences, inline code and URLs are excluded before
   * measuring, so a code block does not count as an answer in English.
   *
   * Same script means no signal: Spanish against English scores 0. That is
   * `expectLang`'s job, and the two compose -- they report separate codes and
   * separate scores, because they are separate distributions.
   */
  expectScript?: ScriptName | readonly ScriptName[] | null;
  /**
   * Script-mismatch threshold. Default 0.5 -- a majority of the letters are in
   * an alphabet you did not ask for.
   *
   * Not interchangeable with `maxLangMismatch`, which reads a relative share of
   * function words. This one is a plain share of letters, so 0.5 means half.
   */
  maxScriptMismatch?: number;
  /**
   * The prompt you sent, so the output can be checked for copying it back.
   * Off by default: with no prompt the detector abstains.
   *
   * Pass everything the model saw, system and user together. A model that
   * loses track of the turn boundary echoes whichever part it landed on, and a
   * check that only knows the user message misses a leaked system prompt,
   * which is the more common and the more embarrassing of the two.
   *
   * **Do not enable this on a rewrite, translate, summarise or extract
   * endpoint.** Copying from the input is the job on those, so a correct
   * answer scores high and the detector is measuring the task rather than a
   * failure. There is no signal that separates them.
   */
  prompt?: string | null;
  /**
   * Prompt-echo threshold. Default 0.6.
   *
   * Measured on this repo's cases: a full echo of the prompt scores 1.000 and
   * an echoed system prompt 0.953, while every output that actually contains
   * an answer stays at or below 0.463 even when it leaks the question first.
   * The default sits between those. Lower it toward 0.4 to catch a response
   * that answers *and* leaks, and expect to see ordinary preamble with it.
   */
  maxPromptEcho?: number;
  /** Expected language code ('id' | 'en' | 'es'). Off by default. */
  expectLang?: string | null;
  /** Language-mismatch threshold. Default 0.6. */
  maxLangMismatch?: number;
  /** N-gram size for the repetition detector. Default 3. */
  ngram?: number;
  /**
   * Which spans `REPETITION` and `TAIL_LOOP` read. Default `'document'`.
   *
   * `'document'` measures the whole response at once, which is right for prose
   * and wrong for a JSON array: twenty identical rows are exactly periodic, so
   * a model that correctly reported twenty healthy services scores
   * `TAIL_LOOP: 1.000` and fails. Three identical records is enough.
   *
   * `'jsonValues'` measures each string value of a parsed payload on its own,
   * on the rule that repetition **across records** is the shape that was asked
   * for and repetition **inside a value** is the signal. Strictly more
   * sensitive, not less -- a loop confined to one array element is diluted to
   * nothing across a document and reads clearly on its own.
   *
   * Text that does not parse is measured as a document regardless, so prose, a
   * truncated payload and every mid-stream check behave exactly as before.
   *
   * Only the redundancy detectors are affected. `TRUNCATED`, `INVALID_JSON`,
   * `EMPTY`, `TOO_SHORT`, `LOW_ENTROPY` and `LANG_MISMATCH` read the response
   * as they always have.
   */
  redundancyScope?: 'document' | 'jsonValues';
}
