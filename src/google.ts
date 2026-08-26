/**
 * Adapter for the `@google/genai` Gemini API.
 *
 * Structurally typed against the SDK rather than importing from it, so this
 * subpath adds no dependency, runtime or otherwise -- `@google/genai` stays an
 * optional peer and the main entry point keeps having none. The shapes below
 * are the parts of the `generateContent` contract this touches and nothing
 * more.
 *
 * The guarding itself lives in `internal/proxy-guard.ts`, shared with
 * `./openai` and `./anthropic`. Gemini differs from those two in three ways
 * that mattered enough to write down:
 *
 * - **Streaming is a separate method**, not a flag on the same one. `./openai`
 *   and `./anthropic` decide per call by looking at what `create` resolved to;
 *   here the method name already says, so the two are separate guarded paths.
 * - **The stream carries no `controller`.** `generateContentStream` resolves to
 *   a bare `AsyncGenerator`, so there is nothing on it to abort. Cancelling the
 *   request instead means putting a signal *into* it -- see {@link abortable}.
 * - **A response has candidates, not content.** Only the first is read, which
 *   is a decision rather than a shortcut -- see {@link firstCandidate}.
 */
import type { StreamGuardOptions } from './stream.js';
import type { AdapterGuardOptions, DegenerateAction } from './internal/adapter-options.js';
import type { GuardedPath, Surface } from './internal/proxy-guard.js';
import { guardClient } from './internal/proxy-guard.js';
import { promptFromMessages, withSystem } from './internal/prompt-text.js';

export type { DegenerateAction };

/**
 * One part of a candidate's content.
 *
 * A part is a union in the wire format but an object with optional keys in the
 * type, so which key is present is what says what it is.
 */
interface PartLike {
  /** Present on text parts, and on thought summaries -- see {@link isAnswerText}. */
  text?: string;
  /**
   * Marks a text part as the model's reasoning rather than its answer. Gemini
   * carries thinking in the same `text` field rather than a separate block
   * type, so this flag is the only thing separating the two.
   */
  thought?: boolean;
  /**
   * Present when the model called a declared function. `args` is already an
   * object rather than the JSON string OpenAI sends, as on Anthropic.
   */
  functionCall?: { name?: string; args?: unknown } | null;
  /** Present when the model wrote code for the built-in code interpreter. */
  executableCode?: unknown;
}

interface CandidateLike {
  content?: { role?: string; parts?: PartLike[] | null } | null;
  finishReason?: string | null;
}

/** A finished `generateContent` result, and equally one chunk of a stream. */
interface ResponseLike {
  candidates?: CandidateLike[] | null;
}

export interface OutputGuardOptions extends StreamGuardOptions, AdapterGuardOptions {}

/**
 * The one candidate this adapter judges.
 *
 * `candidateCount` above 1 asks for *alternative* answers to the same question,
 * and only one of them is going to be used. Concatenating them would measure a
 * document nobody receives, and measure it wrongly in a specific direction:
 * two good answers to one question share their subject, their vocabulary and
 * often their structure, so the more consistent the model is across candidates
 * the higher the repetition score would climb. Reading the first matches both
 * the SDK's own `response.text` and what a caller does with the result.
 */
const firstCandidate = (value: object): CandidateLike | undefined =>
  (value as ResponseLike).candidates?.[0];

const partsOf = (value: object): PartLike[] => firstCandidate(value)?.content?.parts ?? [];

/**
 * Whether a part is the answer, in text.
 *
 * `thought` parts are excluded for the reason `./anthropic` excludes thinking
 * blocks: they are the model working the problem rather than answering it, they
 * are routinely longer than the answer, and reasoning repeats itself as a
 * matter of course. Folding them into the measured text would raise every
 * repetition score on every thinking-enabled response, and raise it most on the
 * ones that thought hardest.
 */
const isAnswerText = (part: PartLike): boolean =>
  typeof part.text === 'string' && part.thought !== true;

/**
 * Whether a part is the model calling a tool.
 *
 * An allow-list of two rather than a deny-list of everything else, for the
 * reason `./anthropic` gives: a deny-list is broken by the first part type
 * Google adds, and broken in the direction that fails healthy responses.
 * `executableCode` sits beside `functionCall` because code written for the
 * built-in interpreter is model-generated tool input in exactly the same way,
 * and loops in exactly the same way.
 *
 * `codeExecutionResult`, `inlineData` and `fileData` are deliberately absent.
 * The first is the tool answering rather than the model calling it; the other
 * two are generated media, which is not a tool call and is not text either.
 */
const isToolPart = (part: PartLike): boolean =>
  part.functionCall != null || part.executableCode != null;

/**
 * Gemini's `contents`, normalised into what {@link promptFromMessages} reads.
 *
 * The field is four shapes in one: a bare string, one `Content`, a list of
 * `Content`, or loose `Part`s with no role at all. The last case is the one
 * worth being careful about -- a part with no role is the user's words, and
 * `promptFromMessages` already treats a missing role as input, so it only has
 * to arrive with its text under `content`.
 *
 * Gemini spells the assistant role `model`, which is not in that function's
 * input-role set, so prior turns are dropped exactly as `assistant` is
 * elsewhere.
 */
function contentsToMessages(contents: unknown): unknown {
  if (typeof contents === 'string') return [{ content: contents }];
  const list = Array.isArray(contents) ? contents : [contents];
  return list.map((entry) => {
    if (typeof entry === 'string') return { content: entry };
    if (!entry || typeof entry !== 'object') return { content: '' };
    const item = entry as { role?: unknown; parts?: unknown };
    // A `Content` carries `parts`; anything else is a lone `Part`.
    return item.parts !== undefined
      ? { role: item.role, content: item.parts }
      : { content: [entry] };
  });
}

/** `systemInstruction` is a string, a `Part`, a list of them, or a `Content`. */
function systemText(instruction: unknown): unknown {
  if (instruction && typeof instruction === 'object' && !Array.isArray(instruction)) {
    const parts = (instruction as { parts?: unknown }).parts;
    if (parts !== undefined) return parts;
  }
  return instruction;
}

/**
 * How to read a `generateContent` response.
 *
 * `finishReason` is passed through as Gemini spells it, uppercase. That is not
 * an oversight: `truncationScore` lowercases before matching, and `MAX_TOKENS`
 * lands on the `max_tokens` it already knows. Mapping it here would spend a
 * line saying nothing.
 *
 * Nothing else is mapped either. `SAFETY`, `RECITATION`, `BLOCKLIST`,
 * `PROHIBITED_CONTENT` and `SPII` all stop generation, and all of them are a
 * content decision about what the model may say rather than the model losing
 * the thread -- the same judgement `./anthropic` makes about `refusal`. They
 * pass through and land below every threshold, which is the conservative
 * direction: a policy stop being read as truncation would discard the response
 * and spend a retry earning the identical stop again.
 */
const CONTENT: Surface = {
  text: (value) =>
    partsOf(value)
      .filter(isAnswerText)
      .map((part) => part.text ?? '')
      .join(''),

  hasToolCalls: (value) => partsOf(value).some(isToolPart),

  finishReason: (value) => firstCandidate(value)?.finishReason ?? undefined,

  toolArguments: (value) =>
    partsOf(value)
      .filter(isToolPart)
      .map((part) => part.functionCall?.args ?? part.executableCode),

  /*
   * `systemInstruction` sits under `config`, away from `contents`, the way
   * Anthropic's `system` sits beside `messages`.
   */
  promptFrom: (request) => {
    const req = request as { contents?: unknown; config?: { systemInstruction?: unknown } };
    const system = systemText(req?.config?.systemInstruction);
    return withSystem(system, promptFromMessages(contentsToMessages(req?.contents))) || undefined;
  },

  /*
   * A chunk is a `GenerateContentResponse` of the same shape as the finished
   * one, carrying only what arrived since the last, so every reader above
   * works on it unchanged.
   */
  chunk: (value) => ({
    delta: CONTENT.text(value),
    toolCall: CONTENT.hasToolCalls(value),
    finishReason: CONTENT.finishReason(value),
  }),
};

/**
 * Cancelling a Gemini stream, which is the whole reason this adapter is more
 * than a `Surface`.
 *
 * The OpenAI and Anthropic SDKs hand back a `Stream` object carrying the
 * `AbortController` that owns the connection, so the guard reaches the
 * transport by calling `.abort()` on what it was given.
 * `generateContentStream` resolves to a bare `AsyncGenerator`. There is
 * nothing on it to abort, and ending our own iteration would leave the model
 * generating -- and billing -- while we looked away, which is the exact failure
 * this package was written about.
 *
 * So the handle is put into the request on the way out: `config.abortSignal` is
 * the SDK's documented cancellation input, and it reaches `fetch`. The request
 * is cloned rather than mutated, because the object belongs to the caller and
 * may well be reused for a retry.
 *
 * A signal the caller already supplied is composed rather than replaced, by
 * having ours follow theirs. `AbortSignal.any` would say this in one line and
 * does not exist on Node 18, which this package still supports.
 */
const abortable = (args: readonly unknown[]) => {
  const params = args[0];
  if (!params || typeof params !== 'object') return undefined;

  const config = (params as { config?: Record<string, unknown> }).config ?? {};
  const existing = config.abortSignal as AbortSignal | undefined;
  const controller = new AbortController();

  if (existing) {
    if (existing.aborted) controller.abort(existing.reason);
    else
      existing.addEventListener('abort', () => controller.abort(existing.reason), { once: true });
  }

  return {
    args: [{ ...params, config: { ...config, abortSignal: controller.signal } }, ...args.slice(1)],
    abort: () => controller.abort(),
  };
};

const STREAM: Surface = { ...CONTENT, abortable };

/**
 * Every method this adapter intercepts. Nothing else on the client is touched.
 *
 * **`chats` is deliberately absent.** `chats.create()` returns a `Chat` object
 * that holds its own history and answers `sendMessage`, so guarding it means
 * wrapping a value returned from a method rather than a response -- a different
 * shape from everything here, and one where the same guard would also have to
 * decide what a degenerate turn does to the history it has already appended.
 * Left plainly unguarded and documented rather than half-done, on the same
 * reasoning that leaves `messages.stream()` alone in `./anthropic`: a guard you
 * believe in and do not have is worse than none. Call `checkOutput` on the
 * result, or use `models.generateContent`, which is guarded.
 *
 * `models.generateImages`, `models.embedContent` and the rest of the `models`
 * tree are untouched too, and less interestingly -- none of them return text.
 */
const GUARDED: readonly GuardedPath[] = [
  { path: ['models', 'generateContent'], surface: CONTENT },
  { path: ['models', 'generateContentStream'], surface: STREAM },
];

/**
 * Wraps a `GoogleGenAI` client so every generated response is checked.
 *
 * ```ts
 * import { GoogleGenAI } from '@google/genai';
 * import { withOutputGuard } from 'llm-output-guard/google';
 * import { presets } from 'llm-output-guard';
 *
 * const ai = withOutputGuard(new GoogleGenAI({ apiKey }), {
 *   ...presets.chat,
 *   onDegenerate: 'abort',
 * });
 * ```
 *
 * Both `generateContent` and `generateContentStream` are guarded by that one
 * call. On the first the tokens are already bought by the time anything can
 * run, so all the guard can do is stop a bad answer being used as a good one.
 * On the second it cancels the request mid-generation, which is where it pays
 * -- see {@link abortable} for how, since a Gemini stream carries no controller
 * to abort.
 *
 * A turn where the model calls a function is not judged as prose: its text, if
 * it has any, is treated as a preamble rather than the answer. Thought
 * summaries are not read as text at all -- see {@link isAnswerText}.
 *
 * Everything else on the client is passed through untouched. Only the resolved
 * value is inspected. See {@link GUARDED} for what is deliberately left
 * unguarded, and why.
 */
export function withOutputGuard<T extends object>(client: T, options: OutputGuardOptions = {}): T {
  return guardClient(client, GUARDED, options);
}
