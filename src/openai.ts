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
import type { Verdict } from './types.js';
import type { StreamGuardOptions } from './stream.js';
import type { AdapterGuardOptions, DegenerateAction } from './internal/adapter-options.js';
import { checkOutput, DegenerateOutputError } from './check.js';
import { createStreamGuard } from './stream.js';
import { checkPreamble } from './internal/tool-calls.js';

export type { DegenerateAction };

/** The parts of an assistant message this reads. */
interface MessageLike {
  content?: string | null;
  tool_calls?: unknown[] | null;
  /** The pre-`tool_calls` spelling. Still returned by older gateways. */
  function_call?: unknown;
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

/**
 * The SDK's `Stream`, reduced to what this needs.
 *
 * `controller` is the load-bearing part. The SDK registers an `abort` listener
 * that calls `reader.cancel()` on the response body, so aborting it closes the
 * HTTP connection rather than merely ending our iteration -- which is the
 * difference between not being billed and being billed while looking away.
 */
interface StreamLike extends AsyncIterable<ChunkLike> {
  controller?: { abort(reason?: unknown): void };
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

function isStream(value: unknown): value is StreamLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StreamLike)[Symbol.asyncIterator] === 'function'
  );
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
 * How to read one of the two APIs.
 *
 * `chat.completions` and `responses` disagree about where the text lives, what
 * a tool call looks like, and how a stop reason is spelled -- but the guarding
 * itself is identical either way. This is that difference, isolated, so the
 * logic below is written once. Adding a third API means adding a `Surface`.
 */
interface Surface {
  /** Assistant text in a finished response. */
  text(value: object): string;
  /** True when the model answered with a tool call rather than (only) prose. */
  hasToolCalls(value: object): boolean;
  /** The provider's stop reason, if it reported one. */
  finishReason(value: object): string | undefined;
  /** What one streamed chunk contributes. */
  chunk(value: object): { delta: string; toolCall: boolean; finishReason?: string };
}

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

interface GuardedPath {
  /** Property names from the client down to the method to wrap. */
  path: readonly string[];
  surface: Surface;
}

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
  const { onDegenerate = 'throw', onVerdict, ...guardOptions } = options;

  const act = (verdict: Verdict, streaming: boolean): void => {
    onVerdict?.(verdict, { streaming });
    if (verdict.ok || onDegenerate === 'ignore') return;
    if (onDegenerate === 'throw') throw new DegenerateOutputError(verdict);
  };

  /** Non-streaming: check the finished text, including its stop reason. */
  const guardCompletion = (surface: Surface, completion: object): object => {
    /*
     * A tool call is an answer, just not a textual one. Judging its (absent)
     * text as a response would fail every tool-calling turn on `EMPTY` -- see
     * `internal/tool-calls.ts` for why that is the detector being asked the
     * wrong question rather than the detector being wrong.
     */
    if (surface.hasToolCalls(completion)) {
      const verdict = checkPreamble(surface.text(completion), guardOptions);
      if (verdict) act(verdict, false);
      return completion;
    }

    act(
      checkOutput(surface.text(completion), {
        ...guardOptions,
        finishReason: surface.finishReason(completion) ?? guardOptions.finishReason,
      }),
      false,
    );
    return completion;
  };

  /**
   * Streaming: watch deltas and cancel the request when a loop shows up.
   *
   * The chunks already received are forwarded first -- withholding a chunk that
   * has been generated and paid for buys nothing but a shorter answer. The
   * saving is entirely in the chunks the provider is never asked to produce.
   */
  const guardStream = (surface: Surface, stream: StreamLike): StreamLike => {
    const guard = createStreamGuard(guardOptions);

    async function* guarded(): AsyncGenerator<object, void, undefined> {
      let fired = false;
      let sawToolCall = false;
      let finishReason: string | undefined;

      for await (const chunk of stream) {
        yield chunk;

        const read = surface.chunk(chunk as object);
        finishReason = read.finishReason ?? finishReason;
        if (read.toolCall) sawToolCall = true;
        if (fired) continue;

        const verdict = guard.push(read.delta);
        if (!verdict || verdict.ok) continue;

        fired = true;
        onVerdict?.(verdict, { streaming: true });
        if (onDegenerate === 'ignore') continue;

        /*
         * The line the package exists for. It reaches the transport: the SDK
         * listens on this controller and calls `reader.cancel()` on the
         * response body, so the connection closes and the provider stops
         * generating. Merely ending our own iteration would leave the model
         * running -- and billing -- while we looked away.
         *
         * Deliberate redundancy: exiting this generator also triggers the SDK's
         * own iterator cleanup, which aborts too. That path depends on the
         * consumer running iteration cleanup at all, which a hand-rolled
         * `.next()` loop need not do. Calling it here does not depend on how
         * anyone iterates.
         */
        stream.controller?.abort();
        if (onDegenerate === 'throw') throw new DegenerateOutputError(verdict);
        return;
      }

      // A stream we cut short would only be reported as truncated by us,
      // describing our own abort rather than the model.
      if (fired) return;

      /*
       * Same rule as the non-streaming path, and it matters here even though
       * nothing throws: a tool-call stream carries no text deltas, so `end()`
       * would report `EMPTY: 1` to `onVerdict` on every one. Those samples are
       * what a `calibrate` run is built from, and a spike of them describes the
       * agent's tool use rather than any degeneration.
       */
      if (sawToolCall) {
        const verdict = checkPreamble(guard.text, guardOptions);
        if (verdict) onVerdict?.(verdict, { streaming: true });
        return;
      }

      onVerdict?.(guard.end(finishReason), { streaming: true });
    }

    // Everything the SDK returned, with only the iteration wrapped -- `tee()`,
    // `toReadableStream()` and `controller` all still resolve to the original.
    return new Proxy(stream, {
      get(target, prop, receiver) {
        if (prop === Symbol.asyncIterator) return guarded;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  const wrapCreate = (create: (...args: unknown[]) => unknown, surface: Surface) =>
    function (this: unknown, ...args: unknown[]) {
      const result = create.apply(this, args);
      if (!result || typeof (result as PromiseLike<unknown>).then !== 'function') return result;

      /*
       * The SDK returns an `APIPromise`, not a plain promise: it carries
       * `.withResponse()`, `.asResponse()` and similar. Proxying it rather than
       * replacing it with `.then(...)` keeps those working, and keeps the
       * declared return type honest.
       */
      return new Proxy(result as object, {
        get(target, prop, receiver) {
          if (prop === 'then') {
            /*
             * `Promise.resolve` here, not `Promise.prototype.then.call`.
             * `APIPromise` extends `Promise` with a constructor that takes a
             * client and a response rather than an executor, so `then`'s
             * species construction tries to build one with an executor and
             * dies with "Promise resolve or reject function is not callable".
             * Adopting it as a thenable calls its own `then`, which is the one
             * `await` uses and the one that works.
             */
            return (onOk?: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
              Promise.resolve(target as PromiseLike<unknown>)
                .then((value) =>
                  isStream(value)
                    ? guardStream(surface, value)
                    : guardCompletion(surface, value as object),
                )
                .then(onOk as never, onErr as never);
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

  /**
   * Proxies only the paths in {@link GUARDED}, carrying each one's surface down
   * to the `create` at its end. Every other property resolves to the real thing.
   */
  const proxyPaths = (target: object, guarded: readonly GuardedPath[]): object =>
    new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        const matching = guarded.filter((g) => g.path[0] === prop);
        if (matching.length === 0) return typeof value === 'function' ? value.bind(obj) : value;

        const terminal = matching.find((g) => g.path.length === 1);
        if (terminal && typeof value === 'function') {
          return wrapCreate(value.bind(obj) as (...args: unknown[]) => unknown, terminal.surface);
        }

        const deeper = matching
          .filter((g) => g.path.length > 1)
          .map((g) => ({ path: g.path.slice(1), surface: g.surface }));
        if (deeper.length === 0 || !value || typeof value !== 'object') {
          return typeof value === 'function' ? value.bind(obj) : value;
        }

        return proxyPaths(value as object, deeper);
      },
    });

  return proxyPaths(client, GUARDED) as T;
}
