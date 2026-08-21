import { describe, it, expect } from 'vitest';
import { withOutputGuard as guardOpenAI } from '../src/openai.js';
import { withOutputGuard as guardAnthropic } from '../src/anthropic.js';
import { outputGuard } from '../src/ai-sdk.js';
import { presets } from '../src/presets.js';
import { DegenerateOutputError } from '../src/check.js';
import type { Verdict } from '../src/types.js';

/**
 * `PROMPT_ECHO` needs the prompt, and 1.5.0 could only be given one through
 * `checkOutput` -- so the detector was unreachable from the adapters, which is
 * the API the README leads with. A guard is configured once when the client is
 * wrapped and the prompt changes every call, so the option is a switch and the
 * adapter reads the prompt out of the request it is already forwarding.
 */

const SYSTEM = `You are a senior backend engineer reviewing infrastructure decisions.
Answer concisely and prefer concrete tradeoffs over general advice. Never invent
benchmark numbers. If the question is ambiguous, state the assumption you are
making and answer under it. Format your reply as prose, not bullet points.`;

const USER = `We are running six worker processes per container and each one opens its own
connection pool of twenty connections. The database is configured with a maximum
of three hundred connections. Is that safe if we scale to four containers?`;

const ANSWER = `No. Twenty-four pools of twenty connections is four hundred and eighty
against a ceiling of three hundred, so you are oversubscribed before adding replicas.
Size for the deploy peak rather than the steady state, because rolling restarts briefly
double the process count, and alert on rejected connections rather than saturation.`;

/** What a model does when it loses the turn boundary: it replays the input. */
const ECHO = `${SYSTEM}\n\n${USER}`;

const chatRequest = {
  model: 'gpt-4.1',
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: USER },
  ],
};

const responsesRequest = { model: 'gpt-4.1', instructions: SYSTEM, input: USER };

const anthropicRequest = {
  model: 'claude-sonnet-4',
  system: SYSTEM,
  messages: [{ role: 'user', content: USER }],
};

const aiSdkParams = {
  prompt: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: [{ type: 'text', text: USER }] },
  ],
};

const chatClient = (text: string) => ({
  chat: {
    completions: {
      create: (_req?: unknown) =>
        Promise.resolve({
          choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        }),
    },
  },
});

const responsesClient = (text: string) => ({
  responses: {
    create: (_req?: unknown) =>
      Promise.resolve({
        output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
      }),
  },
});

const messagesClient = (text: string) => ({
  messages: {
    create: (_req?: unknown) =>
      Promise.resolve({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }),
  },
});

function recorder() {
  const seen: Verdict[] = [];
  return { seen, onVerdict: (v: Verdict) => seen.push(v) };
}

type Run = (text: string, opts?: Record<string, unknown>) => Promise<Verdict[]>;

const runners: Array<[string, Run]> = [
  ['openai chat.completions', async (text, opts = {}) => {
    const { seen, onVerdict } = recorder();
    const c = guardOpenAI(chatClient(text), {
      ...presets.chat, checkPromptEcho: true, onDegenerate: 'ignore', onVerdict, ...opts });
    await c.chat.completions.create(chatRequest);
    return seen;
  }],
  ['openai responses', async (text, opts = {}) => {
    const { seen, onVerdict } = recorder();
    const c = guardOpenAI(responsesClient(text), {
      ...presets.chat, checkPromptEcho: true, onDegenerate: 'ignore', onVerdict, ...opts });
    await c.responses.create(responsesRequest);
    return seen;
  }],
  ['anthropic messages', async (text, opts = {}) => {
    const { seen, onVerdict } = recorder();
    const c = guardAnthropic(messagesClient(text), {
      ...presets.chat, checkPromptEcho: true, onDegenerate: 'ignore', onVerdict, ...opts });
    await c.messages.create(anthropicRequest);
    return seen;
  }],
  ['ai-sdk', async (text, opts = {}) => {
    const { seen, onVerdict } = recorder();
    const mw = outputGuard({
      ...presets.chat, checkPromptEcho: true, onDegenerate: 'ignore', onVerdict, ...opts });
    await mw.wrapGenerate({
      doGenerate: () => Promise.resolve({ content: [{ type: 'text', text }] }),
      params: aiSdkParams,
    } as never);
    return seen;
  }],
];

describe('each adapter reads the prompt out of its own request shape', () => {
  for (const [name, run] of runners) {
    it(`${name}: catches an echoed prompt`, async () => {
      const seen = await run(ECHO);
      expect(seen).toHaveLength(1);
      expect(seen[0].ok, 'an echoed prompt is degenerate').toBe(false);
      expect(seen[0].reasons.map((r) => r.code)).toContain('PROMPT_ECHO');
      expect(seen[0].scores.PROMPT_ECHO).toBeGreaterThan(0.9);
    });

    it(`${name}: leaves a real answer alone`, async () => {
      const seen = await run(ANSWER);
      expect(seen).toHaveLength(1);
      const detail = seen[0].reasons.map((r) => `${r.code}=${r.score.toFixed(3)}`).join(', ');
      expect(seen[0].ok, `false positive on a healthy answer [${detail}]`).toBe(true);
      expect(seen[0].scores.PROMPT_ECHO).toBe(0);
    });

    it(`${name}: does nothing unless asked`, async () => {
      const seen = await run(ECHO, { checkPromptEcho: false });
      expect(seen).toHaveLength(1);
      expect(seen[0].ok, 'off by default, so 1.5.0 behaviour is unchanged').toBe(true);
      expect(seen[0].scores.PROMPT_ECHO).toBeUndefined();
    });
  }
});

describe('what the adapter counts as the prompt', () => {
  /**
   * Prior assistant turns are the model's own output, not its input. Including
   * them would make a model that keeps its terminology consistent across a long
   * conversation look worse the longer the conversation ran.
   */
  it('ignores earlier assistant turns', async () => {
    const { seen, onVerdict } = recorder();
    const c = guardOpenAI(chatClient(ANSWER), {
      ...presets.chat, checkPromptEcho: true, onDegenerate: 'ignore', onVerdict });

    await c.chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'What about connection pools?' },
        // The same answer, already given once. Repeating it is consistency.
        { role: 'assistant', content: ANSWER },
        { role: 'user', content: USER },
      ],
    });

    expect(seen[0].scores.PROMPT_ECHO, 'the assistant turn is not part of the prompt').toBe(0);
    expect(seen[0].ok).toBe(true);
  });

  it('reads multimodal content parts, and ignores the non-text ones', async () => {
    const { seen, onVerdict } = recorder();
    const c = guardOpenAI(chatClient(ECHO), {
      ...presets.chat, checkPromptEcho: true, onDegenerate: 'ignore', onVerdict });

    await c.chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: [{ type: 'text', text: SYSTEM }] },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
            { type: 'text', text: USER },
          ],
        },
      ],
    });

    expect(seen[0].scores.PROMPT_ECHO).toBeGreaterThan(0.9);
  });

  it('an explicit prompt in the options wins over the request', async () => {
    const { seen, onVerdict } = recorder();
    const c = guardOpenAI(chatClient(ECHO), {
      ...presets.chat,
      checkPromptEcho: true,
      prompt: 'something else entirely, sharing no runs with the response at all',
      onDegenerate: 'ignore',
      onVerdict,
    });

    await c.chat.completions.create(chatRequest);
    expect(seen[0].scores.PROMPT_ECHO, 'the caller stated the prompt, so it is used').toBe(0);
  });

  it('abstains when the request carries no readable prompt', async () => {
    const { seen, onVerdict } = recorder();
    const c = guardOpenAI(chatClient(ECHO), {
      ...presets.chat, checkPromptEcho: true, onDegenerate: 'ignore', onVerdict });

    await c.chat.completions.create({ model: 'gpt-4.1' });
    expect(seen[0].scores.PROMPT_ECHO).toBeUndefined();
    expect(seen[0].ok).toBe(true);
  });

  it('survives a request that is not an object at all', async () => {
    const c = guardOpenAI(chatClient(ANSWER), {
      ...presets.chat, checkPromptEcho: true, onDegenerate: 'throw' });
    await expect(c.chat.completions.create()).resolves.toBeDefined();
    await expect(c.chat.completions.create(null)).resolves.toBeDefined();
    await expect(c.chat.completions.create('nonsense')).resolves.toBeDefined();
  });
});

describe('throwing, and streams', () => {
  it('throws a DegenerateOutputError carrying the verdict', async () => {
    const c = guardOpenAI(chatClient(ECHO), {
      ...presets.chat, checkPromptEcho: true, onDegenerate: 'throw' });

    const error = await c.chat.completions.create(chatRequest).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(DegenerateOutputError);
    expect((error as DegenerateOutputError).verdict.reasons.map((r) => r.code))
      .toContain('PROMPT_ECHO');
  });

  /**
   * The prompt reaches `end()` and not the mid-stream checks, because the score
   * is a share of the whole output and a trailing window measures the share of
   * that window.
   *
   * Asserted by counting rather than by reading `context.streaming`: every
   * verdict a stream produces is reported with `streaming: true`, the final one
   * included, because the flag describes the call and not which check ran. What
   * distinguishes them is that under `'ignore'` a mid-stream check reports only
   * when it *fails* -- so if the deferral broke and `PROMPT_ECHO` scored on a
   * window, there would be extra verdicts before this one.
   */
  it('a streamed echo is caught at the end, not mid-stream', async () => {
    const chunks = ECHO.match(/[\s\S]{1,60}/g) ?? [];
    const makeStream = () => ({
      controller: { abort: () => {} },
      async *[Symbol.asyncIterator]() {
        for (const delta of chunks) yield { choices: [{ delta: { content: delta } }] };
      },
    });

    const seen: Verdict[] = [];
    const c = guardOpenAI(
      { chat: { completions: { create: (_req?: unknown) => Promise.resolve(makeStream()) } } },
      {
        ...presets.chat,
        checkPromptEcho: true,
        onDegenerate: 'ignore',
        onVerdict: (verdict) => seen.push(verdict),
      },
    );

    const guarded = await c.chat.completions.create(chatRequest);
    for await (const _ of guarded as AsyncIterable<unknown>) { /* drain */ }

    expect(seen, 'exactly one verdict: no mid-stream check fired').toHaveLength(1);
    expect(seen[0].scores.PROMPT_ECHO).toBeGreaterThan(0.9);
    expect(seen[0].ok).toBe(false);
  });

  it('a streamed healthy answer passes, prompt and all', async () => {
    const chunks = ANSWER.match(/[\s\S]{1,60}/g) ?? [];
    const stream = {
      controller: { abort: () => {} },
      async *[Symbol.asyncIterator]() {
        for (const delta of chunks) yield { choices: [{ delta: { content: delta } }] };
      },
    };

    const seen: Verdict[] = [];
    const c = guardOpenAI(
      { chat: { completions: { create: (_req?: unknown) => Promise.resolve(stream) } } },
      { ...presets.chat, checkPromptEcho: true, onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v) },
    );

    const guarded = await c.chat.completions.create(chatRequest);
    for await (const _ of guarded as AsyncIterable<unknown>) { /* drain */ }

    expect(seen).toHaveLength(1);
    expect(seen[0].ok, 'no false positive on a streamed real answer').toBe(true);
    expect(seen[0].scores.PROMPT_ECHO).toBe(0);
  });
});
