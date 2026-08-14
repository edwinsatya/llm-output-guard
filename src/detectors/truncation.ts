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
/**
 * Whether the text is a complete JSON document.
 *
 * Gated on the first character so prose costs one comparison rather than a
 * parse attempt: `JSON.parse` on a paragraph throws, but only after scanning it.
 */
function isCompleteJson(trimmed: string): boolean {
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function truncationScore(text: string, options: TruncationOptions = {}): number {
  const { finishReason } = options;
  if (finishReason && LENGTH_STOPS.has(finishReason.toLowerCase())) return 1;

  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;

  /*
   * The structural heuristics below count brackets and fences across the raw
   * text, including inside string literals -- so `{"note":"a { b"}` reads as
   * one unclosed brace and scored 0.8, and `{"snippet":"```js"}` as an unclosed
   * fence at 0.9. Both are complete, valid JSON.
   *
   * A document that parses is complete by definition, which is stronger
   * evidence than any of those heuristics were reaching for. The provider's own
   * stop reason is checked above and still wins, because a payload can be both
   * parseable and cut short at the token ceiling.
   */
  if (isCompleteJson(trimmed)) return 0;

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
