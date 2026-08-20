import { describe, it, expect } from 'vitest';
import { withOutputGuard as guardOpenAI } from '../src/openai.js';
import { withOutputGuard as guardAnthropic } from '../src/anthropic.js';
import { outputGuard } from '../src/ai-sdk.js';
import { presets } from '../src/presets.js';
import { DegenerateOutputError } from '../src/check.js';
import type { Verdict } from '../src/types.js';

/**
 * The hole `checkToolArguments` closes.
 *
 * A tool-calling turn is judged by its preamble, which is correct and leaves
 * the answer itself unmeasured. The provider validates arguments against the
 * declared schema, and a schema covers types: a `string` that loops forever is
 * a valid `string`, and it reaches your tool intact.
 *
 * These fixtures are all schema-valid. That is the point -- every one of them
 * would pass the provider's own validation and every check this package made
 * before 1.5.
 */

/** A query that loops. Schema-valid, and useless as a search. */
const LOOPING_ARGS = JSON.stringify({
  query: 'site reliability engineering '.repeat(40),
  limit: 10,
});

/** The same call, working correctly. */
const HEALTHY_ARGS = JSON.stringify({
  query: 'connection pool sizing for worker processes in production',
  limit: 10,
});

const PREAMBLE = 'Let me look that up.';
const LOOPING_PREAMBLE = 'Let me look that up. ' + 'I will check that for you. '.repeat(60);

const openAICompletion = (args: string, content: string | null = null) => ({
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: args } }],
    },
    finish_reason: 'tool_calls',
  }],
});

const openAIResponses = (args: string) => ({
  output: [{ type: 'function_call', name: 'search', call_id: 'call_1', arguments: args }],
});

/** Anthropic sends `input` already parsed, which is the shape difference. */
const anthropicMessage = (args: string, text?: string) => ({
  content: [
    ...(text === undefined ? [] : [{ type: 'text', text }]),
    { type: 'tool_use', id: 'call_1', name: 'search', input: JSON.parse(args) },
  ],
  stop_reason: 'tool_use',
});

const aiSdkResult = (args: string, text?: string) => ({
  content: [
    ...(text === undefined ? [] : [{ type: 'text', text }]),
    { type: 'tool-call', toolCallId: 'call_1', toolName: 'search', input: JSON.parse(args) },
  ],
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
});

const chatClient = (completion: unknown) => ({
  chat: { completions: { create: () => Promise.resolve(completion) } },
});
const responsesClient = (response: unknown) => ({
  responses: { create: () => Promise.resolve(response) },
});
const messagesClient = (message: unknown) => ({
  messages: { create: () => Promise.resolve(message) },
});

function recorder() {
  const seen: Verdict[] = [];
  return { seen, onVerdict: (v: Verdict) => seen.push(v) };
}

/** Drives the AI SDK middleware without pulling in `wrapLanguageModel`. */
const generateVia = (result: unknown, options: Parameters<typeof outputGuard>[0]) =>
  outputGuard(options).wrapGenerate({ doGenerate: () => Promise.resolve(result) } as never);

describe('tool arguments are unmeasured unless asked for', () => {
  it('a looping argument passes when the option is off', async () => {
    const { seen, onVerdict } = recorder();
    const client = guardOpenAI(chatClient(openAICompletion(LOOPING_ARGS, PREAMBLE)), {
      ...presets.chat, onVerdict,
    });

    await expect(client.chat.completions.create()).resolves.toBeDefined();
    expect(seen).toHaveLength(1);
    expect(seen[0].ok, 'off by default, so 1.4.x behaviour is unchanged').toBe(true);
  });

  it('and fails when it is on', async () => {
    const client = guardOpenAI(chatClient(openAICompletion(LOOPING_ARGS, PREAMBLE)), {
      ...presets.chat, checkToolArguments: true, onDegenerate: 'throw',
    });

    const error = await client.chat.completions.create().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(DegenerateOutputError);
    const codes = (error as DegenerateOutputError).verdict.reasons.map((r) => r.code);
    expect(codes.some((c) => c === 'REPETITION' || c === 'TAIL_LOOP')).toBe(true);
  });

  it('says where the loop was, without changing the code', async () => {
    const { seen, onVerdict } = recorder();
    const client = guardOpenAI(chatClient(openAICompletion(LOOPING_ARGS, PREAMBLE)), {
      ...presets.chat, checkToolArguments: true, onDegenerate: 'ignore', onVerdict,
    });

    await client.chat.completions.create();
    const reason = seen[0].reasons.find((r) => r.message.includes('tool call argument'));
    expect(reason, 'the message names the argument as the source').toBeDefined();
    // The code is the one an existing handler already switches on.
    expect(['REPETITION', 'TAIL_LOOP']).toContain(reason!.code);
  });
});

describe('every adapter reaches its own argument shape', () => {
  const cases: Array<[string, (args: string) => Promise<Verdict[]>]> = [
    ['openai chat.completions', async (args) => {
      const { seen, onVerdict } = recorder();
      const c = guardOpenAI(chatClient(openAICompletion(args)), {
        ...presets.chat, checkToolArguments: true, onDegenerate: 'ignore', onVerdict });
      await c.chat.completions.create();
      return seen;
    }],
    ['openai responses', async (args) => {
      const { seen, onVerdict } = recorder();
      const c = guardOpenAI(responsesClient(openAIResponses(args)), {
        ...presets.chat, checkToolArguments: true, onDegenerate: 'ignore', onVerdict });
      await c.responses.create();
      return seen;
    }],
    ['anthropic messages', async (args) => {
      const { seen, onVerdict } = recorder();
      const c = guardAnthropic(messagesClient(anthropicMessage(args)), {
        ...presets.chat, checkToolArguments: true, onDegenerate: 'ignore', onVerdict });
      await c.messages.create();
      return seen;
    }],
    ['ai-sdk', async (args) => {
      const { seen, onVerdict } = recorder();
      await generateVia(aiSdkResult(args), {
        ...presets.chat, checkToolArguments: true, onDegenerate: 'ignore', onVerdict });
      return seen;
    }],
  ];

  for (const [name, run] of cases) {
    it(`${name}: catches a looping argument`, async () => {
      const seen = await run(LOOPING_ARGS);
      expect(seen).toHaveLength(1);
      expect(seen[0].ok, 'a looping argument is degenerate').toBe(false);
    });

    it(`${name}: passes a healthy argument`, async () => {
      const seen = await run(HEALTHY_ARGS);
      expect(seen).toHaveLength(1);
      const detail = seen[0].reasons.map((r) => `${r.code}=${r.score.toFixed(3)}`).join(', ');
      expect(seen[0].ok, `false positive on a healthy call [${detail}]`).toBe(true);
    });
  }
});

/**
 * The false positives this must not create. Arguments are small structured
 * objects, and the naive implementation -- measure the serialised form --
 * flags all of these.
 */
describe('what must not be flagged', () => {
  const passes = async (args: string) => {
    const { seen, onVerdict } = recorder();
    const c = guardOpenAI(chatClient(openAICompletion(args)), {
      ...presets.chat, checkToolArguments: true, onDegenerate: 'ignore', onVerdict });
    await c.chat.completions.create();
    return seen[0]?.ok ?? true;
  };

  it('a short argument does not trip a length minimum', async () => {
    expect(await passes(JSON.stringify({ city: 'Jakarta' }))).toBe(true);
  });

  it('an argument of pure numbers has nothing to judge', async () => {
    expect(await passes(JSON.stringify({ lat: -6.2, lon: 106.8, zoom: 11 }))).toBe(true);
  });

  it('repeated keys across many fields are scaffolding, not a loop', async () => {
    const wide = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`field_${i}`, `value ${i}`]),
    );
    expect(await passes(JSON.stringify(wide))).toBe(true);
  });

  it('an array of near-identical records is the shape that was asked for', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: i, service: `svc-${i}`, status: 'healthy',
    }));
    expect(await passes(JSON.stringify({ rows }))).toBe(true);
  });

  it('a preset that fails prose on truncation does not fail an argument', async () => {
    const { seen, onVerdict } = recorder();
    const c = guardOpenAI(chatClient(openAICompletion(HEALTHY_ARGS)), {
      ...presets.longForm, checkToolArguments: true, onDegenerate: 'ignore', onVerdict });
    await c.chat.completions.create();
    expect(seen[0].ok, 'longForm has a 200-char minimum and truncation on').toBe(true);
  });
});

describe('merging with the preamble verdict', () => {
  it('reports both when both are degenerate', async () => {
    const { seen, onVerdict } = recorder();
    const c = guardOpenAI(chatClient(openAICompletion(LOOPING_ARGS, LOOPING_PREAMBLE)), {
      ...presets.chat, checkToolArguments: true, onDegenerate: 'ignore', onVerdict });
    await c.chat.completions.create();

    const messages = seen[0].reasons.map((r) => r.message);
    expect(messages.some((m) => m.includes('tool call argument'))).toBe(true);
    expect(messages.some((m) => !m.includes('tool call argument'))).toBe(true);
  });

  it('reports the argument alone when there is no preamble at all', async () => {
    const { seen, onVerdict } = recorder();
    const c = guardOpenAI(chatClient(openAICompletion(LOOPING_ARGS)), {
      ...presets.chat, checkToolArguments: true, onDegenerate: 'ignore', onVerdict });
    await c.chat.completions.create();

    expect(seen).toHaveLength(1);
    expect(seen[0].ok).toBe(false);
    expect(seen[0].reasons.every((r) => r.message.includes('tool call argument'))).toBe(true);
  });

  /*
   * The `null` rule from `checkPreamble`, extended. A call with no arguments
   * and no preamble has nothing to measure, and a manufactured passing verdict
   * would report a check that never ran -- and would poison a calibration run.
   */
  it('stays silent when there is nothing to judge', async () => {
    const { seen, onVerdict } = recorder();
    const c = guardOpenAI(chatClient(openAICompletion('{}')), {
      ...presets.chat, checkToolArguments: true, onDegenerate: 'ignore', onVerdict });
    await c.chat.completions.create();
    expect(seen).toHaveLength(0);
  });
});
