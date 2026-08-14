import type { StandardSchemaV1 } from './standard-schema.js';

export type ReasonCode =
  | 'EMPTY'
  | 'TOO_SHORT'
  | 'REPETITION'
  | 'TAIL_LOOP'
  | 'LOW_ENTROPY'
  | 'TRUNCATED'
  | 'INVALID_JSON'
  | 'LANG_MISMATCH';

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
  /** Expected language code ('id' | 'en' | 'es'). Off by default. */
  expectLang?: string | null;
  /** Language-mismatch threshold. Default 0.6. */
  maxLangMismatch?: number;
  /** N-gram size for the repetition detector. Default 3. */
  ngram?: number;
}
