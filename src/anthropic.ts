/**
 * Adapter for the `@anthropic-ai/sdk` Messages API.
 *
 * Structurally typed against the SDK rather than importing from it, so this
 * subpath adds no dependency, runtime or otherwise -- `@anthropic-ai/sdk` stays
 * an optional peer and the main entry point keeps having none. The shapes below
 * are the parts of the Messages contract this touches and nothing more.
 *
 * The guarding itself lives in `internal/proxy-guard.ts`, shared with
 * `./openai`. The two SDKs are the same shape where it counts -- a resource tree
 * ending in `create`, an `APIPromise extends Promise` for one response, a
 * `Stream` carrying an `AbortController` for a streamed one -- so only the three
 * things below actually differ between them.
 */
import type { StreamGuardOptions } from './stream.js';
import type { AdapterGuardOptions, DegenerateAction } from './internal/adapter-options.js';
import type { GuardedPath, Surface } from './internal/proxy-guard.js';
import { guardClient } from './internal/proxy-guard.js';
import { promptFromMessages, withSystem } from './internal/prompt-text.js';
import type { AgentTurn } from './agent-types.js';
import { asArray } from './internal/as-array.js';

export type { DegenerateAction };

/** One block of a finished message's `content` array. */
interface ContentBlock {
  type?: string;
  /** Present on `text` blocks. */
  text?: string;
  /** Present on tool blocks. Read only by {@link toTurn}. */
  name?: string;
  /**
   * Present on `tool_use` blocks, already parsed into an object rather than
   * left as the JSON string OpenAI sends. `argumentsToText` serialises it back
   * so both providers reach the detectors by the same path.
   */
  input?: unknown;
}

/** A finished `messages.create` result. */
interface MessageLike {
  content?: ContentBlock[] | null;
  stop_reason?: string | null;
}

/** One event of a streamed `messages.create`. */
interface MessageEventLike {
  type?: string;
  /** Present on `content_block_start`. */
  content_block?: ContentBlock | null;
  /**
   * Present on `content_block_delta` (a `text_delta` carries `text`) and on
   * `message_delta` (which carries `stop_reason`).
   */
  delta?: { type?: string; text?: string; stop_reason?: string | null } | null;
}

export interface OutputGuardOptions extends StreamGuardOptions, AdapterGuardOptions {}

/**
 * Whether a content block is the model calling a tool.
 *
 * Defined by what it is *not*, for the same reason as the Responses adapter: the
 * block union is twelve members and all but three of them are tool traffic --
 * `tool_use`, `server_tool_use`, and result blocks for web search, web fetch,
 * code execution, bash, the text editor, tool search and container uploads. An
 * allow-list of three is stable; a deny-list of nine would be broken by the
 * first new server tool, and broken in the direction that fails healthy
 * responses.
 *
 * `thinking` and `redacted_thinking` sit on the allow-list beside `text`
 * because extended thinking is not a tool call and must not put the guard into
 * preamble mode. They are not read as *text* either -- see {@link MESSAGES}.
 */
const isToolBlock = (block: ContentBlock | null | undefined): boolean =>
  block?.type != null &&
  block.type !== 'text' &&
  block.type !== 'thinking' &&
  block.type !== 'redacted_thinking';

/**
 * Anthropic's `stop_reason`, normalised to what `truncationScore` expects.
 *
 * `max_tokens` is already one of the stop reasons it treats as authoritative, so
 * that one passes straight through. `model_context_window_exceeded` is the same
 * event under a different name -- the response was cut off because there was no
 * room left for it -- so it is mapped rather than being added to the detector's
 * own set, which would spend a shared vocabulary on one provider's spelling.
 *
 * Everything else is passed through and lands below every threshold: `end_turn`
 * and `stop_sequence` are healthy completions, `tool_use` is handled as a tool
 * call before this is consulted, and `pause_turn` means a long-running turn is
 * to be continued rather than that anything went wrong. `refusal` is deliberately
 * not treated as truncation either: a refusal is a complete response that says
 * no, which is a content judgement this package does not make.
 */
function normaliseStop(stop: string | null | undefined): string | undefined {
  if (!stop) return undefined;
  return stop === 'model_context_window_exceeded' ? 'max_tokens' : stop;
}

/**
 * How to read the Messages API.
 *
 * `thinking` blocks are excluded from the text on purpose. They are the model's
 * reasoning rather than its answer, they are frequently longer than the answer,
 * and they repeat themselves as a matter of course while working a problem --
 * so folding them into the text measured for redundancy would raise every
 * repetition score on every extended-thinking response and flag the ones that
 * thought hardest.
 */
const MESSAGES: Surface = {
  text: (value) =>
    ((value as MessageLike).content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join(''),

  hasToolCalls: (value) => ((value as MessageLike).content ?? []).some(isToolBlock),

  finishReason: (value) => normaliseStop((value as MessageLike).stop_reason),

  /*
   * `isToolBlock` again, so this covers exactly the blocks that put the guard
   * into preamble mode -- including the server tools, whose inputs are
   * model-generated in the same way and can loop in the same way.
   */
  /*
   * `system` sits beside `messages` rather than inside it, and is either a
   * string or a list of blocks depending on whether the caller used caching.
   */
  promptFrom: (request) => {
    const req = request as { system?: unknown; messages?: unknown } | undefined;
    return withSystem(req?.system, promptFromMessages(req?.messages)) || undefined;
  },

  toolArguments: (value) =>
    ((value as MessageLike).content ?? []).filter(isToolBlock).map((block) => block.input),

  chunk: (value) => {
    const event = value as MessageEventLike;
    return {
      // Only `text_delta` is the answer. `thinking_delta` and `input_json_delta`
      // arrive on the same event type and are deliberately not read as text.
      delta:
        event.type === 'content_block_delta' && event.delta?.type === 'text_delta'
          ? (event.delta.text ?? '')
          : '',
      toolCall: event.type === 'content_block_start' && isToolBlock(event.content_block),
      // Carried on `message_delta`, which arrives once near the end of a stream.
      finishReason:
        event.type === 'message_delta' ? normaliseStop(event.delta?.stop_reason) : undefined,
    };
  },
};

/**
 * Every method this adapter intercepts. Nothing else on the client is touched.
 *
 * **`messages.stream()` is deliberately absent**, for the same reason
 * `./openai` leaves `responses.stream()` alone. It returns a `MessageStream` --
 * an event emitter with `.on()`, `.finalMessage()` and `.abort()`, not merely an
 * async iterable -- and wrapping only its iteration would guard a `for await`
 * consumer while leaving `.finalMessage()` unchecked. A guard you believe in and
 * do not have is the failure this package was written about, so it is left
 * plainly unguarded and documented instead. Use `create({ stream: true })`,
 * which is guarded, or run `checkOutput` on `await stream.finalMessage()`
 * yourself.
 *
 * `messages.batches` is absent too, and less interestingly: a batch is retrieved
 * later as a file of results rather than returned from `create`, so there is no
 * response here to inspect. Check those with `checkOutput` when you read them.
 */
const GUARDED: readonly GuardedPath[] = [{ path: ['messages', 'create'], surface: MESSAGES }];

/**
 * Wraps an Anthropic client so every message is checked.
 *
 * ```ts
 * import Anthropic from '@anthropic-ai/sdk';
 * import { withOutputGuard } from 'llm-output-guard/anthropic';
 * import { presets } from 'llm-output-guard';
 *
 * const client = withOutputGuard(new Anthropic(), {
 *   ...presets.chat,
 *   onDegenerate: 'abort',
 * });
 * ```
 *
 * Both shapes are guarded by that one call. On a non-streaming request the
 * tokens are already bought by the time anything can run, so all the guard can
 * do is stop a bad answer being used as a good one. On a stream it cancels the
 * request mid-generation, which is where it pays.
 *
 * A turn where the model calls a tool is not judged as prose: its text, if it
 * has any, is treated as a preamble rather than the answer. Extended-thinking
 * blocks are not read as text at all -- see {@link MESSAGES}.
 *
 * Everything else on the client is passed through untouched, including
 * `create`'s own return type -- so `.withResponse()` and friends still work.
 * Only the resolved value is inspected. See {@link GUARDED} for what is
 * deliberately left unguarded, and why.
 */
export function withOutputGuard<T extends object>(client: T, options: OutputGuardOptions = {}): T {
  return guardClient(client, GUARDED, options);
}

/**
 * One `messages.create` result as an {@link AgentTurn}, for
 * `llm-output-guard/agent`.
 *
 * `input` arrives already parsed, where OpenAI sends a JSON string. Both
 * fingerprint identically -- `canonicalArguments` parses the string before
 * canonicalising -- so a trace assembled from mixed providers still compares.
 *
 * Tool blocks are selected with the adapter's own `isToolBlock`, so this counts
 * exactly what puts the guard into preamble mode: `tool_use` and every server
 * tool beside it. Thinking blocks are neither text nor a call, and contribute
 * nothing -- reading them as text would fingerprint a turn by its reasoning,
 * which varies even when the action taken is identical, and that is how a real
 * loop scores zero.
 */
export function toTurn(message: unknown): AgentTurn {
  if (message == null || typeof message !== 'object') return {};
  const content = asArray<ContentBlock>((message as MessageLike).content);
  return {
    text: content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join(''),
    toolCalls: content
      .filter(isToolBlock)
      .map((block) => ({ name: block.name, arguments: block.input })),
  };
}
