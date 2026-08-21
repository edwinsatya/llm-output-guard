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
import type { AdapterGuardOptions, DegenerateAction } from './internal/adapter-options.js';
import { checkOutput, DegenerateOutputError } from './check.js';
import { createStreamGuard } from './stream.js';
import { checkPreamble } from './internal/tool-calls.js';
import { checkArguments, mergeVerdicts } from './internal/tool-arguments.js';
import { promptFromMessages } from './internal/prompt-text.js';

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
  /**
   * The arguments of a `tool-call` part. Spelled `input` in the current spec
   * and `args` in older `ai` majors, and sent either as an object or as the
   * raw JSON string depending on version, so both names are read and
   * `argumentsToText` normalises the shapes.
   */
  input?: unknown;
  args?: unknown;
}

/**
 * Whether a part is the model calling a tool.
 *
 * Matched by prefix rather than by an exact list because the spec has several
 * and has added to them across versions: `tool-call` on a finished generation,
 * and `tool-input-start` / `tool-input-delta` / `tool-input-end` while
 * streaming. A prefix keeps a part type added in a later `ai` major from
 * silently reading as prose, which is the direction that reintroduces the false
 * positive this guards against.
 */
const isToolPart = (part: StreamPart): boolean => part.type.startsWith('tool-');

/**
 * The call parameters the middleware is handed. Only `prompt` is read, and it
 * is the spec's normalised message list rather than anything provider shaped.
 */
interface ParamsLike {
  prompt?: unknown;
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

export type { DegenerateAction };

/**
 * Shares {@link AdapterGuardOptions} with `llm-output-guard/openai`, so the two
 * adapters cannot drift apart. Reading one set of docs is meant to be enough.
 */
export interface OutputGuardOptions extends StreamGuardOptions, AdapterGuardOptions {}

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
   * The middleware is handed `params` on both hooks, and `params.prompt` is the
   * spec's normalised message list -- the one shape that is the same across
   * every `ai` major in the peer range. An explicit `prompt` in the options
   * wins, so a caller who prefers to state a fixed system prompt once is not
   * overridden by what the adapter found.
   */
  const optionsFor = (params: ParamsLike | undefined): typeof guardOptions => {
    if (!checkPromptEcho || guardOptions.prompt) return guardOptions;
    const prompt = promptFromMessages(params?.prompt);
    return prompt ? { ...guardOptions, prompt } : guardOptions;
  };

  const act = (verdict: Verdict, streaming: boolean): void => {
    onVerdict?.(verdict, { streaming });
    if (verdict.ok || onDegenerate === 'ignore') return;
    if (onDegenerate === 'throw') throw new DegenerateOutputError(verdict);
  };

  return {
    /**
     * A type-level tag only. It is present because the v3 middleware type
     * (`ai` v6) requires it, while v2 (`ai` v5) has no such field and v4
     * (`ai` v7) relaxed it to any string. `'v3'` is the one literal all three
     * admit, so a single object satisfies every supported major.
     *
     * This is load-bearing on an assumption: that `wrapLanguageModel`'s
     * `doWrap` destructures the hooks and never reads this field. That is true
     * of every version in the peer range, and it is checked -- `npm run
     * check:peer-ai` runs the adapter against each major, so a version that
     * started dispatching on the tag would fail there rather than in
     * production. **If that check is ever removed, remove this tag with it**:
     * without it the claim becomes an assumption again, and the failure it
     * would hide is the adapter being handed the wrong contract.
     */
    specificationVersion: 'v3' as const,

    /**
     * Non-streaming. The tokens are already bought by the time this runs, so
     * all it can do is stop a bad answer from being used as a good one.
     */
    async wrapGenerate<T extends GenerateResultLike>({
      doGenerate,
      params,
    }: {
      doGenerate: () => PromiseLike<T>;
      params?: ParamsLike;
    }): Promise<T> {
      const result = await doGenerate();
      const callOptions = optionsFor(params);
      const content = result.content ?? [];
      const text = content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('');

      /*
       * A tool call is an answer, just not a textual one. Judging its (absent)
       * text as a response would fail every tool-calling turn on `EMPTY` --
       * see `internal/tool-calls.ts` for why that is the detector being asked
       * the wrong question rather than the detector being wrong.
       */
      if (content.some(isToolPart)) {
        const preamble = checkPreamble(text, callOptions);
        /*
         * Only `tool-call` parts, not every `tool-` prefixed one: the
         * `tool-input-start` / `-delta` / `-end` parts are streaming fragments
         * and carry pieces of the same arguments, so counting them here would
         * measure the same value several times over in partial form.
         */
        const args = checkToolArguments
          ? checkArguments(
              content
                .filter((part) => part.type === 'tool-call')
                .map((part) => part.input ?? part.args),
              callOptions,
            )
          : null;
        const verdict = mergeVerdicts(preamble, args);
        if (verdict) act(verdict, false);
        return result;
      }

      act(
        checkOutput(text, {
          ...callOptions,
          finishReason: finishReasonOf(result.finishReason) ?? callOptions.finishReason,
        }),
        false,
      );

      return result;
    },

    async wrapStream<T extends StreamResultLike>({
      doStream,
      params,
    }: {
      doStream: () => PromiseLike<T>;
      params?: ParamsLike;
    }): Promise<T> {
      const result = await doStream();
      /*
       * The prompt reaches `end()` and not the mid-stream checks: `stream.ts`
       * clears it for every check before the last, because the score is a share
       * of the whole output and a window measures the share of that window.
       */
      const guard = createStreamGuard(optionsFor(params));
      let fired = false;
      let sawToolCall = false;
      let finishReason: FinishReasonLike;

      const guarded = result.stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(part, controller) {
            // Forward first: a chunk already generated has been paid for, and
            // withholding it buys nothing but a truncated answer.
            controller.enqueue(part);

            if (part.type === 'finish') finishReason = part.finishReason;
            if (isToolPart(part)) sawToolCall = true;
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
            if (fired) return;

            /*
             * Same rule as `wrapGenerate`, and it matters here even though
             * nothing throws on this path: a tool-call stream carries no text
             * deltas, so `end()` would report `EMPTY: 1` to `onVerdict` on
             * every one. Those samples are what a `calibrate` run is built
             * from, and a spike of them describes the agent's tool use rather
             * than any degeneration.
             */
            if (sawToolCall) {
              const verdict = checkPreamble(guard.text, guardOptions);
              if (verdict) onVerdict?.(verdict, { streaming: true });
              return;
            }

            onVerdict?.(guard.end(finishReasonOf(finishReason)), { streaming: true });
          },
        }),
      );

      // Everything the provider returned, with only the stream swapped -- the
      // cast is the spread losing `T`, not a change in what is handed back.
      return { ...result, stream: guarded } as T;
    },
  };
}
