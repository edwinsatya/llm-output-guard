import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTurn, extractTurns, extractScores } from '../src/cli.js';
import { checkTrace } from '../src/agent.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const BIN = join(ROOT, 'src', 'bin.ts');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

/**
 * Spawned rather than imported, for the reason `bin.test.ts` documents: every
 * in-process test of this CLI once passed while the published binary printed
 * nothing at all.
 */
function cli(args: string[], input?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(TSX, [BIN, ...args], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

const tmp = () => mkdtempSync(join(tmpdir(), 'lug-trace-'));

/** Six identical turns, as a native trace. */
const LOOP = JSON.stringify(
  Array.from({ length: 6 }, () => ({
    text: 'Reading the config.',
    toolCalls: [{ name: 'read_file', arguments: { path: 'src/config.ts' } }],
  })),
);

/** Six turns doing real work. */
const PROGRESS = JSON.stringify(
  ['a', 'b', 'c', 'd', 'e', 'f'].map((f) => ({
    text: 'Reading the next file.',
    toolCalls: [{ name: 'read_file', arguments: { path: `src/${f}.ts` } }],
  })),
);

describe('check --trace', () => {
  it('flags a looping run and exits 1', async () => {
    const { code, stdout } = await cli(['check', '--trace'], LOOP + '\n');
    expect(code).toBe(1);
    expect(stdout).toContain('FAIL');
    expect(stdout).toContain('AGENT_LOOP');
  });

  it('passes a run that makes progress and exits 0', async () => {
    const { code, stdout } = await cli(['check', '--trace'], PROGRESS + '\n');
    expect(code).toBe(0);
    expect(stdout).toContain('ok');
  });

  it('reads one run per line', async () => {
    const { code, stdout } = await cli(['check', '--trace'], `${PROGRESS}\n${LOOP}\n`);
    expect(code).toBe(1);
    expect(stdout).toContain('2 run(s), 1 degenerate');
  });

  /**
   * A run logged as one pretty-printed document is at least as common as a run
   * logged as a line, and failing on it would send people away to reshape their
   * input -- which is what this command exists not to require.
   */
  it('reads a file that parses whole as a single run', async () => {
    const dir = tmp();
    const file = join(dir, 'run.json');
    writeFileSync(file, JSON.stringify(JSON.parse(LOOP), null, 2));
    const { code, stdout } = await cli(['check', '--trace', file]);
    expect(code).toBe(1);
    expect(stdout).toContain('AGENT_LOOP');
  });

  it('reads turns from under a "turns" key', async () => {
    const line = JSON.stringify({ run: 'job-14', turns: JSON.parse(LOOP) });
    const { code } = await cli(['check', '--trace'], line + '\n');
    expect(code).toBe(1);
  });

  it('reports unrecognised lines rather than scoring them', async () => {
    const { code, stderr } = await cli(['check', '--trace'], '{"nope":1}\nnot json\n');
    expect(code).toBe(2);
    expect(stderr).toContain('No agent turns found in 2 line(s)');
  });

  it('names the turn count in the label', async () => {
    const { stdout } = await cli(['check', '--trace'], LOOP + '\n');
    expect(stdout).toContain('(6 turns)');
  });
});

/**
 * The knobs, and the one that had to exist.
 *
 * `AGENT_LOOP` cannot tell a job poller from a loop -- the docs say so and
 * offer `ignoreTools` as the answer. Until these flags existed the CLI could
 * not express it, which was worse here than in the library: this is the
 * *calibration* path, so every polling run flagged and the sample a threshold
 * was derived from carried exactly the false positives the option removes.
 */
describe('check --trace: scoring options', () => {
  const POLLING = JSON.stringify(
    Array.from({ length: 5 }, () => ({
      text: 'Checking whether it finished.',
      toolCalls: [{ name: 'get_job_status', arguments: { id: 'job_8812' } }],
    })),
  );

  it('flags a polling run by default, because by shape it is a loop', async () => {
    const { code, stdout } = await cli(['check', '--trace'], POLLING + '\n');
    expect(code).toBe(1);
    expect(stdout).toContain('AGENT_LOOP');
  });

  it('passes the same run once the poller is named', async () => {
    const { code } = await cli(
      ['check', '--trace', '--ignore-tools', 'get_job_status'], POLLING + '\n');
    expect(code).toBe(0);
  });

  it('takes several tool names', async () => {
    const { code } = await cli(
      ['check', '--trace', '--ignore-tools', 'sleep, get_job_status ,clock'], POLLING + '\n');
    expect(code).toBe(0);
  });

  it('honours a raised threshold', async () => {
    // The run scores 1.000, so only a threshold at or above it can pass it.
    const flagged = await cli(['check', '--trace', '--max-agent-loop', '0.9'], POLLING + '\n');
    expect(flagged.code).toBe(1);
    const passed = await cli(['check', '--trace', '--max-agent-loop', '1'], POLLING + '\n');
    expect(passed.code).toBe(0);
  });

  it('honours a raised floor', async () => {
    const { code } = await cli(['check', '--trace', '--min-turns', '6'], POLLING + '\n');
    expect(code, 'five turns is below a floor of six, so it abstains').toBe(0);
  });

  /* A preset is a per-response contract. Ignoring it silently would leave the
     caller believing they had tuned something. */
  it('refuses --preset with --trace and names the right option', async () => {
    const { code, stderr } = await cli(['check', '--trace', '--preset', 'chat'], POLLING + '\n');
    expect(code).toBe(2);
    expect(stderr).toContain('--max-agent-loop');
  });

  it('refuses a run-scoring flag without --trace', async () => {
    const { code, stderr } = await cli(['check', '--ignore-tools', 'x'], POLLING + '\n');
    expect(code).toBe(2);
    expect(stderr).toContain('only applies with --trace');
  });

  it('refuses a non-numeric knob rather than defaulting silently', async () => {
    const { code, stderr } = await cli(['check', '--trace', '--window', 'abc'], POLLING + '\n');
    expect(code).toBe(2);
    expect(stderr).toContain('expects a number');
  });

  /* The flag values must not be mistaken for input files. */
  it('does not read a flag value as a filename', async () => {
    const { code } = await cli(
      ['check', '--trace', '--ignore-tools', 'get_job_status', '--window', '12'], POLLING + '\n');
    expect(code).toBe(0);
  });
});

/**
 * The half that makes this worth building: the scores have to reach
 * `calibrate`, which is what turns "0.4 is our number" into "0.4 is your
 * number".
 */
describe('check --trace | calibrate', () => {
  it('emits samples calibrate can read', async () => {
    const { stdout } = await cli(['check', '--trace', '--json'], `${PROGRESS}\n${LOOP}\n`);
    const lines = stdout.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    for (const line of lines) {
      const sample = extractScores(JSON.parse(line));
      expect(sample, `calibrate could not read: ${line}`).not.toBeNull();
      expect(typeof sample!.AGENT_LOOP).toBe('number');
    }
  });

  it('composes end to end into a threshold suggestion', async () => {
    const runs = [
      ...Array.from({ length: 30 }, () => PROGRESS),
      ...Array.from({ length: 3 }, () => LOOP),
    ].join('\n');

    const scored = await cli(['check', '--trace', '--json'], runs + '\n');
    const { code, stdout } = await cli(['calibrate'], scored.stdout);

    expect(code).toBe(0);
    expect(stdout).toContain('AGENT_LOOP');
    // The knob the report must point at, not a per-response one.
    expect(stdout).toContain('maxAgentLoop');
  });
});

describe('extractTurn: reads what people actually log', () => {
  const call = { name: 'read_file', arguments: { path: 'a.ts' } };

  /**
   * The precedence bug this asserts is silent and total: `AgentTurn` and the AI
   * SDK's flat result both spell the list `toolCalls`, and the AI SDK mapper
   * reads `input`/`args` where a native turn holds `arguments`. Mapping a
   * native turn through it drops every argument, so a run fingerprints by tool
   * name alone -- and a batch of twenty reads of twenty files reads as twenty
   * identical turns.
   */
  it('keeps a native turn native, arguments and all', () => {
    const turn = extractTurn({ text: 'Reading.', toolCalls: [call] });
    expect(turn).toEqual({ text: 'Reading.', toolCalls: [call] });
  });

  it('reads an openai chat envelope', () => {
    const turn = extractTurn({
      choices: [{ message: { content: 'Reading.', tool_calls: [
        { function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] } }],
    });
    expect(turn?.toolCalls?.[0]?.name).toBe('read_file');
  });

  it('reads an openai responses envelope', () => {
    const turn = extractTurn({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi.' }] }],
    });
    expect(turn?.text).toBe('Hi.');
  });

  it('reads an anthropic envelope', () => {
    const turn = extractTurn({
      content: [{ type: 'text', text: 'Reading.' },
                { type: 'tool_use', name: 'read_file', input: { path: 'a.ts' } }],
    });
    expect(turn?.toolCalls?.[0]?.name).toBe('read_file');
  });

  it('reads a gemini envelope', () => {
    const turn = extractTurn({
      candidates: [{ content: { parts: [{ text: 'Reading.' }] } }],
    });
    expect(turn?.text).toBe('Reading.');
  });

  /** `content` is the field two providers share; only a tool part separates them. */
  it('tells an ai-sdk content array from an anthropic one', () => {
    const turn = extractTurn({
      content: [{ type: 'text', text: 'Reading.' },
                { type: 'tool-call', toolName: 'read_file', input: { path: 'a.ts' } }],
    });
    expect(turn?.toolCalls?.[0]?.name).toBe('read_file');
  });

  it('reads a bare string as a prose turn', () => {
    expect(extractTurn('just talking')).toEqual({ text: 'just talking' });
  });

  it('returns null for something with no turn in it', () => {
    expect(extractTurn({ unrelated: true })).toBeNull();
    expect(extractTurn(null)).toBeNull();
    expect(extractTurn(42)).toBeNull();
  });
});

/**
 * A chat history, which is what people actually have.
 *
 * An agent loop keeps a `messages` array and logs that far more often than it
 * logs raw completion envelopes. Two failures met here, and the second is the
 * serious one:
 *
 *  - every message in an ordinary history was dropped, the model's included,
 *    so the calibration path could not read the commonest input there is;
 *  - a user message spelled `{ role: 'user', content: [{ type: 'text' }] }` is
 *    shape-identical to an Anthropic response, so it *did* map -- meaning a
 *    mixed history built a trace from the wrong speaker while the model's own
 *    turns stayed invisible. A wrong verdict from real data is worse than none.
 */
describe('extractTurn: a chat history', () => {
  const assistant = (text: string, tool?: string) => ({
    role: 'assistant',
    content: text,
    ...(tool ? { tool_calls: [{ function: { name: tool, arguments: '{}' } }] } : {}),
  });

  it('reads a bare assistant message, calls and all', () => {
    const turn = extractTurn(assistant('Running it.', 'run_tests'));
    expect(turn?.text).toBe('Running it.');
    expect(turn?.toolCalls?.[0]?.name).toBe('run_tests');
  });

  it('reads an assistant message that is prose only', () => {
    expect(extractTurn(assistant('All four tests pass now.'))?.text).toBe(
      'All four tests pass now.',
    );
  });

  it('reads the camelCase call list on a bare message too', () => {
    const turn = extractTurn({
      role: 'assistant',
      content: 'Looking.',
      toolCalls: [{ function: { name: 'search', arguments: '{}' } }],
    });
    expect(turn?.toolCalls?.[0]?.name).toBe('search');
  });

  for (const role of ['system', 'user', 'tool', 'developer', 'function']) {
    it(`drops a ${role} message`, () => {
      expect(extractTurn({ role, content: 'not the model speaking' })).toBeNull();
    });
  }

  /* The one that produced a wrong answer rather than no answer. */
  it('drops a user message whose content is an array', () => {
    expect(
      extractTurn({ role: 'user', content: [{ type: 'text', text: 'again please' }] }),
      'shape-identical to an Anthropic response — only the role separates them',
    ).toBeNull();
  });

  it('scores a whole history by the model turns alone', () => {
    const history = [
      { role: 'system', content: 'You are a helpful agent.' },
      { role: 'user', content: 'Fix the failing test.' },
      { role: 'user', content: [{ type: 'text', text: 'again please' }] },
      assistant('Reading the test.', 'read_file'),
      { role: 'tool', tool_call_id: 'c1', content: 'expect(x).toBe(1)' },
      ...Array.from({ length: 4 }, () => [
        assistant('Running it.', 'run_tests'),
        { role: 'tool', tool_call_id: 'c', content: 'FAIL' },
      ]).flat(),
    ];

    const turns = extractTurns(history);
    expect(turns, 'five assistant messages, nothing else').toHaveLength(5);

    const verdict = checkTrace(turns!);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons[0]!.message).toContain('run_tests');
  });

  /* An Anthropic response also carries role: 'assistant' -- it must still read
     as a response rather than being caught by the bare-message branch. */
  it('still reads an anthropic response, which is also role assistant', () => {
    const turn = extractTurn({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', name: 'read_file', input: { path: 'a.ts' } },
      ],
      stop_reason: 'tool_use',
    });
    expect(turn?.text).toBe('Reading.');
    expect(turn?.toolCalls?.[0]?.name).toBe('read_file');
  });
});

/**
 * Where a logged run keeps its turns.
 *
 * `messages` is OpenAI's own request field and what essentially every agent
 * framework calls its history -- the likeliest key there is, and the one this
 * could not read. The intent stated at the top of `cli.ts` is that you should
 * not have to reshape your logs to calibrate, because a step you have to
 * prepare for is one you do not run.
 */
describe('extractTurns: the containers people log', () => {
  const assistant = (text: string, tool: string) => ({
    role: 'assistant',
    content: text,
    tool_calls: [{ function: { name: tool, arguments: '{}' } }],
  });
  const run = [
    assistant('Reading.', 'read_file'),
    assistant('Running it.', 'run_tests'),
    assistant('Running it.', 'run_tests'),
    assistant('Running it.', 'run_tests'),
    assistant('Running it.', 'run_tests'),
  ];

  for (const key of ['turns', 'messages', 'history', 'conversation', 'steps']) {
    it(`reads a run under "${key}"`, () => {
      expect(extractTurns({ [key]: run })).toHaveLength(5);
    });
  }

  it('reads a whole request body, which carries other fields too', () => {
    expect(extractTurns({ model: 'gpt-4', temperature: 0.2, messages: run })).toHaveLength(5);
  });

  it('reads a run logged one object down inside a wider record', () => {
    expect(extractTurns({ run: 'job-14', at: 12345, log: { messages: run } })).toHaveLength(5);
  });

  /**
   * The reason this looks for named keys instead of any array.
   *
   * Scanning every array-valued property was written first and thrown away:
   * `extractTurn` reads a bare string as a prose turn, so a record carrying
   * tags became a two-turn run, and a repeated tag list would have scored
   * AGENT_LOOP. Same wrong-speaker failure as reading a user message, one
   * level up, and caused by the liberality meant to help.
   */
  it('does not mistake an unrelated array for a run', () => {
    expect(extractTurns({ tags: ['deploy', 'urgent'], ids: [1, 2, 3] })).toBeNull();
    expect(extractTurns({ labels: ['a', 'a', 'a', 'a', 'a'] })).toBeNull();
  });

  /* A bare array of strings is still a prose run -- there the caller chose it. */
  it('still reads an explicit array of prose turns', () => {
    expect(extractTurns(['talking', 'talking', 'talking', 'talking'])).toHaveLength(4);
  });
});

describe('extractTurns', () => {
  it('reads a bare array and a turns key alike', () => {
    const turns = [{ text: 'a' }, { text: 'b' }];
    expect(extractTurns(turns)).toHaveLength(2);
    expect(extractTurns({ turns })).toHaveLength(2);
  });

  it('drops unreadable turns rather than the whole run', () => {
    expect(extractTurns([{ text: 'a' }, { junk: 1 }, { text: 'b' }])).toHaveLength(2);
  });

  it('returns null when nothing in the run is readable', () => {
    expect(extractTurns([{ junk: 1 }])).toBeNull();
    expect(extractTurns({ nope: true })).toBeNull();
  });
});
