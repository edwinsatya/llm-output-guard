import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTurn, extractTurns, extractScores } from '../src/cli.js';

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
