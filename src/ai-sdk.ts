/**
 * Middleware adapter for the Vercel AI SDK.
 *
 * Structurally typed against the SDK rather than importing from it, so this
 * subpath adds no dependency, runtime or otherwise -- `ai` stays an optional
 * peer. The shapes below are the parts of the provider spec this touches and
 * nothing more, which is also what keeps it working across spec versions:
 * `finishReason` is a plain string in v2 and an object in v4, and both are
 * accepted here.
 */
import type { Verdict } from './types.js';
import type { StreamGuardOptions } from './stream.js';
import { checkOutput, DegenerateOutputError } from './check.js';
import { createStreamGuard } from './stream.js';

/** `'stop' | 'length' | ...` in older specs, `{ unified, raw }` in v4. */
type FinishReasonLike = string | { unified?: string; raw?: string } | null | undefined;

interface StreamPart {
  type: string;
  /** Present on `text` content parts. */
  text?: string;
  /** Present on `text-delta` stream parts. */
  delta?: string;
  /** Present on the `finish` part. */
  finishReason?: FinishReasonLike;
}

interface GenerateResultLike {
  content?: StreamPart[];
  finishReason?: FinishReasonLike;
}

interface StreamResultLike {
  stream: ReadableStream<StreamPart>;
}

/** Normalises both spec shapes to what `truncationScore` expects. */
function finishReasonOf(value: FinishReasonLike): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.unified ?? value.raw;
  return undefined;
}

export type DegenerateAction = 'throw' | 'abort' | 'ignore';

export interface OutputGuardOptions extends StreamGuardOptions {
  /**
   * What to do when output is judged degenerate. Default `'throw'`.
   *
   * - `'throw'` errors the call with a `DegenerateOutputError`, which
   *   `.retryable` marks as safe for your fallback layer to act on. On a
   *   stream this also cancels the upstream request, so the tokens you have
   *   not been billed for yet never get generated.
   * - `'abort'` ends the stream cleanly and keeps whatever arrived first.
   *   Same token saving, no exception to handle -- use it when a partial
   *   answer beats no answer.
   * - `'ignore'` reports through `onVerdict` and changes nothing. This is the
   *   setting to roll out with: watch your own traffic before letting any
   *   threshold fail a request.
   */
  onDegenerate?: DegenerateAction;
  /**
   * Every verdict, passing or failing, once per call. Send the scores to your
   * metrics -- a week of them is what turns the shipped thresholds into
   * thresholds you can defend for your own traffic.
   */
  onVerdict?: (verdict: Verdict, context: { streaming: boolean }) => void;
}

/**
 * Guards a model against returning degenerate output, as AI SDK middleware.
 *
 * ```ts
 * import { wrapLanguageModel } from 'ai';
 * import { outputGuard } from 'llm-output-guard/ai-sdk';
 *
 * const model = wrapLanguageModel({
 *   model: groq('llama-3.3-70b-versatile'),
 *   middleware: outputGuard({ ...presets.chat, onDegenerate: 'abort' }),
 * });
 * ```
 *
 * On `streamText` this is where it pays: the guard watches deltas as they
 * arrive and cancels the generation the moment a loop is detectable, rather
 * than letting the model run to `max_tokens` on your budget.
 */
export function outputGuard(options: OutputGuardOptions = {}) {
  const { onDegenerate = 'throw', onVerdict, ...guardOptions } = options;

  const act = (verdict: Verdict, streaming: boolean): void => {
    onVerdict?.(verdict, { streaming });
    if (verdict.ok || onDegenerate === 'ignore') return;
    if (onDegenerate === 'throw') throw new DegenerateOutputError(verdict);
  };

  return {
    /**
     * Non-streaming. The tokens are already bought by the time this runs, so
     * all it can do is stop a bad answer from being used as a good one.
     */
    async wrapGenerate<T extends GenerateResultLike>({
      doGenerate,
    }: {
      doGenerate: () => PromiseLike<T>;
    }): Promise<T> {
      const result = await doGenerate();
      const text = (result.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('');

      act(
        checkOutput(text, {
          ...guardOptions,
          finishReason: finishReasonOf(result.finishReason) ?? guardOptions.finishReason,
        }),
        false,
      );

      return result;
    },

    async wrapStream<T extends StreamResultLike>({
      doStream,
    }: {
      doStream: () => PromiseLike<T>;
    }): Promise<T> {
      const result = await doStream();
      const guard = createStreamGuard(guardOptions);
      let fired = false;
      let finishReason: FinishReasonLike;

      const guarded = result.stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(part, controller) {
            // Forward first: a chunk already generated has been paid for, and
            // withholding it buys nothing but a truncated answer.
            controller.enqueue(part);

            if (part.type === 'finish') finishReason = part.finishReason;
            if (part.type !== 'text-delta' || fired) return;

            const verdict = guard.push(part.delta ?? '');
            if (!verdict || verdict.ok) return;

            fired = true;
            onVerdict?.(verdict, { streaming: true });
            if (onDegenerate === 'ignore') return;

            /*
             * Both of these cancel the source stream, which is what actually
             * stops the provider generating -- the saving is not in skipping
             * chunks we already received but in the ones never produced.
             */
            if (onDegenerate === 'throw') {
              controller.error(new DegenerateOutputError(verdict));
            } else {
              controller.terminate();
            }
          },

          flush() {
            // A stream we cut short would only be reported as truncated by us,
            // describing our own abort rather than the model.
            if (!fired) {
              onVerdict?.(guard.end(finishReasonOf(finishReason)), { streaming: true });
            }
          },
        }),
      );

      // Everything the provider returned, with only the stream swapped -- the
      // cast is the spread losing `T`, not a change in what is handed back.
      return { ...result, stream: guarded } as T;
    },
  };
}
