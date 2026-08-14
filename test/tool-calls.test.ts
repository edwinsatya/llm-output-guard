import { describe, it, expect, vi } from 'vitest';
import { outputGuard } from '../src/ai-sdk.js';
import { withOutputGuard } from '../src/openai.js';
import { presets } from '../src/presets.js';
import type { Verdict } from '../src/types.js';

/**
 * The tool-call false positive, and the line either adapter must not cross.
 *
 * A model that answers by calling a tool returns no assistant text: OpenAI sends
 * `content: null` beside `tool_calls`, and the AI SDK sends a `content` array
 * with no `text` part. An adapter that concatenates text parts hands
 * `checkOutput` an empty string, which scores `EMPTY: 1` -- correctly, for the
 * question it was asked, and uselessly, because it was asked the wrong one.
 *
 * Untreated, that fails *every* tool-calling turn of every agent. These tests
 * exist because the failure is invisible in any fixture made of prose, and both
 * adapters shipped it in 1.0.1.
 */

const PREAMBLE = 'Let me look that up.';

const LOOPING_PREAMBLE =
  'Let me look that up. ' + 'I will check the weather for you. '.repeat(60);

/** An OpenAI tool-call completion: no content, one call, `tool_calls` stop. */
const toolCallCompletion = (content: string | null = null) => ({
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Jakarta"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
});

/** The AI SDK's equivalent: a `tool-call` content part and no `text` part. */
const toolCallContent = (text?: string) => ({
  content: [
    ...(text === undefined ? [] : [{ type: 'text', text }]),
    {
      type: 'tool-call',
      toolCallId: 'call_1',
      toolName: 'get_weather',
      input: '{"city":"Jakarta"}',
    },
  ],
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
});

const clientReturning = (completion: unknown) => ({
  chat: { completions: { create: () => Promise.resolve(completion) } },
});

/** Every verdict the guard reported, whatever it decided to do about it. */
function recorder() {
  const seen: Verdict[] = [];
  return { seen, onVerdict: (v: Verdict) => seen.push(v) };
}

describe('a tool call is not an empty response', () => {
  describe('./openai', () => {
    it('does not fail a tool call that carries no text', async () => {
      const { seen, onVerdict } = recorder();
      const client = withOutputGuard(clientReturning(toolCallCompletion()), {
        ...presets.chat,
        onVerdict,
      });

      await expect(client.chat.completions.create()).resolves.toBeDefined();
      // Not merely "did not throw": nothing was judged, so nothing is reported.
      expect(seen).toHaveLength(0);
    });

    it('judges a preamble as a preamble, not as the answer', async () => {
      const { seen, onVerdict } = recorder();
      const client = withOutputGuard(clientReturning(toolCallCompletion(PREAMBLE)), {
        ...presets.chat,
        onVerdict,
      });

      await expect(client.chat.completions.create()).resolves.toBeDefined();
      expect(seen).toHaveLength(1);
      expect(seen[0].ok).toBe(true);
    });

    /*
     * The reason the fix is an overlay rather than a blanket skip. Redundancy
     * detectors still mean what they always meant: a model looping in its
     * preamble is looping, whatever it goes on to call.
     */
    it('still catches a model looping in its preamble', async () => {
      const client = withOutputGuard(clientReturning(toolCallCompletion(LOOPING_PREAMBLE)), {
        ...presets.chat,
        onDegenerate: 'throw',
      });

      const error = await client.chat.completions.create().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain('REPETITION');
    });

    /*
     * Each of these presets fails a healthy tool call for a different reason,
     * which is why the overlay switches off three detectors rather than one.
     * `longForm` on its 200-character minimum, `strictJson` on prose where it
     * wanted a payload -- the payload being in the call arguments, which the
     * provider validated against the schema already.
     */
    it.each([
      ['longForm', presets.longForm, 'TOO_SHORT'],
      ['strictJson', presets.strictJson, 'INVALID_JSON'],
    ])('does not fail a tool call under presets.%s', async (_name, preset, code) => {
      const { seen, onVerdict } = recorder();
      const client = withOutputGuard(clientReturning(toolCallCompletion(PREAMBLE)), {
        ...preset,
        maxTruncation: 0.5,
        onDegenerate: 'ignore',
        onVerdict,
      });

      await client.chat.completions.create();
      expect(seen[0]?.reasons.map((r) => r.code) ?? []).not.toContain(code);
      expect(seen[0]?.ok).toBe(true);
    });

    it('reports no verdict for a streamed tool call', async () => {
      const { seen, onVerdict } = recorder();
      const chunks = [
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather' } }],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ];

      const client = withOutputGuard(
        {
          chat: {
            completions: {
              create: () =>
                Promise.resolve({
                  async *[Symbol.asyncIterator]() {
                    for (const chunk of chunks) yield chunk;
                  },
                }),
            },
          },
        },
        { ...presets.chat, onVerdict },
      );

      const stream = await client.chat.completions.create();
      for await (const _ of stream as AsyncIterable<unknown>) { /* drain */ }

      // An EMPTY here would be a spike of EMPTY:1 samples in every calibration
      // run, describing the agent's tool use rather than any degeneration.
      expect(seen).toHaveLength(0);
    });
  });

  describe('./ai-sdk', () => {
    it('does not fail a tool call that carries no text', async () => {
      const { seen, onVerdict } = recorder();
      const guard = outputGuard({ ...presets.chat, onVerdict });

      await expect(
        guard.wrapGenerate({ doGenerate: () => Promise.resolve(toolCallContent()) }),
      ).resolves.toBeDefined();
      expect(seen).toHaveLength(0);
    });

    it('judges a preamble as a preamble, not as the answer', async () => {
      const { seen, onVerdict } = recorder();
      const guard = outputGuard({ ...presets.chat, onVerdict });

      await guard.wrapGenerate({ doGenerate: () => Promise.resolve(toolCallContent(PREAMBLE)) });
      expect(seen).toHaveLength(1);
      expect(seen[0].ok).toBe(true);
    });

    it('still catches a model looping in its preamble', async () => {
      const guard = outputGuard({ ...presets.chat, onDegenerate: 'throw' });
      await expect(
        guard.wrapGenerate({
          doGenerate: () => Promise.resolve(toolCallContent(LOOPING_PREAMBLE)),
        }),
      ).rejects.toThrow(/REPETITION/);
    });

    it.each([
      ['longForm', presets.longForm, 'TOO_SHORT'],
      ['strictJson', presets.strictJson, 'INVALID_JSON'],
    ])('does not fail a tool call under presets.%s', async (_name, preset, code) => {
      const { seen, onVerdict } = recorder();
      const guard = outputGuard({
        ...preset,
        maxTruncation: 0.5,
        onDegenerate: 'ignore',
        onVerdict,
      });

      await guard.wrapGenerate({ doGenerate: () => Promise.resolve(toolCallContent(PREAMBLE)) });
      expect(seen[0]?.reasons.map((r) => r.code) ?? []).not.toContain(code);
      expect(seen[0]?.ok).toBe(true);
    });

    /*
     * Streamed tool input arrives as `tool-input-start` / `tool-input-delta` /
     * `tool-input-end` before any `tool-call` part, so the prefix match in the
     * adapter is what makes this stream recognisable as a tool call at all.
     */
    it('reports no verdict for a streamed tool call', async () => {
      const onVerdict = vi.fn();
      const parts = [
        { type: 'tool-input-start', id: 'call_1', toolName: 'get_weather' },
        { type: 'tool-input-delta', id: 'call_1', delta: '{"city":' },
        { type: 'tool-input-delta', id: 'call_1', delta: '"Jakarta"}' },
        { type: 'tool-input-end', id: 'call_1' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'get_weather',
          input: '{"city":"Jakarta"}',
        },
        { type: 'finish', finishReason: { unified: 'tool-calls' }, usage: {} },
      ];

      const guard = outputGuard({ ...presets.chat, onVerdict });
      const result = await guard.wrapStream({
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream({
              start(controller) {
                for (const part of parts) controller.enqueue(part);
                controller.close();
              },
            }),
          }),
      });

      for await (const _ of result.stream as unknown as AsyncIterable<unknown>) { /* drain */ }
      expect(onVerdict).not.toHaveBeenCalled();
    });
  });

  /*
   * The other half of the fix. Suppressing EMPTY on tool calls is only correct
   * if it stays on for a response that genuinely returned nothing -- which is
   * the case this whole package was written about.
   */
  describe('the EMPTY detector is not disarmed', () => {
    it('./openai still fails a response with neither text nor tool calls', async () => {
      const client = withOutputGuard(
        clientReturning({
          choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        }),
        { ...presets.chat, onDegenerate: 'throw' },
      );

      await expect(client.chat.completions.create()).rejects.toThrow(/EMPTY/);
    });

    it('./ai-sdk still fails a response with neither text nor tool calls', async () => {
      const guard = outputGuard({ ...presets.chat, onDegenerate: 'throw' });
      await expect(
        guard.wrapGenerate({
          doGenerate: () => Promise.resolve({ content: [], finishReason: 'stop' }),
        }),
      ).rejects.toThrow(/EMPTY/);
    });
  });
});
