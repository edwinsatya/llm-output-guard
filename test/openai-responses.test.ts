import { describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import { withOutputGuard } from '../src/openai.js';
import { DegenerateOutputError } from '../src/check.js';
import { presets } from '../src/presets.js';
import type { Verdict } from '../src/types.js';

/**
 * The Responses API, guarded through a real `OpenAI` client.
 *
 * This is the API OpenAI now points new code at, and 1.0.1 wrapped only
 * `chat.completions.create` -- so `withOutputGuard(new OpenAI())` returned a
 * client that looked guarded and checked nothing. Driving the real SDK rather
 * than a stub is what makes these tests worth having: the shapes below are the
 * ones the SDK actually produces from a wire payload, including the parts the
 * adapter reads by walking `output` instead of trusting a convenience field.
 */

const HEALTHY =
  'Redis pub/sub is the right primitive here. Each server subscribes to the room ' +
  'channel and publishes moves to it, so fan-out no longer depends on which instance ' +
  'a given socket happens to land on. The tradeoff is at-most-once delivery, so a ' +
  'client reconnecting mid-game refetches state rather than replaying it.';

const LOOPING =
  'Your strongest area is TypeScript. ' + 'You should add tests to this repo. '.repeat(60);

type Incomplete = 'max_output_tokens' | 'content_filter' | null;

const messageItem = (text: string) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});

const functionCallItem = {
  id: 'fc_1',
  type: 'function_call',
  call_id: 'call_1',
  name: 'get_weather',
  arguments: '{"city":"Jakarta"}',
  status: 'completed',
};

const responseBody = (output: unknown[], incomplete: Incomplete = null) => ({
  id: 'resp_test',
  object: 'response',
  created_at: 0,
  model: 'mock',
  status: incomplete ? 'incomplete' : 'completed',
  incomplete_details: incomplete ? { reason: incomplete } : null,
  output,
  parallel_tool_calls: false,
  tool_choice: 'auto',
  tools: [],
});

/**
 * A mock transport for `/responses`, counting what crossed the wire.
 *
 * Mirrors the chat-completions mock in `openai.test.ts` for the same reason:
 * "the guard fired" says nothing about whether the connection closed, and the
 * connection closing is the precondition for a provider stopping.
 */
function mockTransport(
  output: unknown[],
  { incomplete = null as Incomplete, chunkSize = 16, toolCall = false } = {},
) {
  const text = (output.find((o) => (o as { type: string }).type === 'message') as
    | { content: Array<{ text: string }> }
    | undefined)?.content[0].text ?? '';

  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) pieces.push(text.slice(i, i + chunkSize));

  const events: unknown[] = [];
  if (toolCall) {
    events.push({ type: 'response.output_item.added', output_index: 0, item: functionCallItem });
  }
  for (const piece of pieces) {
    events.push({ type: 'response.output_text.delta', output_index: 0, delta: piece });
  }
  events.push({
    type: incomplete ? 'response.incomplete' : 'response.completed',
    response: responseBody(output, incomplete),
  });

  const state = { sent: 0, total: events.length, cancelled: false };

  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = String((init as { body?: string } | undefined)?.body ?? '{}');

    if (JSON.parse(body).stream !== true) {
      state.sent = state.total;
      return new Response(JSON.stringify(responseBody(output, incomplete)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= events.length) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          return controller.close();
        }
        state.sent += 1;
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(events[index])}\n\n`),
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
  new OpenAI({ apiKey: 'test', fetch: fetchImpl as unknown as typeof fetch, maxRetries: 0 });

const params = { model: 'mock', input: 'hi' };

describe('withOutputGuard on responses.create', () => {
  describe('{ stream: false }', () => {
    it('passes healthy output through untouched', async () => {
      const { fetchImpl } = mockTransport([messageItem(HEALTHY)]);
      const client = withOutputGuard(clientWith(fetchImpl as never), presets.chat);

      const response = await client.responses.create(params);
      expect(response.output).toHaveLength(1);
    });

    /*
     * The regression this file exists for. Before `responses.create` was
     * wrapped, this resolved happily with a loop in it.
     */
    it('throws a retryable DegenerateOutputError on a loop', async () => {
      const { fetchImpl } = mockTransport([messageItem(LOOPING)]);
      const client = withOutputGuard(clientWith(fetchImpl as never), presets.chat);

      const error = await client.responses.create(params).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(DegenerateOutputError);
      expect((error as DegenerateOutputError).retryable).toBe(true);
      expect((error as DegenerateOutputError).verdict.reasons.map((r) => r.code)).toContain(
        'REPETITION',
      );
    });

    /*
     * This API spells its stop reason `incomplete_details.reason` rather than
     * `finish_reason`, and its length stop `max_output_tokens` rather than
     * `length`. Both already sit in `truncationScore`'s set, so the mapping is
     * a pass-through -- which is exactly the kind of claim that needs a test.
     */
    it('maps incomplete_details.reason so TRUNCATED can fire', async () => {
      const seen: Verdict[] = [];
      const { fetchImpl } = mockTransport([messageItem(HEALTHY)], {
        incomplete: 'max_output_tokens',
      });
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        maxTruncation: 0.75,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      });

      await client.responses.create(params);
      expect(seen[0].reasons.map((r) => r.code)).toContain('TRUNCATED');
    });

    /*
     * `content_filter` is the other value the field takes, and it is
     * deliberately not a length stop: a filtered response is a different
     * failure from a truncated one, and reporting it as TRUNCATED would send
     * a retry layer chasing the wrong fix.
     */
    it('does not read content_filter as truncation', async () => {
      const seen: Verdict[] = [];
      const { fetchImpl } = mockTransport([messageItem(HEALTHY)], { incomplete: 'content_filter' });
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        maxTruncation: 0.75,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      });

      await client.responses.create(params);
      expect(seen[0].reasons.map((r) => r.code)).not.toContain('TRUNCATED');
    });

    it('does not fail a response whose output is a tool call', async () => {
      const seen: Verdict[] = [];
      const { fetchImpl } = mockTransport([functionCallItem]);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onVerdict: (v) => seen.push(v),
      });

      await expect(client.responses.create(params)).resolves.toBeDefined();
      expect(seen).toHaveLength(0);
    });

    it('reads text from a message item sitting beside a tool call', async () => {
      const seen: Verdict[] = [];
      const { fetchImpl } = mockTransport([messageItem(LOOPING), functionCallItem]);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      });

      await client.responses.create(params);
      // The preamble is still judged for redundancy even though a tool was called.
      expect(seen[0].reasons.map((r) => r.code)).toContain('REPETITION');
    });

    /*
     * `reasoning` is the one non-message item that is not a tool call. Treating
     * it as one would silently switch the guard into preamble mode for every
     * reasoning-model response, which is most of them now.
     */
    it('does not mistake a reasoning item for a tool call', async () => {
      const { fetchImpl } = mockTransport([
        { id: 'rs_1', type: 'reasoning', summary: [] },
        messageItem(LOOPING),
      ]);
      const client = withOutputGuard(clientWith(fetchImpl as never), presets.chat);

      await expect(client.responses.create(params)).rejects.toBeInstanceOf(DegenerateOutputError);
    });
  });

  describe('{ stream: true }', () => {
    it('forwards a healthy stream and reports the final verdict once', async () => {
      const onVerdict = vi.fn();
      const { state, fetchImpl } = mockTransport([messageItem(HEALTHY)]);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onVerdict,
      });

      const stream = await client.responses.create({ ...params, stream: true });
      let text = '';
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') text += event.delta;
      }

      expect(text).toBe(HEALTHY);
      expect(state.cancelled).toBe(false);
      expect(onVerdict).toHaveBeenCalledOnce();
      expect(onVerdict.mock.calls[0][0].ok).toBe(true);
    });

    it('cancels the HTTP response body when the model starts looping', async () => {
      const { state, fetchImpl } = mockTransport([messageItem(LOOPING)]);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onDegenerate: 'abort',
      });

      const stream = await client.responses.create({ ...params, stream: true });
      for await (const _ of stream) { /* drain until the guard stops it */ }

      expect(state.cancelled, 'response body was never cancelled').toBe(true);
      expect(state.sent).toBeLessThan(state.total);

      const settled = state.sent;
      await new Promise((r) => setTimeout(r, 20));
      expect(state.sent, 'provider kept generating after the abort').toBe(settled);
    });

    it("errors the stream on 'throw' and still closes the connection", async () => {
      const { state, fetchImpl } = mockTransport([messageItem(LOOPING)]);
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onDegenerate: 'throw',
      });

      const stream = await client.responses.create({ ...params, stream: true });
      const drain = async () => {
        for await (const _ of stream) { /* until it throws */ }
      };

      await expect(drain()).rejects.toBeInstanceOf(DegenerateOutputError);
      expect(state.cancelled).toBe(true);
    });

    it('reports no verdict for a streamed tool call', async () => {
      const onVerdict = vi.fn();
      const { fetchImpl } = mockTransport([functionCallItem], { toolCall: true });
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        onVerdict,
      });

      const stream = await client.responses.create({ ...params, stream: true });
      for await (const _ of stream) { /* drain */ }

      expect(onVerdict).not.toHaveBeenCalled();
    });

    it('reads the stop reason off the terminal event', async () => {
      const onVerdict = vi.fn();
      const { fetchImpl } = mockTransport([messageItem(HEALTHY)], {
        incomplete: 'max_output_tokens',
      });
      const client = withOutputGuard(clientWith(fetchImpl as never), {
        ...presets.chat,
        maxTruncation: 0.75,
        onDegenerate: 'ignore',
        onVerdict,
      });

      const stream = await client.responses.create({ ...params, stream: true });
      for await (const _ of stream) { /* drain */ }

      const final = onVerdict.mock.calls[0][0] as Verdict;
      expect(final.reasons.map((r) => r.code)).toContain('TRUNCATED');
    });
  });

  describe('the client is otherwise untouched', () => {
    it('still guards chat.completions on the same client', async () => {
      const { fetchImpl } = mockTransport([messageItem(HEALTHY)]);
      const raw = clientWith(fetchImpl as never);
      const client = withOutputGuard(raw, presets.chat);

      // Both paths are proxied off one client; neither shadows the other.
      expect(typeof client.chat.completions.create).toBe('function');
      expect(typeof client.responses.create).toBe('function');
      expect(client.baseURL).toBe(raw.baseURL);
    });

    it('leaves responses.retrieve alone', async () => {
      const { fetchImpl } = mockTransport([messageItem(HEALTHY)]);
      const client = withOutputGuard(clientWith(fetchImpl as never), presets.chat);
      expect(typeof client.responses.retrieve).toBe('function');
      expect(typeof client.responses.stream).toBe('function');
    });

    /*
     * `openai@4.0.0` is at the bottom of the declared peer range and predates
     * the Responses API entirely, as does any OpenAI-compatible gateway that
     * only implements chat. Proxying a path that is not there must resolve to
     * `undefined` rather than throwing on property access.
     */
    it('tolerates a client with no responses resource at all', async () => {
      const legacy = {
        chat: {
          completions: {
            create: () =>
              Promise.resolve({
                choices: [{ message: { content: HEALTHY }, finish_reason: 'stop' }],
              }),
          },
        },
      };
      const client = withOutputGuard(legacy, presets.chat);

      expect((client as { responses?: unknown }).responses).toBeUndefined();
      await expect(client.chat.completions.create()).resolves.toBeDefined();
    });
  });
});
