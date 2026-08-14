import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { withOutputGuard } from '../src/anthropic.js';
import { DegenerateOutputError } from '../src/check.js';
import { presets } from '../src/presets.js';
import type { Verdict } from '../src/types.js';

/**
 * The Messages API, guarded through a real `Anthropic` client.
 *
 * Driving the real SDK rather than a stub is the point, and here it catches
 * something a stub would not: Anthropic's SSE parser dispatches on the `event:`
 * line rather than on a `type` inside `data:`, so a mock that emitted only
 * `data:` would yield nothing and every stream test would pass by having
 * checked an empty stream.
 */

const HEALTHY =
  'Redis pub/sub is the right primitive here. Each server subscribes to the room ' +
  'channel and publishes moves to it, so fan-out no longer depends on which instance ' +
  'a given socket happens to land on. The tradeoff is at-most-once delivery, so a ' +
  'client reconnecting mid-game refetches state rather than replaying it.';

const LOOPING =
  'Your strongest area is TypeScript. ' + 'You should add tests to this repo. '.repeat(60);

const ZH_LOOPING = '我需要更多的信息才能回答这个问题'.repeat(40);

const textBlock = (text: string) => ({ type: 'text', text });
const toolUseBlock = {
  type: 'tool_use',
  id: 'toolu_1',
  name: 'get_weather',
  input: { city: 'Jakarta' },
};

const messageBody = (content: unknown[], stopReason: string | null = 'end_turn') => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'mock',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

/**
 * A mock transport for `/v1/messages`, counting what crossed the wire.
 *
 * As with the OpenAI mock, `cancelled` is the claim worth making: the SDK
 * registers an abort listener that calls `reader.cancel()` on the response body,
 * so it going true is the connection closing rather than merely our iteration
 * stopping.
 */
function mockTransport(content: unknown[], { stopReason = 'end_turn' as string | null, chunkSize = 16 } = {}) {
  const text = (content.find((b) => (b as { type: string }).type === 'text') as
    | { text: string }
    | undefined)?.text ?? '';

  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: messageBody([], null) }],
  ];

  content.forEach((block, index) => {
    events.push([
      'content_block_start',
      {
        type: 'content_block_start',
        index,
        content_block:
          (block as { type: string }).type === 'text' ? { type: 'text', text: '' } : block,
      },
    ]);
    if ((block as { type: string }).type === 'text') {
      for (let i = 0; i < text.length; i += chunkSize) {
        events.push([
          'content_block_delta',
          {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: text.slice(i, i + chunkSize) },
          },
        ]);
      }
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });

  events.push([
    'message_delta',
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: {} },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);

  const state = { sent: 0, total: events.length, cancelled: false };

  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = String((init as { body?: string } | undefined)?.body ?? '{}');

    if (JSON.parse(body).stream !== true) {
      state.sent = state.total;
      return new Response(JSON.stringify(messageBody(content, stopReason)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= events.length) return controller.close();
        const [event, data] = events[index];
        state.sent += 1;
        // The `event:` line is load-bearing -- the SDK dispatches on it.
        controller.enqueue(
          new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
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

  return { state, fetchImpl };
}

const clientWith = (fetchImpl: typeof fetch) =>
  new Anthropic({ apiKey: 'test', fetch: fetchImpl as unknown as typeof fetch, maxRetries: 0 });

const params = {
  model: 'mock',
  max_tokens: 1024,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('withOutputGuard on a real Anthropic client', () => {
  describe('messages.create({ stream: false })', () => {
    it('passes healthy output through untouched', async () => {
      const { fetchImpl } = mockTransport([textBlock(HEALTHY)]);
      const client = withOutputGuard(clientWith(fetchImpl as never), presets.chat);

      const message = await client.messages.create(params);
      expect((message.content[0] as { text: string }).text).toBe(HEALTHY);
    });

    it('throws a retryable DegenerateOutputError on a loop', async () => {
      const { fetchImpl } = mockTransport([textBlock(LOOPING)]);
      const client = withOutputGuard(clientWith(fetchImpl as never), presets.chat);

      const error = await client.messages.create(params).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(DegenerateOutputError);
      expect((error as DegenerateOutputError).retryable).toBe(true);
      expect((error as DegenerateOutputError).verdict.reasons.map((r) => r.code)).toContain(
        'REPETITION',
      );
    });

    it("maps stop_reason 'max_tokens' so TRUNCATED can fire", async () => {
      const seen: Verdict[] = [];
      const { fetchImpl } = mockTransport([textBlock(HEALTHY)], { stopReason: 'max_tokens' });
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        maxTruncation: 0.75,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      });

      await client.messages.create(params);
      expect(seen[0].reasons.map((r) => r.code)).toContain('TRUNCATED');
    });

    /*
     * Anthropic's other length stop, under a name `truncationScore` has never
     * heard of. Normalising it in the adapter rather than widening the
     * detector's own set keeps a shared vocabulary from filling up with one
     * provider's spellings.
     */
    it("maps 'model_context_window_exceeded' onto the same truncation", async () => {
      const seen: Verdict[] = [];
      const { fetchImpl } = mockTransport([textBlock(HEALTHY)], {
        stopReason: 'model_context_window_exceeded',
      });
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        maxTruncation: 0.75,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      });

      await client.messages.create(params);
      const truncated = seen[0].reasons.find((r) => r.code === 'TRUNCATED');
      expect(truncated?.score).toBe(1);
    });

    /*
     * A refusal is a complete response that says no. Reading it as truncation
     * would send a retry layer after a problem that is not there -- the model
     * did not run out of room, it declined.
     */
    it('does not read a refusal as truncation', async () => {
      const seen: Verdict[] = [];
      const { fetchImpl } = mockTransport([textBlock(HEALTHY)], { stopReason: 'refusal' });
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        maxTruncation: 0.75,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      });

      await client.messages.create(params);
      expect(seen[0].reasons.map((r) => r.code)).not.toContain('TRUNCATED');
    });

    it('does not fail a message whose content is a tool call', async () => {
      const seen: Verdict[] = [];
      const { fetchImpl } = mockTransport([toolUseBlock], { stopReason: 'tool_use' });
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onVerdict: (v) => seen.push(v),
      });

      await expect(client.messages.create(params)).resolves.toBeDefined();
      expect(seen).toHaveLength(0);
    });

    it('still measures a preamble sitting beside a tool call', async () => {
      const seen: Verdict[] = [];
      const { fetchImpl } = mockTransport([textBlock(LOOPING), toolUseBlock], {
        stopReason: 'tool_use',
      });
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      });

      await client.messages.create(params);
      expect(seen[0].reasons.map((r) => r.code)).toContain('REPETITION');
    });

    /*
     * Extended thinking is the model's reasoning, not its answer. It is often
     * longer than the answer and repeats itself while working a problem, so
     * folding it into the measured text would raise every repetition score on
     * every thinking response and flag the ones that thought hardest.
     */
    it('does not read a thinking block as the answer', async () => {
      const { fetchImpl } = mockTransport([
        { type: 'thinking', thinking: LOOPING, signature: 'sig' },
        textBlock(HEALTHY),
      ]);
      const client = withOutputGuard(clientWith(fetchImpl as never), presets.chat);

      // The looping text is in `thinking`; the answer beside it is healthy.
      await expect(client.messages.create(params)).resolves.toBeDefined();
    });

    it('does not mistake a thinking block for a tool call', async () => {
      const { fetchImpl } = mockTransport([
        { type: 'thinking', thinking: 'Let me work through this.', signature: 'sig' },
        textBlock(LOOPING),
      ]);
      const client = withOutputGuard(clientWith(fetchImpl as never), presets.chat);

      // Preamble mode would suppress nothing here, but it would suppress
      // TOO_SHORT and TRUNCATED -- so the loop must still throw.
      await expect(client.messages.create(params)).rejects.toBeInstanceOf(DegenerateOutputError);
    });
  });

  describe('messages.create({ stream: true })', () => {
    it('forwards a healthy stream and reports the final verdict once', async () => {
      const onVerdict = vi.fn();
      const { state, fetchImpl } = mockTransport([textBlock(HEALTHY)]);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onVerdict,
      });

      const stream = await client.messages.create({ ...params, stream: true });
      let text = '';
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          text += event.delta.text;
        }
      }

      expect(text).toBe(HEALTHY);
      expect(state.cancelled).toBe(false);
      expect(onVerdict).toHaveBeenCalledOnce();
      expect(onVerdict.mock.calls[0][0].ok).toBe(true);
      expect(onVerdict.mock.calls[0][1]).toEqual({ streaming: true });
    });

    /*
     * The claim that matters, same as the OpenAI adapter: not "the guard fired"
     * but that the connection closed, which is the precondition for a real
     * provider stopping.
     */
    it('cancels the HTTP response body, not just the iteration', async () => {
      const { state, fetchImpl } = mockTransport([textBlock(LOOPING)]);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onDegenerate: 'abort',
      });

      const stream = await client.messages.create({ ...params, stream: true });
      for await (const _ of stream) { /* drain until the guard stops it */ }

      expect(state.cancelled, 'response body was never cancelled').toBe(true);
      expect(state.sent).toBeLessThan(state.total);

      const settled = state.sent;
      await new Promise((r) => setTimeout(r, 20));
      expect(state.sent, 'provider kept generating after the abort').toBe(settled);
    });

    it("errors the stream on 'throw' and still closes the connection", async () => {
      const { state, fetchImpl } = mockTransport([textBlock(LOOPING)]);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onDegenerate: 'throw',
      });

      const stream = await client.messages.create({ ...params, stream: true });
      const drain = async () => {
        for await (const _ of stream) { /* until it throws */ }
      };

      await expect(drain()).rejects.toBeInstanceOf(DegenerateOutputError);
      expect(state.cancelled).toBe(true);
    });

    it("delivers everything on 'ignore' while still reporting", async () => {
      const onVerdict = vi.fn();
      const { state, fetchImpl } = mockTransport([textBlock(LOOPING)]);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onDegenerate: 'ignore',
        onVerdict,
      });

      const stream = await client.messages.create({ ...params, stream: true });
      for await (const _ of stream) { /* drain */ }

      expect(state.cancelled).toBe(false);
      expect(onVerdict.mock.calls.some(([v]) => !v.ok)).toBe(true);
    });

    it('reports no verdict for a streamed tool call', async () => {
      const onVerdict = vi.fn();
      const { fetchImpl } = mockTransport([toolUseBlock], { stopReason: 'tool_use' });
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onVerdict,
      });

      const stream = await client.messages.create({ ...params, stream: true });
      for await (const _ of stream) { /* drain */ }

      expect(onVerdict).not.toHaveBeenCalled();
    });

    it('reads the stop reason off message_delta', async () => {
      const onVerdict = vi.fn();
      const { fetchImpl } = mockTransport([textBlock(HEALTHY)], { stopReason: 'max_tokens' });
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        maxTruncation: 0.75,
        onDegenerate: 'ignore',
        onVerdict,
      });

      const stream = await client.messages.create({ ...params, stream: true });
      for await (const _ of stream) { /* drain */ }

      const final = onVerdict.mock.calls[0][0] as Verdict;
      expect(final.reasons.map((r) => r.code)).toContain('TRUNCATED');
    });
  });

  describe('the verdict is not degraded relative to the other adapters', () => {
    it('surfaces Verdict.modes and Reason.mode on a non-Latin loop', async () => {
      const { fetchImpl } = mockTransport([textBlock(ZH_LOOPING)]);
      const client = withOutputGuard(clientWith(fetchImpl as never), presets.chat);

      const error = (await client.messages.create(params).then(
        () => null,
        (e: unknown) => e,
      )) as DegenerateOutputError;

      expect(error).toBeInstanceOf(DegenerateOutputError);
      expect(error.verdict.modes?.TAIL_LOOP).toBe('char');
      expect(error.verdict.reasons.find((r) => r.code === 'TAIL_LOOP')?.mode).toBe('char');
    });
  });

  describe('the client is otherwise untouched', () => {
    it('leaves non-message methods alone', async () => {
      const { fetchImpl } = mockTransport([textBlock(HEALTHY)]);
      const raw = clientWith(fetchImpl as never);
      const client = withOutputGuard(raw, presets.chat);

      expect(client.baseURL).toBe(raw.baseURL);
      expect(typeof client.messages.create).toBe('function');
      expect(typeof client.messages.stream).toBe('function');
      expect(typeof client.messages.countTokens).toBe('function');
    });
  });
});
