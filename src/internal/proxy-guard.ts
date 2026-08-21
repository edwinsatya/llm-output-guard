/**
 * The client-wrapping machinery behind `./openai` and `./anthropic`.
 *
 * Both SDKs are the same shape where it counts: a resource tree with a `create`
 * at the end of it, returning an `APIPromise extends Promise` for a single
 * response or a `Stream` carrying an `AbortController` for a streamed one. The
 * guarding is therefore identical, and only three things differ between
 * providers -- where the text lives, what a tool call looks like, and how a stop
 * reason is spelled. Those are a {@link Surface}; everything else is here.
 *
 * Written once because the tricky parts are not the parts that vary. Proxying an
 * `APIPromise` without breaking `.withResponse()`, adopting it as a thenable so
 * species construction does not blow up, aborting the transport rather than just
 * the iteration -- each of those is a bug that was found once, and maintaining
 * two copies is how it gets fixed in one of them.
 *
 * ## This module is INTERNAL. It is not public API, at 1.0 or after.
 *
 * It is exported from no subpath and is not reachable by any import path a user
 * has. Each adapter's `withOutputGuard` and `OutputGuardOptions` are the public
 * contracts, and they are separate per subpath.
 */
import type { Verdict } from '../types.js';
import type { StreamGuardOptions } from '../stream.js';
import type { AdapterGuardOptions } from './adapter-options.js';
import { checkOutput, DegenerateOutputError } from '../check.js';
import { createStreamGuard } from '../stream.js';
import { checkPreamble } from './tool-calls.js';
import { checkArguments, mergeVerdicts } from './tool-arguments.js';

/**
 * An SDK stream, reduced to what this needs.
 *
 * `controller` is the load-bearing part. Both SDKs register an `abort` listener
 * that calls `reader.cancel()` on the response body, so aborting it closes the
 * HTTP connection rather than merely ending our iteration -- which is the
 * difference between not being billed and being billed while looking away.
 */
export interface StreamLike extends AsyncIterable<unknown> {
  controller?: { abort(reason?: unknown): void };
}

/**
 * How to read one provider's shapes.
 *
 * Adding a provider means writing one of these and a list of paths. It should
 * not mean touching anything else in this file.
 */
export interface Surface {
  /** Assistant text in a finished response. */
  text(value: object): string;
  /** True when the model answered with a tool call rather than (only) prose. */
  hasToolCalls(value: object): boolean;
  /** The provider's stop reason, normalised to what `truncationScore` expects. */
  finishReason(value: object): string | undefined;
  /** What one streamed chunk contributes. */
  chunk(value: object): { delta: string; toolCall: boolean; finishReason?: string };
  /**
   * The arguments of every tool call in a finished response, one entry per
   * call, in whatever shape the provider sends: OpenAI a JSON string, Anthropic
   * an already-parsed object.
   *
   * Optional, so a surface that cannot reach them opts out by omission rather
   * than by returning a misleading empty array.
   */
  toolArguments?(value: object): unknown[];
  /**
   * The prompt that produced a response, read from the request the caller
   * passed to `create`.
   *
   * Optional for the same reason as `toolArguments`: a surface that cannot
   * reach it opts out by omission rather than by returning an empty string,
   * which the detector would read as "no prompt" and abstain on anyway, but
   * silently.
   */
  promptFrom?(request: unknown): string | undefined;
}

export interface GuardedPath {
  /** Property names from the client down to the method to wrap. */
  path: readonly string[];
  surface: Surface;
}

export interface ProxyGuardOptions extends StreamGuardOptions, AdapterGuardOptions {}

function isStream(value: unknown): value is StreamLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StreamLike)[Symbol.asyncIterator] === 'function'
  );
}

/**
 * Wraps the methods named by `paths` so every response through them is checked.
 * Everything else on the client resolves to the real thing.
 */
export function guardClient<T extends object>(
  client: T,
  paths: readonly GuardedPath[],
  options: ProxyGuardOptions = {},
): T {
  const {
    onDegenerate = 'throw',
    onVerdict,
    checkToolArguments = false,
    checkPromptEcho = false,
    ...guardOptions
  } = options;

  /**
   * The guard options for one call, with the prompt folded in when asked for.
   *
   * Per call rather than per client, because that is what a prompt is. An
   * explicit `prompt` in the options the caller passed to `withOutputGuard`
   * wins, so a caller who has a fixed system prompt and prefers to state it
   * once is not overridden by what the adapter found.
   */
  const optionsFor = (surface: Surface, request: unknown): typeof guardOptions => {
    if (!checkPromptEcho || !surface.promptFrom || guardOptions.prompt) return guardOptions;
    const prompt = surface.promptFrom(request);
    return prompt ? { ...guardOptions, prompt } : guardOptions;
  };

  const act = (verdict: Verdict, streaming: boolean): void => {
    onVerdict?.(verdict, { streaming });
    if (verdict.ok || onDegenerate === 'ignore') return;
    if (onDegenerate === 'throw') throw new DegenerateOutputError(verdict);
  };

  /** Non-streaming: check the finished text, including its stop reason. */
  const guardCompletion = (surface: Surface, completion: object, request: unknown): object => {
    const callOptions = optionsFor(surface, request);
    /*
     * A tool call is an answer, just not a textual one. Judging its (absent)
     * text as a response would fail every tool-calling turn on `EMPTY` -- see
     * `tool-calls.ts` for why that is the detector being asked the wrong
     * question rather than the detector being wrong.
     */
    if (surface.hasToolCalls(completion)) {
      const preamble = checkPreamble(surface.text(completion), callOptions);
      /*
       * Off by default, and read through the surface rather than here, because
       * where the arguments live is the one part of this that is provider
       * shaped. A surface with no `toolArguments` simply keeps the old
       * behaviour.
       */
      const args =
        checkToolArguments && surface.toolArguments
          ? checkArguments(surface.toolArguments(completion), callOptions)
          : null;
      const verdict = mergeVerdicts(preamble, args);
      if (verdict) act(verdict, false);
      return completion;
    }

    act(
      checkOutput(surface.text(completion), {
        ...callOptions,
        finishReason: surface.finishReason(completion) ?? callOptions.finishReason,
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
  const guardStream = (surface: Surface, stream: StreamLike, request: unknown): StreamLike => {
    /*
     * The prompt reaches `end()` and not the mid-stream checks. `stream.ts`
     * clears `prompt` for every check before the last, because the score is a
     * share of the whole output and a trailing window measures the share of
     * that window.
     */
    const callOptions = optionsFor(surface, request);
    const guard = createStreamGuard(callOptions);

    async function* guarded(): AsyncGenerator<unknown, void, undefined> {
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
        const verdict = checkPreamble(guard.text, callOptions);
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
       * Both SDKs return an `APIPromise`, not a plain promise: it carries
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
                    ? guardStream(surface, value, args[0])
                    : guardCompletion(surface, value as object, args[0]),
                )
                .then(onOk as never, onErr as never);
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

  /**
   * Proxies only the given paths, carrying each one's surface down to the
   * `create` at its end.
   *
   * A path the client does not have resolves to `undefined` rather than
   * throwing -- which is what keeps this working against an SDK major that
   * predates one of the APIs, or a compatible gateway that implements only some
   * of them.
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

  return proxyPaths(client, paths) as T;
}
