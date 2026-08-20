/**
 * Adapter for the `openai` SDK, and for anything speaking its protocol --
 * Groq, Together, OpenRouter, Fireworks, DeepInfra, vLLM, Ollama, or your own
 * gateway. If it works with an OpenAI-compatible `baseURL`, it works here.
 *
 * Structurally typed against the SDK rather than importing from it, so this
 * subpath adds no dependency, runtime or otherwise -- `openai` stays an
 * optional peer and the main entry point keeps having none. The shapes below
 * are the parts of the chat-completions contract this touches and nothing more.
 */
import type { StreamGuardOptions } from './stream.js';
import type { AdapterGuardOptions, DegenerateAction } from './internal/adapter-options.js';
import type { GuardedPath, Surface } from './internal/proxy-guard.js';
import { guardClient } from './internal/proxy-guard.js';

export type { DegenerateAction };

/** The parts of an assistant message this reads. */
interface MessageLike {
  content?: string | null;
  tool_calls?: ToolCallLike[] | null;
  /** The pre-`tool_calls` spelling. Still returned by older gateways. */
  function_call?: { arguments?: unknown } | null;
}

/**
 * One entry of `tool_calls`. `arguments` is a JSON **string**, not an object:
 * the model generated it token by token, which is exactly why it is worth
 * measuring.
 */
interface ToolCallLike {
  function?: { arguments?: unknown } | null;
}

/** One choice of a non-streaming `chat.completions.create`. */
interface CompletionChoice {
  message?: MessageLike | null;
  finish_reason?: string | null;
}

/** One choice of a streamed chunk. */
interface ChunkChoice {
  delta?: MessageLike | null;
  finish_reason?: string | null;
}

interface CompletionLike {
  choices?: CompletionChoice[];
}

interface ChunkLike {
  choices?: ChunkChoice[];
}

/** One item of a Responses API `output` array. */
interface OutputItem {
  type?: string;
  /** Present on `message` items. */
  content?: Array<{ type?: string; text?: string }> | null;
  /**
   * Present on tool-call items, as a JSON string. Every tool kind in this API
   * spells it `arguments`, so reading the field rather than switching on
   * `type` keeps this working for tool types that do not exist yet.
   */
  arguments?: unknown;
}

/** A finished `responses.create` result. */
interface ResponseLike {
  output?: OutputItem[] | null;
  /** The SDK's convenience concatenation. Used only as a fallback. */
  output_text?: string | null;
  incomplete_details?: { reason?: string | null } | null;
}

/** One event of a streamed `responses.create`. */
interface ResponseEventLike {
  type?: string;
  /** Present on `response.output_text.delta`. */
  delta?: string;
  /** Present on `response.output_item.added`. */
  item?: OutputItem | null;
  /** Present on the terminal `response.completed` / `response.incomplete`. */
  response?: ResponseLike | null;
}

export interface OutputGuardOptions extends StreamGuardOptions, AdapterGuardOptions {}

/**
 * OpenAI reports `'length'` when the model hit `max_tokens`, which is already
 * one of the stop reasons `truncationScore` treats as authoritative. Passing it
 * straight through is the whole mapping.
 */
function finishReasonOf(choices: Array<{ finish_reason?: string | null }> | undefined) {
  return choices?.find((c) => c.finish_reason)?.finish_reason ?? undefined;
}

/**
 * Whether a Responses `output` item is the model calling a tool.
 *
 * Defined by what it is *not*, because the alternative does not scale: the
 * output union is 28 members and all but two of them are tool calls of some
 * kind -- file search, web search, computer use, code interpreter, MCP, shell,
 * apply-patch, and whatever ships next quarter. An allow-list of two is stable;
 * a deny-list of twenty-six is a maintenance promise that would be broken by
 * the first new tool type, and broken in the direction that fails healthy
 * responses.
 */
const isToolCallItem = (item: OutputItem | null | undefined): boolean =>
  item?.type != null && item.type !== 'message' && item.type !== 'reasoning';

/**
 * How to read each of the two APIs.
 *
 * `chat.completions` and `responses` disagree about where the text lives, what
 * a tool call looks like, and how a stop reason is spelled -- but the guarding
 * itself is identical either way, and lives in `internal/proxy-guard.ts`. These
 * are that difference and nothing else.
 */
const CHAT_COMPLETIONS: Surface = {
  text: (value) => ((value as CompletionLike).choices ?? []).map((c) => c.message?.content ?? '').join(''),

  hasToolCalls: (value) =>
    ((value as CompletionLike).choices ?? []).some((c) => hasCall(c.message)),

  finishReason: (value) => finishReasonOf((value as CompletionLike).choices),

  chunk: (value) => {
    const choices = (value as ChunkLike).choices ?? [];
    return {
      delta: choices[0]?.delta?.content ?? '',
      toolCall: choices.some((c) => hasCall(c.delta)),
      finishReason: finishReasonOf(choices),
    };
  },

  toolArguments: (value) =>
    ((value as CompletionLike).choices ?? []).flatMap((choice) => [
      ...(choice.message?.tool_calls ?? []).map((call) => call?.function?.arguments),
      // The legacy spelling carries one call rather than a list.
      ...(choice.message?.function_call ? [choice.message.function_call.arguments] : []),
    ]),
};

/** Tool calls on a chat message or a streamed delta, either spelling. */
const hasCall = (message: MessageLike | null | undefined): boolean =>
  (message?.tool_calls?.length ?? 0) > 0 || message?.function_call != null;

const RESPONSES: Surface = {
  /*
   * Walked from `output` rather than read off `output_text`, because
   * `output_text` is an SDK convenience rather than a field the API sends --
   * it is absent from a raw envelope, from a gateway that reimplements the
   * protocol, and from a hand-built test double. `output_text` stays as the
   * fallback for the reverse case, where a caller has the concatenation but
   * not the items.
   */
  text: (value) => {
    const response = value as ResponseLike;
    const items = response.output;
    if (!items) return response.output_text ?? '';
    return items
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('');
  },

  hasToolCalls: (value) => ((value as ResponseLike).output ?? []).some(isToolCallItem),

  /*
   * Filtered by `isToolCallItem` rather than by looking for `arguments`, so
   * this stays consistent with what `hasToolCalls` counted as a tool call. An
   * item that is a tool call but carries no arguments contributes `undefined`,
   * which `argumentsToText` turns into the empty string and the check skips.
   */
  toolArguments: (value) =>
    ((value as ResponseLike).output ?? []).filter(isToolCallItem).map((item) => item.arguments),

  /*
   * `incomplete_details.reason` is this API's `finish_reason`, and its
   * `'max_output_tokens'` is already in `truncationScore`'s set of length
   * stops -- so, as with chat, passing it through is the whole mapping. The
   * other value it takes is `'content_filter'`, which is deliberately not a
   * length stop: a filtered response is a different failure from a truncated
   * one and should not be reported as `TRUNCATED`.
   */
  finishReason: (value) => (value as ResponseLike).incomplete_details?.reason ?? undefined,

  chunk: (value) => {
    const event = value as ResponseEventLike;
    return {
      delta: event.type === 'response.output_text.delta' ? (event.delta ?? '') : '',
      toolCall: event.type === 'response.output_item.added' && isToolCallItem(event.item),
      // Carried on the terminal `response.completed` / `response.incomplete`.
      finishReason: event.response
        ? (event.response.incomplete_details?.reason ?? undefined)
        : undefined,
    };
  },
};

/**
 * Every method this adapter intercepts. Nothing else on the client is touched.
 *
 * `responses.create` is here because leaving it out was worse than not
 * supporting the API at all: `withOutputGuard(new OpenAI())` returned a client
 * that looked guarded, and a caller on OpenAI's current default surface got
 * silence. A guard you believe in and do not have is the failure this package
 * was written about.
 *
 * **`responses.stream()` is deliberately absent.** It returns a `ResponseStream`
 * -- an event emitter with `.on()`, `.finalResponse()` and `.abort()`, not just
 * an async iterable -- and wrapping only its iteration would guard a `for await`
 * consumer while leaving `.finalResponse()` unchecked. That is the same
 * looks-guarded-but-is-not trap in a smaller box, so it is left plainly
 * unguarded and documented instead. Use `create({ stream: true })`, which is
 * guarded, or run `checkOutput` on `await stream.finalResponse()` yourself.
 */
const GUARDED: readonly GuardedPath[] = [
  { path: ['chat', 'completions', 'create'], surface: CHAT_COMPLETIONS },
  { path: ['responses', 'create'], surface: RESPONSES },
];

/**
 * Wraps an OpenAI client so every chat completion is checked.
 *
 * ```ts
 * import OpenAI from 'openai';
 * import { withOutputGuard } from 'llm-output-guard/openai';
 * import { presets } from 'llm-output-guard';
 *
 * const client = withOutputGuard(new OpenAI(), {
 *   ...presets.chat,
 *   onDegenerate: 'abort',
 * });
 * ```
 *
 * Both APIs are covered by that one call -- `chat.completions.create` and
 * `responses.create` -- and both of their shapes. On a non-streaming request
 * the tokens are already bought by the time anything can run, so all the guard
 * can do is stop a bad answer being used as a good one. On a stream it cancels
 * the request mid-generation, which is where it pays.
 *
 * A turn where the model calls a tool is not judged as prose: its text, if it
 * has any, is treated as a preamble rather than the answer. Without that, every
 * tool-calling turn fails on `EMPTY` -- see `internal/tool-calls.ts`.
 *
 * Everything else on the client is passed through untouched, including
 * `create`'s own return type -- so `.withResponse()` and friends still work.
 * Only the resolved value is inspected. See {@link GUARDED} for the one method
 * that is deliberately left unguarded, and why.
 */
export function withOutputGuard<T extends object>(client: T, options: OutputGuardOptions = {}): T {
  return guardClient(client, GUARDED, options);
}
