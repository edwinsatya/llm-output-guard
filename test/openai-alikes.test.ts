import { describe, it, expect } from 'vitest';
import { withOutputGuard, toTurn } from '../src/openai.js';
import { presets } from '../src/presets.js';
import { extractTurn } from '../src/cli.js';
import { checkTrace } from '../src/agent.js';
import type { Verdict } from '../src/types.js';

/**
 * What this package reads from providers it does not adapt.
 *
 * The OpenAI subpath claims "anything speaking OpenAI's protocol", and that
 * claim is load-bearing: it is why there is no Groq adapter, no Together
 * adapter and no vLLM adapter. Nothing asserted it, so the claim was true by
 * inspection until an SDK renamed a field.
 *
 * The table below is that claim in assertable form. It is not a promise to
 * support every provider in it -- it is a record of which shapes map fully,
 * which map to nothing, and the rule that separates them.
 */

const clientReturning = (completion: unknown) => ({
  chat: { completions: { create: () => Promise.resolve(completion) } },
});

function recorder() {
  const seen: Verdict[] = [];
  return { seen, onVerdict: (v: Verdict) => seen.push(v) };
}

/**
 * Mistral's generated SDK renames `tool_calls` to `toolCalls`.
 *
 * A tool-calling turn carries no prose, so an unrecognised call list leaves
 * `content: ''` -- and the empty string scores `EMPTY: 1`. Every tool call from
 * a Mistral client aborted: `tool-calls.ts`'s founding bug, reintroduced by a
 * spelling, and invisible to every fixture made of prose.
 */
const mistralToolCall = (content: string | null = null) => ({
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content,
        toolCalls: [
          { id: 'call_1', type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Jakarta"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
});

describe('the guard: a renamed tool-call list is still a tool call', () => {
  it('does not fail a Mistral tool call that carries no text', async () => {
    const { seen, onVerdict } = recorder();
    const client = withOutputGuard(clientReturning(mistralToolCall()), {
      ...presets.chat,
      onVerdict,
    });

    await expect(client.chat.completions.create()).resolves.toBeDefined();
    // Nothing was judged, so nothing is reported -- not "judged and passed".
    expect(seen).toHaveLength(0);
  });

  it('judges a Mistral preamble as a preamble, not as the answer', async () => {
    const { seen, onVerdict } = recorder();
    const client = withOutputGuard(clientReturning(mistralToolCall('Let me look that up.')), {
      ...presets.chat,
      onVerdict,
    });

    await expect(client.chat.completions.create()).resolves.toBeDefined();
    expect(seen).toHaveLength(1);
    // Sixteen characters, and correct: minLength must not have applied.
    expect(seen[0]!.ok).toBe(true);
  });
});

/**
 * Every shape below is a real provider envelope. `full` means text *and* the
 * call with its arguments; `none` means an empty turn the trace drops.
 *
 * **There is deliberately no third column.** A partial map -- text extracted,
 * calls missed -- is the dangerous outcome, because a turn then fingerprints by
 * its preamble prose instead of its arguments, and an agent that reuses one
 * preamble while working through twenty files reads as a total collapse. That
 * is a false positive on a healthy run, which this package treats as worse than
 * a miss. The invariant asserted here is that no shape lands in between.
 */
const ENVELOPES: Array<[string, unknown, 'full' | 'none']> = [
  ['openai chat.completions', {
    choices: [{ message: { content: 'hi', tool_calls: [
      { function: { name: 'search', arguments: '{"q":"x"}' } }] } }],
  }, 'full'],
  ['groq / together / openrouter / fireworks / vllm', {
    choices: [{ message: { content: 'hi', tool_calls: [
      { function: { name: 'search', arguments: '{"q":"x"}' } }] } }],
  }, 'full'],
  ['ollama, openai-compatible endpoint', {
    choices: [{ message: { content: 'hi', tool_calls: [
      { function: { name: 'search', arguments: { q: 'x' } } }] } }],
  }, 'full'],
  ['mistral sdk', {
    choices: [{ message: { content: 'hi', toolCalls: [
      { function: { name: 'search', arguments: '{"q":"x"}' } }] } }],
  }, 'full'],
  ['legacy function_call gateways', {
    choices: [{ message: { content: 'hi', function_call: { name: 'search', arguments: '{}' } } }],
  }, 'full'],

  // Adapted by no subpath. Each must map to nothing rather than to half a turn.
  ['aws bedrock converse', {
    output: { message: { content: [{ text: 'hi' }, { toolUse: { name: 'search', input: {} } }] } },
    stopReason: 'tool_use',
  }, 'none'],
  ['cohere v2', {
    message: { content: [{ type: 'text', text: 'hi' }],
      tool_calls: [{ function: { name: 'search', arguments: '{}' } }] },
  }, 'none'],
  ['ollama native /api/chat', {
    message: { role: 'assistant', content: 'hi',
      tool_calls: [{ function: { name: 'search', arguments: {} } }] },
  }, 'none'],
  ['langchain AIMessage', {
    lc: 1, type: 'constructor', id: ['langchain_core', 'messages', 'AIMessage'],
    kwargs: { content: 'hi', tool_calls: [{ name: 'search', args: {} }] },
  }, 'none'],
];

describe('turn mapping: full or nothing, never half', () => {
  for (const [label, envelope, expected] of ENVELOPES) {
    it(`${label} maps ${expected}`, () => {
      const turn = extractTurn(envelope);

      if (expected === 'none') {
        expect(turn, 'an unsupported shape must map to nothing, not to half a turn').toBeNull();
        return;
      }

      expect(turn?.text).toBe('hi');
      expect(turn?.toolCalls?.[0]?.name).toBe('search');
      expect(turn?.toolCalls?.[0]?.arguments).toBeDefined();
    });
  }

  /**
   * The consequence of a partial map, demonstrated rather than described.
   *
   * Six turns of real progress behind one reused preamble. Mapped correctly the
   * arguments carry the progress and it passes; mapped to text alone every turn
   * is the same string and it scores a total collapse.
   */
  it('a preamble-only turn would turn healthy progress into a false positive', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f'];

    const mapped = files.map((f) => toTurn({
      choices: [{ message: { content: 'Let me check the next file.', toolCalls: [
        { function: { name: 'read_file', arguments: `{"path":"src/${f}.ts"}` } }] } }],
    }));
    expect(checkTrace(mapped).ok, 'arguments carry the progress').toBe(true);

    // The same six turns with the calls dropped -- what a partial map produces.
    const partial = files.map(() => ({ text: 'Let me check the next file.' }));
    expect(checkTrace(partial).scores.AGENT_LOOP).toBe(1);
  });
});
