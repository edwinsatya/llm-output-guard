/**
 * Guarding an **event-emitter** stream, where a plain async iterator is only
 * one of the ways a caller might read it.
 *
 * ## This module is INTERNAL. It is not public API, at 1.0 or after.
 *
 * ## Why `wrapStream` could not do this
 *
 * `proxy-guard.ts` guards a `Stream` by replacing `Symbol.asyncIterator`. That
 * is complete for a `Stream`, because iteration is the only way to read one.
 *
 * `responses.stream()` returns a `ResponseStream`, which extends `EventStream`,
 * and it can be consumed **six** ways: `for await`, `finalResponse()`,
 * `done()`, `on()`, `once()`/`emitted()`, and `events()`. Replacing the
 * iterator would guard the first and leave the other five reading an unchecked
 * stream -- a guard you believe in and do not have, which is why this was left
 * plainly unguarded and documented rather than half-done.
 *
 * ## What makes it tractable
 *
 * All six paths are fed by one internal event pump, so **one listener sees
 * every delta regardless of how the consumer reads**. That splits the problem
 * cleanly in two:
 *
 * - **Detection and cancellation** work for all six. The listener feeds the
 *   guard; `abort()` closes the connection, so the provider stops generating
 *   whichever way the caller was reading.
 * - **Raising an error** works only where there is an error channel to raise
 *   into. `for await`, `finalResponse()` and `done()` have one. A caller who
 *   only attached `on()` callbacks has nowhere to receive a throw, so for them
 *   the report goes to `onVerdict` and the stream simply stops.
 *
 * Measured against the real `ResponseStream`: `abort()` mid-iteration raises
 * `APIUserAbortError` into a `for await` loop and sets `aborted`. That is the
 * SDK's own error for a cancellation the caller asked for -- so where the guard
 * caused it, it is translated into `DegenerateOutputError`, which carries the
 * verdict and is what a retry layer keys on.
 */
import type { Verdict } from '../types.js';
import type { StreamGuardOptions } from '../stream.js';
import { createStreamGuard } from '../stream.js';
import { checkPreamble } from './tool-calls.js';
import { DegenerateOutputError } from '../check.js';
import type { DegenerateAction } from './adapter-options.js';

/** The parts of an `EventStream` this touches, and nothing more. */
export interface EventStreamLike extends AsyncIterable<unknown> {
  controller?: { abort(reason?: unknown): void };
  abort?(): void;
  on?(event: string, listener: (payload: never) => void): unknown;
  finalResponse?(): Promise<unknown>;
  done?(): Promise<void>;
}

/**
 * How to read one provider's events. The shape of the difference between two
 * event-emitter streams, the way `Surface` is for request/response streams.
 */
export interface EventReader {
  /** The event carrying answer text, and how to read the delta off it. */
  delta: { event: string; read(payload: object): string };
  /** Events that mean the model called a tool. */
  toolCall: { events: readonly string[]; is(payload: object): boolean };
  /** Terminal events, and the stop reason to read from each. */
  terminal: { events: readonly string[]; finishReason(payload: object): string | undefined };
}

export interface EventStreamGuardOptions extends StreamGuardOptions {
  onVerdict?: (verdict: Verdict, context: { streaming: boolean }) => void;
  onDegenerate?: DegenerateAction;
}

/**
 * Attach a guard to an event-emitter stream and return it wrapped.
 *
 * The listener goes on immediately rather than lazily: a caller who only uses
 * `on()` never touches the proxy, so a guard attached on first read would never
 * attach at all for them.
 */
export function guardEventStream<T extends EventStreamLike>(
  stream: T,
  reader: EventReader,
  options: EventStreamGuardOptions,
): T {
  const { onVerdict, onDegenerate = 'throw', ...checkOptions } = options;
  const guard = createStreamGuard(checkOptions);

  /** The verdict that fired, if one did. Read by every wrapped path. */
  let failure: Verdict | null = null;
  let sawToolCall = false;
  let finishReason: string | undefined;
  let ended = false;

  const fire = (verdict: Verdict): void => {
    failure = verdict;
    onVerdict?.(verdict, { streaming: true });
    if (onDegenerate === 'ignore') return;

    /*
     * Reaches the transport, exactly as the redundancy detectors do on a
     * `Stream`: the SDK listens on this controller and cancels the response
     * body, so the provider stops generating. Both spellings are called
     * because `abort()` is the documented method and `controller` is the
     * handle -- a hand-built double may carry either.
     */
    stream.abort?.();
    stream.controller?.abort();
  };

  if (typeof stream.on === 'function') {
    stream.on(reader.delta.event, ((payload: object) => {
      if (failure || ended) return;
      const verdict = guard.push(reader.delta.read(payload));
      if (verdict && !verdict.ok) fire(verdict);
    }) as (payload: never) => void);

    for (const event of reader.toolCall.events) {
      stream.on(event, ((payload: object) => {
        if (reader.toolCall.is(payload)) sawToolCall = true;
      }) as (payload: never) => void);
    }

    for (const event of reader.terminal.events) {
      stream.on(event, ((payload: object) => {
        if (ended || failure) return;
        ended = true;
        finishReason = reader.terminal.finishReason(payload) ?? finishReason;

        /*
         * A tool-calling turn is judged by its preamble, and `null` when there
         * is no preamble to judge -- the same rule the non-streaming path
         * applies. Reporting `EMPTY` here would spike a calibration run with
         * samples describing an agent's tool use.
         */
        const verdict = sawToolCall
          ? checkPreamble(guard.text, checkOptions)
          : guard.end(finishReason);
        if (verdict) onVerdict?.(verdict, { streaming: true });
      }) as (payload: never) => void);
    }
  }

  /**
   * Our abort, surfaced as ours -- or swallowed, depending on the action.
   *
   * Once the guard has aborted, every path the caller might be on rejects with
   * the SDK's `APIUserAbortError`: correct from its point of view, since the
   * abort was requested locally, and useless to a caller who never requested
   * it.
   *
   * - `'throw'` replaces it with the `DegenerateOutputError` carrying the
   *   verdict, which is what a retry layer keys on.
   * - `'abort'` means *end cleanly and keep what arrived*, so on the iterator
   *   the error is swallowed and iteration simply stops. It is **not** hidden
   *   on `finalResponse()` or `done()`: there is no partial value those can
   *   honestly return, so they still reject with the SDK's own error.
   * - An abort nobody here caused is always rethrown untouched.
   */
  const ours = (): boolean => failure !== null;

  async function* guarded(): AsyncGenerator<unknown, void, undefined> {
    try {
      for await (const event of stream) yield event;
    } catch (error) {
      if (!ours()) throw error;
      if (onDegenerate === 'throw') throw new DegenerateOutputError(failure!);
      return;
    }
    /*
     * A stream can also end without throwing -- the consumer stopped early, or
     * the abort landed between events -- so the throw cannot live only in the
     * catch above.
     */
    if (ours() && onDegenerate === 'throw') throw new DegenerateOutputError(failure!);
  }

  const wrapTerminal = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async function (this: unknown, ...args: A): Promise<R> {
      try {
        const result = await fn.apply(stream, args);
        if (ours() && onDegenerate === 'throw') throw new DegenerateOutputError(failure!);
        return result;
      } catch (error) {
        if (error instanceof DegenerateOutputError) throw error;
        if (ours() && onDegenerate === 'throw') throw new DegenerateOutputError(failure!);
        throw error;
      }
    };

  return new Proxy(stream, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) return guarded;

      /*
       * `target` as the receiver, never the proxy. `EventStream` exposes
       * `ended`, `errored` and `aborted` as getters over `#private` fields, and
       * a getter invoked with the proxy as `this` throws "Cannot read private
       * member from an object whose class did not declare it". Reading through
       * the real instance is the only way those survive being wrapped.
       */
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;

      if (prop === 'finalResponse' || prop === 'done') {
        return wrapTerminal(value as (...args: unknown[]) => Promise<unknown>);
      }
      return value.bind(target);
    },
  }) as T;
}
