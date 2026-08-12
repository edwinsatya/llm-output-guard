import { describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import { withOutputGuard } from '../src/openai.js';
import { DegenerateOutputError } from '../src/check.js';
import { presets } from '../src/presets.js';
import type { Verdict } from '../src/types.js';

const HEALTHY =
  'Redis pub/sub is the right primitive here. Each server subscribes to the room ' +
  'channel and publishes moves to it, so fan-out no longer depends on which instance ' +
  'a given socket happens to land on. The tradeoff is at-most-once delivery, so a ' +
  'client reconnecting mid-game refetches state rather than replaying it.';

const LOOPING =
  'Your strongest area is TypeScript. ' + 'You should add tests to this repo. '.repeat(60);

const ZH_LOOPING = '我需要更多的信息才能回答这个问题'.repeat(40);

/**
 * A mock transport that reports what actually crossed the wire.
 *
 * This is the point of driving a real `OpenAI` client rather than a hand-rolled
 * stub. "The abort callback ran" proves nothing about billing: an iterator can
 * stop reading while the connection keeps streaming tokens, and a test asserting
 * only that the guard fired would pass while the money claim was false.
 *
 * So the response body is a `ReadableStream` whose `pull` counts the chunks the
 * server was actually asked to produce and whose `cancel` records that the
 * client closed the connection. The SDK registers an abort listener that calls
 * `reader.cancel()`, so `cancelled` going true is the connection closing.
 */
function mockTransport(text: string, finishReason: 'stop' | 'length' = 'stop', chunkSize = 16) {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) pieces.push(text.slice(i, i + chunkSize));

  const state = { sent: 0, total: pieces.length + 1, cancelled: false, cancelReason: undefined as unknown };

  const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  const chunkAt = (index: number) =>
    sse({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'mock',
      choices: [
        {
          index: 0,
          delta: index < pieces.length ? { content: pieces[index] } : {},
          finish_reason: index < pieces.length ? null : finishReason,
        },
      ],
    });

  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = String((init as { body?: string } | undefined)?.body ?? '{}');
    const streaming = JSON.parse(body).stream === true;

    if (!streaming) {
      state.sent = state.total;
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'mock',
          choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Everything enqueued here is a chunk the provider generated and billed.
        if (index > pieces.length) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          return controller.close();
        }
        state.sent += 1;
        controller.enqueue(new TextEncoder().encode(chunkAt(index)));
        index += 1;
      },
      cancel(reason) {
        state.cancelled = true;
        state.cancelReason = reason;
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
  new OpenAI({ apiKey: 'test', fetch: fetchImpl as unknown as typeof fetch, maxRetries: 0 });

const params = { model: 'mock', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('withOutputGuard on a real OpenAI client', () => {
  describe('chat.completions.create({ stream: false })', () => {
    it('passes healthy output through untouched', async () => {
      const { fetchImpl } = mockTransport(HEALTHY);
      const client = withOutputGuard(clientWith(fetchImpl as never), presets.chat);

      const completion = await client.chat.completions.create(params);
      expect(completion.choices[0].message.content).toBe(HEALTHY);
    });

    it('throws a retryable DegenerateOutputError on a loop', async () => {
      const { fetchImpl } = mockTransport(LOOPING, 'length');
      const client = withOutputGuard(clientWith(fetchImpl as never), presets.chat);

      const error = await client.chat.completions
        .create(params)
        .then(() => null, (e: unknown) => e);

      expect(error).toBeInstanceOf(DegenerateOutputError);
      expect((error as DegenerateOutputError).retryable).toBe(true);
      expect((error as DegenerateOutputError).verdict.reasons.map((r) => r.code)).toContain(
        'REPETITION',
      );
    });

    it("maps OpenAI's finish_reason so TRUNCATED can fire", async () => {
      const seen: Verdict[] = [];
      const { fetchImpl } = mockTransport(HEALTHY, 'length');
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        maxTruncation: 0.75,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      });

      await client.chat.completions.create(params);
      expect(seen[0].reasons.map((r) => r.code)).toContain('TRUNCATED');
    });
  });

  describe('chat.completions.create({ stream: true })', () => {
    it('forwards a healthy stream and reports the final verdict once', async () => {
      const onVerdict = vi.fn();
      const { state, fetchImpl } = mockTransport(HEALTHY);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onVerdict,
      });

      const stream = await client.chat.completions.create({ ...params, stream: true });
      let text = '';
      for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? '';

      expect(text).toBe(HEALTHY);
      expect(state.cancelled).toBe(false);
      expect(onVerdict).toHaveBeenCalledOnce();
      expect(onVerdict.mock.calls[0][0].ok).toBe(true);
      expect(onVerdict.mock.calls[0][1]).toEqual({ streaming: true });
    });

    /*
     * The claim that matters. Not "the guard fired" -- that the connection
     * closed, so the provider stopped generating and stopped billing.
     */
    it('cancels the HTTP response body, not just the iteration', async () => {
      const { state, fetchImpl } = mockTransport(LOOPING);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onDegenerate: 'abort',
      });

      const stream = await client.chat.completions.create({ ...params, stream: true });
      for await (const _ of stream) { /* drain until the guard stops it */ }

      // The server-side reader was closed by the client.
      expect(state.cancelled, 'response body was never cancelled').toBe(true);
      // And it happened early, not at the end of a fully-streamed response.
      expect(state.sent).toBeLessThan(state.total);

      // Nothing more is produced afterwards: the count is stable once closed.
      const settled = state.sent;
      await new Promise((r) => setTimeout(r, 20));
      expect(state.sent, 'provider kept generating after the abort').toBe(settled);
    });

    /*
     * The saving, measured against a baseline rather than asserted. `sent` is
     * chunks the mock server was actually asked to produce, so the unguarded
     * number is what the loop costs today and the guarded number is what it
     * costs with the guard on. The README quotes this figure; it is printed so
     * a change in it is visible rather than silently restated.
     */
    it('measures how much of the loop is never generated', async () => {
      const baseline = mockTransport(LOOPING);
      const plain = clientWith(baseline.fetchImpl as never);
      const full = await plain.chat.completions.create({ ...params, stream: true });
      for await (const _ of full) { /* the cost of a loop with no guard */ }

      const guarded = mockTransport(LOOPING);
      const client = withOutputGuard(clientWith(guarded.fetchImpl as never), {
        ...presets.chat,
        onDegenerate: 'abort',
      });
      const cut = await client.chat.completions.create({ ...params, stream: true });
      for await (const _ of cut) { /* guarded */ }

      expect(baseline.state.cancelled).toBe(false);
      expect(baseline.state.sent).toBe(baseline.state.total);
      expect(guarded.state.cancelled).toBe(true);

      const saved = 1 - guarded.state.sent / baseline.state.sent;
      // eslint-disable-next-line no-console
      console.log(
        `  openai stream guard: ${guarded.state.sent}/${baseline.state.sent} chunks generated ` +
          `-> ${Math.round(saved * 100)}% never generated`,
      );
      expect(saved).toBeGreaterThan(0.5);
    });

    it("errors the stream on 'throw' and still closes the connection", async () => {
      const { state, fetchImpl } = mockTransport(LOOPING);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onDegenerate: 'throw',
      });

      const stream = await client.chat.completions.create({ ...params, stream: true });
      const drain = async () => {
        for await (const _ of stream) { /* until it throws */ }
      };

      await expect(drain()).rejects.toBeInstanceOf(DegenerateOutputError);
      expect(state.cancelled).toBe(true);
      expect(state.sent).toBeLessThan(state.total);
    });

    it("delivers everything on 'ignore' while still reporting", async () => {
      const onVerdict = vi.fn();
      const { state, fetchImpl } = mockTransport(LOOPING);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onDegenerate: 'ignore',
        onVerdict,
      });

      const stream = await client.chat.completions.create({ ...params, stream: true });
      let text = '';
      for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? '';

      expect(text).toBe(LOOPING);
      expect(state.cancelled).toBe(false);
      expect(onVerdict.mock.calls.some(([v]) => !v.ok)).toBe(true);
    });

    it('does not report a final verdict for a stream it cut short', async () => {
      const onVerdict = vi.fn();
      const { fetchImpl } = mockTransport(LOOPING);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onDegenerate: 'abort',
        onVerdict,
      });

      const stream = await client.chat.completions.create({ ...params, stream: true });
      for await (const _ of stream) { /* drain */ }

      expect(onVerdict).toHaveBeenCalledOnce();
      expect(onVerdict.mock.calls[0][0].ok).toBe(false);
    });
  });

  describe('the verdict is not degraded relative to ./ai-sdk', () => {
    it('surfaces Verdict.modes and Reason.mode on a non-Latin loop', async () => {
      const { fetchImpl } = mockTransport(ZH_LOOPING);
      const client = withOutputGuard(clientWith(fetchImpl as never), presets.chat);

      const error = (await client.chat.completions
        .create(params)
        .then(() => null, (e: unknown) => e)) as DegenerateOutputError;

      expect(error).toBeInstanceOf(DegenerateOutputError);
      expect(error.verdict.modes?.TAIL_LOOP).toBe('char');
      const reason = error.verdict.reasons.find((r) => r.code === 'TAIL_LOOP');
      expect(reason?.mode).toBe('char');
    });

    /*
     * The deferral is `createStreamGuard`'s, and this asserts the adapter did
     * not reimplement it. Partial output really is short, really is cut off and
     * really is not valid JSON, so these firing mid-stream would fail every
     * healthy generation.
     */
    it('defers TOO_SHORT, TRUNCATED and INVALID_JSON mid-stream', async () => {
      const onVerdict = vi.fn();
      const { fetchImpl } = mockTransport(LOOPING);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        expectJson: true,
        maxTruncation: 0.5,
        onDegenerate: 'ignore',
        onVerdict,
      });

      const stream = await client.chat.completions.create({ ...params, stream: true });
      for await (const _ of stream) { /* drain */ }

      // Prose, mid-stream, with JSON expected: redundancy is reported and the
      // three deferred codes are not, despite all three being true right now.
      const midStream = onVerdict.mock.calls[0][0] as Verdict;
      expect(midStream.reasons.map((r) => r.code)).toContain('REPETITION');
      for (const deferred of ['TOO_SHORT', 'TRUNCATED', 'INVALID_JSON'] as const) {
        expect(midStream.reasons.map((r) => r.code)).not.toContain(deferred);
      }
    });

    it('runs the deferred detectors in the final check', async () => {
      const onVerdict = vi.fn();
      const { fetchImpl } = mockTransport(HEALTHY, 'length');
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        expectJson: true,
        maxTruncation: 0.5,
        onDegenerate: 'ignore',
        onVerdict,
      });

      const stream = await client.chat.completions.create({ ...params, stream: true });
      for await (const _ of stream) { /* drain */ }

      // Healthy prose never trips a mid-stream check, so this is end()'s verdict:
      // both the JSON contract and the mapped finish_reason are evaluated there.
      expect(onVerdict).toHaveBeenCalledOnce();
      const final = onVerdict.mock.calls[0][0] as Verdict;
      expect(final.reasons.map((r) => r.code)).toContain('INVALID_JSON');
      expect(final.reasons.map((r) => r.code)).toContain('TRUNCATED');
    });
  });

  describe('the client is otherwise untouched', () => {
    it('leaves non-completion methods alone', async () => {
      const { fetchImpl } = mockTransport(HEALTHY);
      const raw = clientWith(fetchImpl as never);
      const client = withOutputGuard(raw, presets.chat);
      expect(client.baseURL).toBe(raw.baseURL);
      expect(typeof client.chat.completions.create).toBe('function');
    });
  });
});
