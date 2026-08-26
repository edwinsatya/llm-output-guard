import { describe, it, expect, vi, afterEach } from 'vitest';
import { GoogleGenAI } from '@google/genai';
import { withOutputGuard } from '../src/google.js';
import { DegenerateOutputError } from '../src/check.js';
import { presets } from '../src/presets.js';
import type { Verdict } from '../src/types.js';

/**
 * The Gemini API, guarded through a real `GoogleGenAI` client.
 *
 * Driving the real SDK rather than a stub is the point, and here it earns its
 * keep twice: `generateContentStream` resolves to a bare `AsyncGenerator` with
 * no `controller`, which is the whole reason this adapter puts an
 * `abortSignal` into the request -- and only the real SDK actually forwards
 * that signal to `fetch`. A stub would have let a cancellation that reaches
 * nothing pass for one that closes the connection.
 *
 * `@google/genai` takes no `fetch` option, so the transport is stubbed
 * globally and restored after each test.
 */

const HEALTHY =
  'Redis pub/sub is the right primitive here. Each server subscribes to the room ' +
  'channel and publishes moves to it, so fan-out no longer depends on which instance ' +
  'a given socket happens to land on. The tradeoff is at-most-once delivery, so a ' +
  'client reconnecting mid-game refetches state rather than replaying it.';

const LOOPING =
  'Your strongest area is TypeScript. ' + 'You should add tests to this repo. '.repeat(60);

const textPart = (text: string) => ({ text });
const thoughtPart = (text: string) => ({ text, thought: true });
const functionCallPart = { functionCall: { name: 'get_weather', args: { city: 'Jakarta' } } };

const responseBody = (parts: unknown[], finishReason: string | null = 'STOP') => ({
  candidates: [{ content: { role: 'model', parts }, finishReason }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
});

/**
 * A mock transport for the Gemini endpoints, counting what crossed the wire.
 *
 * `cancelled` is the claim worth making, and it is made by the runtime rather
 * than by us: it goes true when `fetch` sees its signal abort and cancels the
 * response body, which is the connection closing rather than merely our
 * iteration stopping.
 */
function mockTransport(parts: unknown[], { finishReason = 'STOP' as string | null, chunkSize = 24 } = {}) {
  const text = (parts as { text?: string; thought?: boolean }[])
    .filter((p) => typeof p.text === 'string' && p.thought !== true)
    .map((p) => p.text)
    .join('');

  const chunks: unknown[] = [];
  const nonText = parts.filter((p) => typeof (p as { text?: unknown }).text !== 'string');
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(responseBody([textPart(text.slice(i, i + chunkSize))], null));
  }
  if (nonText.length > 0) chunks.push(responseBody(nonText, null));
  if (chunks.length === 0) chunks.push(responseBody([], null));
  chunks.push(responseBody([], finishReason));

  const state = { sent: 0, total: chunks.length, cancelled: false, requests: [] as unknown[] };

  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url instanceof Request ? url.url : url);
    state.requests.push(JSON.parse(String((init as { body?: string } | undefined)?.body ?? '{}')));

    if (!href.includes('streamGenerateContent')) {
      state.sent = state.total;
      return new Response(JSON.stringify(responseBody(parts, finishReason)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      /*
       * What a real `fetch` does with `init.signal`, and the only part of it
       * this suite depends on: aborting errors the response body. Without it
       * the cancellation tests would pass against a mock that ignored the
       * signal entirely -- which is precisely the bug they exist to catch.
       */
      start(controller) {
        init?.signal?.addEventListener(
          'abort',
          () => {
            state.cancelled = true;
            try {
              controller.error(new DOMException('The operation was aborted.', 'AbortError'));
            } catch {
              // Already closed; the connection is gone either way.
            }
          },
          { once: true },
        );
      },
      pull(controller) {
        if (index >= chunks.length) return controller.close();
        state.sent += 1;
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(chunks[index])}\r\n\r\n`),
        );
        index += 1;
      },
      cancel() {
        state.cancelled = true;
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = (options: Parameters<typeof withOutputGuard>[1] = presets.chat) =>
  withOutputGuard(new GoogleGenAI({ apiKey: 'test' }), options);

const params = { model: 'gemini-2.5-flash', contents: 'hi' };

describe('withOutputGuard on a real GoogleGenAI client', () => {
  describe('models.generateContent', () => {
    it('passes healthy output through untouched', async () => {
      mockTransport([textPart(HEALTHY)]);
      const response = await client().models.generateContent(params);
      expect(response.text).toBe(HEALTHY);
    });

    it('throws a retryable DegenerateOutputError on a loop', async () => {
      mockTransport([textPart(LOOPING)]);

      const error = await client()
        .models.generateContent(params)
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(DegenerateOutputError);
      expect((error as DegenerateOutputError).retryable).toBe(true);
      expect((error as DegenerateOutputError).verdict.reasons.map((r) => r.code)).toContain(
        'REPETITION',
      );
    });

    it("reads MAX_TOKENS as a length stop so TRUNCATED can fire", async () => {
      const seen: Verdict[] = [];
      mockTransport([textPart(HEALTHY)], { finishReason: 'MAX_TOKENS' });

      await client({
        ...presets.chat,
        maxTruncation: 0.75,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      })
        .models.generateContent(params);

      expect(seen.at(-1)?.reasons.map((r) => r.code)).toContain('TRUNCATED');
    });

    /**
     * A safety stop is a decision about what the model may say, not the model
     * losing the thread. Reading it as truncation would discard the response
     * and spend a retry earning the identical stop again.
     */
    it('does not read a SAFETY stop as truncation', async () => {
      const seen: Verdict[] = [];
      mockTransport([textPart(HEALTHY)], { finishReason: 'SAFETY' });

      await client({
        ...presets.chat,
        maxTruncation: 0.75,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      }).models.generateContent(params);

      expect(seen.at(-1)?.reasons.map((r) => r.code)).not.toContain('TRUNCATED');
    });

    /**
     * Thinking repeats itself as a matter of course. Measured as answer text it
     * would raise the repetition score on every thinking-enabled response.
     */
    it('does not read thought parts as the answer', async () => {
      const seen: Verdict[] = [];
      mockTransport([thoughtPart(LOOPING), textPart(HEALTHY)]);

      const response = await client({
        ...presets.chat,
        onVerdict: (v) => seen.push(v),
      }).models.generateContent(params);

      expect(seen.at(-1)?.ok).toBe(true);
      expect(response.candidates?.[0].content?.parts).toHaveLength(2);
    });

    /** A tool call is an answer, just not a textual one. */
    it('judges a function-call turn by its preamble, not as EMPTY', async () => {
      const seen: Verdict[] = [];
      mockTransport([functionCallPart]);

      await client({ ...presets.chat, onVerdict: (v) => seen.push(v) }).models.generateContent(
        params,
      );

      expect(seen.at(-1)?.reasons.map((r) => r.code) ?? []).not.toContain('EMPTY');
    });

    it('measures tool arguments when asked to', async () => {
      const seen: Verdict[] = [];
      mockTransport([{ functionCall: { name: 'search', args: { query: 'site reliability '.repeat(40) } } }]);

      await client({
        ...presets.chat,
        checkToolArguments: true,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      }).models.generateContent(params);

      expect(seen.at(-1)?.reasons.map((r) => r.code)).toContain('REPETITION');
    });
  });

  /**
   * `.catch()` and `.finally()` are defined in terms of the `then` of whatever
   * they are called on, so a proxy that forwards them to the unguarded promise
   * hands back an unchecked response through the most ordinary error handling
   * there is. Shared machinery, so this pins it for every adapter.
   */
  describe('promise methods other than then', () => {
    it('still checks a response reached through .catch()', async () => {
      mockTransport([textPart(LOOPING)]);

      const result = await client()
        .models.generateContent(params)
        .catch((e: unknown) => e);

      expect(result).toBeInstanceOf(DegenerateOutputError);
    });

    it('still checks a response reached through .finally()', async () => {
      let ran = false;
      mockTransport([textPart(LOOPING)]);

      const error = await client()
        .models.generateContent(params)
        .finally(() => {
          ran = true;
        })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(ran).toBe(true);
      expect(error).toBeInstanceOf(DegenerateOutputError);
    });
  });

  describe('prompt echo', () => {
    it('reads the prompt out of a string `contents`', async () => {
      const prompt = HEALTHY;
      const seen: Verdict[] = [];
      mockTransport([textPart(prompt)]);

      await client({
        ...presets.chat,
        checkPromptEcho: true,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      }).models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });

      expect(seen.at(-1)?.reasons.map((r) => r.code)).toContain('PROMPT_ECHO');
    });

    /** Gemini spells the assistant role `model`; prior turns must not count. */
    it('reads user turns and systemInstruction, and skips model turns', async () => {
      const seen: Verdict[] = [];
      mockTransport([textPart(HEALTHY)]);

      await client({
        ...presets.chat,
        checkPromptEcho: true,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      }).models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          { role: 'user', parts: [{ text: 'what should I use for fan-out?' }] },
          { role: 'model', parts: [{ text: HEALTHY }] },
        ],
        config: { systemInstruction: 'Answer in English.' },
      });

      // The echoed text is a `model` turn, so it is the model's own output and
      // is excluded -- the score stays low rather than firing on a repeat.
      expect(seen.at(-1)?.reasons.map((r) => r.code) ?? []).not.toContain('PROMPT_ECHO');
    });
  });

  describe('models.generateContentStream', () => {
    it('passes a healthy stream through untouched', async () => {
      const state = mockTransport([textPart(HEALTHY)]);
      let text = '';

      for await (const chunk of await client().models.generateContentStream(params)) {
        text += chunk.text ?? '';
      }

      expect(text).toBe(HEALTHY);
      expect(state.cancelled).toBe(false);
    });

    /**
     * The line the package exists for, on a provider whose stream carries no
     * controller: the abort has to reach `fetch` through the request.
     */
    it('cancels the HTTP request mid-loop', async () => {
      const state = mockTransport([textPart(LOOPING)]);
      let chunks = 0;

      for await (const _ of await client({ ...presets.chat, onDegenerate: 'abort' }).models
        .generateContentStream(params)) {
        chunks += 1;
      }

      expect(state.cancelled).toBe(true);
      expect(chunks).toBeLessThan(state.total);
    });

    it('throws mid-stream when told to', async () => {
      mockTransport([textPart(LOOPING)]);

      const error = await (async () => {
        try {
          for await (const _ of await client().models.generateContentStream(params)) {
            // drain
          }
          return null;
        } catch (e) {
          return e;
        }
      })();

      expect(error).toBeInstanceOf(DegenerateOutputError);
    });

    it('reports through onVerdict and changes nothing when ignoring', async () => {
      const seen: Verdict[] = [];
      const state = mockTransport([textPart(LOOPING)]);

      for await (const _ of await client({
        ...presets.chat,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      }).models.generateContentStream(params)) {
        // drain
      }

      expect(state.cancelled).toBe(false);
      expect(seen.some((v) => !v.ok)).toBe(true);
    });

    /** A caller's own signal must keep working once ours is composed with it. */
    it('leaves a caller-supplied abortSignal working', async () => {
      const state = mockTransport([textPart(HEALTHY)]);
      const controller = new AbortController();

      const iterate = async () => {
        for await (const _ of await client().models.generateContentStream({
          ...params,
          config: { abortSignal: controller.signal },
        })) {
          controller.abort();
        }
      };

      await iterate().catch(() => null);
      expect(state.cancelled).toBe(true);
    });

    it('does not mutate the request object it was given', async () => {
      mockTransport([textPart(HEALTHY)]);
      const request = { ...params, config: { temperature: 0 } };

      for await (const _ of await client().models.generateContentStream(request)) {
        // drain
      }

      expect(request.config).toEqual({ temperature: 0 });
    });
  });
});
