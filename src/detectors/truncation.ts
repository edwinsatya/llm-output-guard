export interface TruncationOptions {
  /**
   * The provider's own stop reason, if you have it. When this says the output
   * hit the token ceiling, that is authoritative and the heuristics are skipped.
   */
  finishReason?: string;
}

const LENGTH_STOPS = new Set(['length', 'max_tokens', 'maxtokens', 'max_output_tokens', 'token_limit']);
const TERMINAL = /[.!?"'`\u2019\u201d)\]}:;\u3002\uff01\uff1f]\s*$/;

/**
 * Detects output that stopped mid-thought.
 *
 * Prefers the provider's finish_reason when supplied, because that is ground
 * truth. Falls back to structural signals: unbalanced fences or brackets, or a
 * final sentence with no terminal punctuation.
 *
 * Returns a graded score, not a boolean -- a missing full stop alone is weak
 * evidence and should not sink a response on its own.
 */
export function truncationScore(text: string, options: TruncationOptions = {}): number {
  const { finishReason } = options;
  if (finishReason && LENGTH_STOPS.has(finishReason.toLowerCase())) return 1;

  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;

  let score = 0;

  const fences = (trimmed.match(/```/g) ?? []).length;
  if (fences % 2 === 1) score = Math.max(score, 0.9);

  for (const [open, close] of [['{', '}'], ['[', ']'], ['(', ')']] as const) {
    const opens = trimmed.split(open).length - 1;
    const closes = trimmed.split(close).length - 1;
    if (opens > closes) score = Math.max(score, 0.8);
  }

  if (!TERMINAL.test(trimmed)) score = Math.max(score, 0.55);

  return score;
}
