/**
 * Reading the prompt back out of a request, so `PROMPT_ECHO` can be switched on
 * from an adapter rather than only from `checkOutput`.
 *
 * Every provider spells this differently and all of them agree on the shape:
 * an ordered list of messages, each with a role and a content that is either a
 * string or a list of parts. This normalises that once, because three
 * hand-maintained copies of it is how one of them quietly stops matching the
 * others.
 *
 * ## Assistant turns are deliberately excluded
 *
 * The failure being measured is a model replaying its **input**. Prior
 * assistant turns are its own output, and including them creates a false
 * positive that grows with conversation length: a model that consistently uses
 * the same terminology it used three turns ago is doing its job, and every
 * repeated five-word run would count against it.
 *
 * Excluding them costs nothing in coverage. A model that loses the turn
 * boundary and replays the whole transcript replays the system and user text
 * too, so it still scores high on what is left.
 *
 * ## This module is INTERNAL. It is not public API, at 1.0 or after.
 */

/** Roles whose text the model was given rather than produced. */
const INPUT_ROLES = new Set(['system', 'developer', 'user', 'human']);

/**
 * Text of one message's `content`, which is a string on the simple path and a
 * list of parts on the multimodal one. Non-text parts (images, audio, files)
 * contribute nothing, which is correct: they are not text the model could echo.
 */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') return text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Join the input-role messages of a conversation into one prompt.
 *
 * Order is preserved, and nothing is truncated here: `promptEchoScore` applies
 * its own `maxSample` to whichever side is longer, which keeps the sampling
 * rule in one place.
 */
export function promptFromMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  const parts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = (message as { role?: unknown }).role;
    // A message with no role at all is input by default: the Responses API
    // accepts bare strings in `input`, and those are the user's words.
    if (typeof role === 'string' && !INPUT_ROLES.has(role)) continue;
    const text = contentText((message as { content?: unknown }).content);
    if (text.trim().length > 0) parts.push(text);
  }
  return parts.join('\n\n');
}

/**
 * Fold a separate system prompt in front of the messages, for the providers
 * that carry it outside the list -- Anthropic's `system`, the Responses API's
 * `instructions`.
 */
export function withSystem(system: unknown, messages: string): string {
  const head = contentText(system).trim();
  if (head.length === 0) return messages;
  return messages.length > 0 ? `${head}\n\n${messages}` : head;
}
