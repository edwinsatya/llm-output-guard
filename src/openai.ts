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

export type { DegenerateAction };

/** One choice of a non-streaming `chat.completions.create`. */
interface CompletionChoice {
  message?: { content?: string | null } | null;
  finish_reason?: string | null;
}

/** One choice of a streamed chunk. */
interface ChunkChoice {
  delta?: { content?: string | null } | null;
  finish_reason?: string | null;
}

interface CompletionLike {
  choices?: CompletionChoice[];
}

interface ChunkLike {
  choices?: ChunkChoice[];
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

/** Concatenated assistant text across choices. */
function textOf(completion: CompletionLike): string {
  return (completion.choices ?? []).map((c) => c.message?.content ?? '').join('');
}

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
 * Both shapes are guarded by that one call. On a non-streaming request the
 * tokens are already bought by the time anything can run, so all the guard can
 * do is stop a bad answer being used as a good one. On a stream it cancels the
 * request mid-generation, which is where it pays.
 *
 * Everything else on the client is passed through untouched, including
 * `chat.completions.create`'s own return type -- so `.withResponse()` and
 * friends still work. Only the resolved value is inspected.
 */
export function withOutputGuard<T extends object>(client: T, options: OutputGuardOptions = {}): T {
  const { onDegenerate = 'throw', onVerdict, ...guardOptions } = options;

  const act = (verdict: Verdict, streaming: boolean): void => {
    onVerdict?.(verdict, { streaming });
    if (verdict.ok || onDegenerate === 'ignore') return;
    if (onDegenerate === 'throw') throw new DegenerateOutputError(verdict);
  };

  /** Non-streaming: check the finished text, including its stop reason. */
  const guardCompletion = (completion: CompletionLike): CompletionLike => {
    act(
      checkOutput(textOf(completion), {
        ...guardOptions,
        finishReason: finishReasonOf(completion.choices) ?? guardOptions.finishReason,
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
  const guardStream = (stream: StreamLike): StreamLike => {
    const guard = createStreamGuard(guardOptions);

    async function* guarded(): AsyncGenerator<ChunkLike, void, undefined> {
      let fired = false;
      let finishReason: string | undefined;

      for await (const chunk of stream) {
        yield chunk;

        finishReason = finishReasonOf(chunk.choices) ?? finishReason;
        if (fired) continue;

        const verdict = guard.push(chunk.choices?.[0]?.delta?.content ?? '');
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
      if (!fired) onVerdict?.(guard.end(finishReason), { streaming: true });
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

  const wrapCreate = (create: (...args: unknown[]) => unknown) =>
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
                  isStream(value) ? guardStream(value) : guardCompletion(value as CompletionLike),
                )
                .then(onOk as never, onErr as never);
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

  /** Proxies only the path down to `chat.completions.create`. */
  const proxyPath = (target: object, path: readonly string[]): object =>
    new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (prop !== path[0]) return typeof value === 'function' ? value.bind(obj) : value;
        if (path.length === 1 && typeof value === 'function') {
          return wrapCreate(value.bind(obj) as (...args: unknown[]) => unknown);
        }
        return value && typeof value === 'object'
          ? proxyPath(value as object, path.slice(1))
          : value;
      },
    });

  return proxyPath(client, ['chat', 'completions', 'create']) as T;
}
