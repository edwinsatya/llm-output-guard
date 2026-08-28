import { describe, it, expect } from 'vitest';
import { toTurn as fromOpenAI } from '../src/openai.js';
import { toTurn as fromAnthropic } from '../src/anthropic.js';
import { toTurn as fromGemini } from '../src/google.js';
import { toTurn as fromAiSdk } from '../src/ai-sdk.js';
import { checkTrace } from '../src/agent.js';
import { fingerprintTurn } from '../src/internal/turn-fingerprint.js';

const NONE = new Set<string>();
const times = <T>(n: number, make: () => T): T[] => Array.from({ length: n }, make);

/**
 * The property these mappers exist for.
 *
 * Hand-mapping a turn is four lines, and getting one field wrong does not
 * throw, warn or score high -- it makes every turn fingerprint differently, so
 * `AGENT_LOOP` reports 0.000 forever and the guard silently never runs. So it
 * is not enough to assert the mapper returns the right object: what has to hold
 * is that a real six-turn loop, mapped from a real provider envelope, is
 * actually *caught*.
 */
describe('toTurn: a mapped loop is a caught loop', () => {
  const openaiCall = () => ({
    choices: [
      {
        message: {
          content: 'Let me read the config.',
          tool_calls: [
            { function: { name: 'read_file', arguments: '{"path":"src/config.ts"}' } },
          ],
        },
      },
    ],
  });

  const anthropicCall = () => ({
    content: [
      { type: 'text', text: 'Let me read the config.' },
      { type: 'tool_use', name: 'read_file', input: { path: 'src/config.ts' } },
    ],
  });

  const geminiCall = () => ({
    candidates: [
      {
        content: {
          parts: [
            { text: 'Let me read the config.' },
            { functionCall: { name: 'read_file', args: { path: 'src/config.ts' } } },
          ],
        },
      },
    ],
  });

  const aiSdkCall = () => ({
    text: 'Let me read the config.',
    toolCalls: [{ toolName: 'read_file', input: { path: 'src/config.ts' } }],
  });

  const cases = [
    ['openai', openaiCall, fromOpenAI],
    ['anthropic', anthropicCall, fromAnthropic],
    ['google', geminiCall, fromGemini],
    ['ai-sdk', aiSdkCall, fromAiSdk],
  ] as const;

  for (const [name, make, map] of cases) {
    it(`catches six identical ${name} turns`, () => {
      const verdict = checkTrace(times(6, () => map(make())));
      expect(verdict.ok).toBe(false);
      expect(verdict.reasons[0]!.code).toBe('AGENT_LOOP');
      expect(verdict.scores.AGENT_LOOP).toBe(1);
    });

    it(`does not flag six ${name} turns that make progress`, () => {
      const turns = ['a', 'b', 'c', 'd', 'e', 'f'].map((file) => {
        const response = JSON.parse(JSON.stringify(make()));
        const json = JSON.stringify(response).replace(/src\/config\.ts/g, `src/${file}.ts`);
        return map(JSON.parse(json));
      });
      expect(checkTrace(turns).ok).toBe(true);
    });
  }

  /**
   * The claim the docs make about mixed sources, asserted.
   *
   * OpenAI sends arguments as a JSON string and Anthropic as a parsed object.
   * If those fingerprinted differently, a trace assembled across a provider
   * failover would read as progress at the exact moment it is most likely to be
   * looping.
   */
  it('fingerprints the same call identically across all four providers', () => {
    const prints = cases.map(([, make, map]) => fingerprintTurn(map(make()), NONE));
    expect(new Set(prints).size, `got ${JSON.stringify(prints)}`).toBe(1);
  });
});

describe('toTurn: openai', () => {
  it('reads only the first choice', () => {
    const turn = fromOpenAI({
      choices: [
        { message: { content: 'first' } },
        { message: { content: 'an alternative nobody receives' } },
      ],
    });
    expect(turn.text).toBe('first');
  });

  it('reads the Responses API too', () => {
    const turn = fromOpenAI({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Looking that up.' }] },
        { type: 'function_call', name: 'search', arguments: '{"q":"hydration"}' },
      ],
    });
    expect(turn.text).toBe('Looking that up.');
    expect(turn.toolCalls).toEqual([{ name: 'search', arguments: '{"q":"hydration"}' }]);
  });

  it('reads the legacy function_call spelling', () => {
    const turn = fromOpenAI({
      choices: [{ message: { content: '', function_call: { name: 'get_time', arguments: '{}' } } }],
    });
    expect(turn.toolCalls).toEqual([{ name: 'get_time', arguments: '{}' }]);
  });

  it('treats a null content as no text rather than crashing', () => {
    expect(fromOpenAI({ choices: [{ message: { content: null } }] }).text).toBe('');
  });
});

describe('toTurn: anthropic', () => {
  it('ignores thinking blocks entirely', () => {
    const turn = fromAnthropic({
      content: [
        { type: 'thinking', thinking: 'The user wants the config, so I should read it.' },
        { type: 'text', text: 'Reading it now.' },
        { type: 'tool_use', name: 'read_file', input: { path: 'a.ts' } },
      ],
    });
    expect(turn.text).toBe('Reading it now.');
    expect(turn.toolCalls).toHaveLength(1);
  });

  /**
   * Two turns whose *actions* are identical and whose reasoning differs are the
   * same turn. Fingerprinting the reasoning would score a real loop at zero,
   * which is the failure mode extended thinking makes most likely.
   */
  it('fingerprints identically when only the thinking differs', () => {
    const call = (thought: string) => ({
      content: [
        { type: 'thinking', thinking: thought },
        { type: 'tool_use', name: 'run_tests', input: {} },
      ],
    });
    expect(fingerprintTurn(fromAnthropic(call('try again')), NONE))
      .toBe(fingerprintTurn(fromAnthropic(call('this time for sure')), NONE));
  });

  it('counts server tool blocks as calls', () => {
    const turn = fromAnthropic({
      content: [{ type: 'server_tool_use', name: 'web_search', input: { query: 'x' } }],
    });
    expect(turn.toolCalls).toHaveLength(1);
  });
});

describe('toTurn: google', () => {
  it('excludes thought summaries from the text', () => {
    const turn = fromGemini({
      candidates: [
        {
          content: {
            parts: [
              { text: 'I should check the config first.', thought: true },
              { text: 'Reading the config.' },
            ],
          },
        },
      ],
    });
    expect(turn.text).toBe('Reading the config.');
  });

  it('reads only the first candidate', () => {
    const turn = fromGemini({
      candidates: [
        { content: { parts: [{ text: 'first' }] } },
        { content: { parts: [{ text: 'second' }] } },
      ],
    });
    expect(turn.text).toBe('first');
  });

  it('counts executableCode as a call', () => {
    const turn = fromGemini({
      candidates: [{ content: { parts: [{ executableCode: { code: 'print(1)' } }] } }],
    });
    expect(turn.toolCalls).toHaveLength(1);
  });
});

describe('toTurn: ai-sdk', () => {
  it('reads the content-array shape', () => {
    const turn = fromAiSdk({
      content: [
        { type: 'text', text: 'Searching.' },
        { type: 'tool-call', toolName: 'search', input: { q: 'x' } },
      ],
    });
    expect(turn.text).toBe('Searching.');
    expect(turn.toolCalls).toEqual([{ name: 'search', arguments: { q: 'x' } }]);
  });

  it('reads the older args spelling identically', () => {
    const current = fromAiSdk({ text: '', toolCalls: [{ toolName: 't', input: { a: 1 } }] });
    const older = fromAiSdk({ text: '', toolCalls: [{ toolName: 't', args: { a: 1 } }] });
    expect(fingerprintTurn(current, NONE)).toBe(fingerprintTurn(older, NONE));
  });
});

/**
 * A mapper sits between a provider and a guard, which is the worst place in the
 * stack to throw: the caller has a response in hand and is one line from
 * checking it. Anything unrecognisable maps to an empty turn, which the trace
 * drops rather than counts.
 */
describe('toTurn: never throws on a shape it does not recognise', () => {
  const mappers = [fromOpenAI, fromAnthropic, fromGemini, fromAiSdk];
  const junk = [null, undefined, 42, 'a string', [], {}, { choices: null }, { content: 'text' }];

  for (const map of mappers) {
    for (const value of junk) {
      it(`${map.name} survives ${JSON.stringify(value) ?? 'undefined'}`, () => {
        expect(() => map(value)).not.toThrow();
      });
    }
  }
});
