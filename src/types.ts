export type ReasonCode =
  | 'EMPTY'
  | 'TOO_SHORT'
  | 'REPETITION'
  | 'TAIL_LOOP'
  | 'LOW_ENTROPY'
  | 'TRUNCATED'
  | 'INVALID_JSON'
  | 'LANG_MISMATCH';

export interface Reason {
  code: ReasonCode;
  /** 0..1. Higher means more suspicious. */
  score: number;
  /** The threshold this score crossed. */
  threshold: number;
  /** Human-readable explanation, safe to log. */
  message: string;
}

export interface Verdict {
  /** True when nothing crossed its threshold. */
  ok: boolean;
  /** Every failing signal, not just the first -- more useful when debugging. */
  reasons: Reason[];
  /** Every score computed, including passing ones. Feed these to your metrics. */
  scores: Partial<Record<ReasonCode, number>>;
  /** Parsed JSON payload when `json` was enabled and parsing succeeded. */
  json?: unknown;
}

export interface CheckOptions {
  /** Minimum acceptable length in characters. Set 0 to disable. Default 1. */
  minLength?: number;
  /** Duplicate-n-gram threshold. Set null to disable. Default 0.35. */
  maxRepetition?: number | null;
  /** Tail-loop threshold. Set null to disable. Default 0.5. */
  maxTailLoop?: number | null;
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
  /** Expected language code ('id' | 'en' | 'es'). Off by default. */
  expectLang?: string | null;
  /** Language-mismatch threshold. Default 0.6. */
  maxLangMismatch?: number;
  /** N-gram size for the repetition detector. Default 3. */
  ngram?: number;
}
