import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractText } from '../src/cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const BIN = join(ROOT, 'src', 'bin.ts');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

/**
 * `check` is the half of the loop that was missing: `calibrate` asks for a week
 * of logged scores, and nothing in the package produced them from responses you
 * already had.
 *
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

const HEALTHY =
  'The connection pool is created once per worker process and is never shared across ' +
  'them. That single fact drives most of the confusion teams have with the retry budget, ' +
  'because the budget is expressed per pool rather than per service.';

const LOOP = 'I will check that for you. '.repeat(40);

let dir: string;
let healthyFile: string;
let loopFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'log-check-'));
  healthyFile = join(dir, 'healthy.txt');
  loopFile = join(dir, 'loop.txt');
  writeFileSync(healthyFile, HEALTHY);
  writeFileSync(loopFile, LOOP);
});

describe('check: the exit code is the assertion', () => {
  it('exits 0 on a healthy response', async () => {
    const { code, stdout } = await cli(['check', healthyFile]);
    expect(code).toBe(0);
    expect(stdout).toContain('ok');
    expect(stdout).toContain('0 degenerate');
  }, 30_000);

  it('exits 1 on a degenerate one, and says which detectors fired', async () => {
    const { code, stdout } = await cli(['check', loopFile]);
    expect(code).toBe(1);
    expect(stdout).toContain('FAIL');
    expect(stdout).toMatch(/REPETITION=\d\.\d{3}>/);
  }, 30_000);

  it('exits 1 if any one of several files is degenerate', async () => {
    const { code, stdout } = await cli(['check', healthyFile, loopFile]);
    expect(code).toBe(1);
    expect(stdout).toContain('2 checked');
    expect(stdout).toContain('1 degenerate');
  }, 30_000);

  /** 2 rather than 1, so CI can tell "it found something" from "it broke". */
  it('exits 2 when the input cannot be read', async () => {
    const { code, stderr } = await cli(['check', join(dir, 'nope.txt')]);
    expect(code).toBe(2);
    expect(stderr).toContain('Could not read');
  }, 30_000);

  it('exits 2 on an unknown preset, and names the real ones', async () => {
    const { code, stderr } = await cli(['check', healthyFile, '--preset', 'nonsense']);
    expect(code).toBe(2);
    expect(stderr).toContain('chat');
    expect(stderr).toContain('strictJson');
  }, 30_000);

  it('--quiet prints nothing and still answers', async () => {
    const { code, stdout } = await cli(['check', loopFile, '--quiet']);
    expect(code).toBe(1);
    expect(stdout.trim()).toBe('');
  }, 30_000);
});

describe('check: input shapes', () => {
  it('reads stdin when given no file', async () => {
    const { code, stdout } = await cli(['check'], HEALTHY);
    expect(code).toBe(0);
    expect(stdout).toContain('stdin');
  }, 30_000);

  it('reads a preset by name', async () => {
    /*
     * Eight characters of valid JSON: fine under strictJson, and below chat's
     * 12-character minLength. Not `{}` -- that is one of the shapes `EMPTY`
     * exists to catch, so it is degenerate under every preset.
     */
    const { code: jsonOk } = await cli(['check', '--preset', 'strictJson'], '{"a":1}');
    const { code: chatFails } = await cli(['check', '--preset', 'chat'], '{"a":1}');
    expect(jsonOk).toBe(0);
    expect(chatFails).toBe(1);
  }, 30_000);

  it('reads JSONL and labels each line', async () => {
    const input = [
      JSON.stringify({ text: HEALTHY }),
      JSON.stringify({ text: LOOP }),
    ].join('\n');
    const { code, stdout } = await cli(['check', '--jsonl'], input);
    expect(code).toBe(1);
    expect(stdout).toContain('stdin:1');
    expect(stdout).toContain('stdin:2');
    expect(stdout).toContain('2 checked');
  }, 30_000);

  it('counts lines it cannot read rather than scoring them as healthy', async () => {
    const input = [
      JSON.stringify({ text: HEALTHY }),
      JSON.stringify({ nothing: 'here' }),
      'not json at all',
    ].join('\n');
    const { code, stdout } = await cli(['check', '--jsonl'], input);
    expect(code).toBe(0);
    expect(stdout).toContain('1 checked');
    expect(stdout).toContain('2 line(s) unrecognised');
  }, 30_000);

  it('exits 2 when no line carried a response', async () => {
    const { code, stderr } = await cli(['check', '--jsonl'], '{"unrelated":1}\n{"also":2}\n');
    expect(code).toBe(2);
    expect(stderr).toContain('No response text found');
  }, 30_000);
});

/**
 * The reason the command exists. `calibrate` reads what `check --json` writes,
 * with no reshaping between them.
 */
describe('check and calibrate are halves of one loop', () => {
  it('--json output feeds calibrate directly', async () => {
    const lines = Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({ text: i % 20 === 0 ? LOOP : `${HEALTHY} Variation ${i}.` }),
    ).join('\n');

    const checked = await cli(['check', '--jsonl', '--json'], lines);
    expect(checked.code).toBe(1);

    const verdicts = checked.stdout.trim().split('\n');
    expect(verdicts).toHaveLength(60);
    // Every line is a whole Verdict, with the label alongside it.
    const first = JSON.parse(verdicts[0]);
    expect(first).toHaveProperty('label');
    expect(first).toHaveProperty('ok');
    expect(first).toHaveProperty('scores');

    const calibrated = await cli(['calibrate', '--fpr', '0.05'], checked.stdout);
    expect(calibrated.code).toBe(0);
    expect(calibrated.stdout).toContain('60 verdicts');
    expect(calibrated.stdout).toContain('REPETITION');
  }, 45_000);
});

/**
 * Deliberately liberal, for the reason `extractScores` is: a step you have to
 * prepare your logs for is a step you do not run.
 */
describe('extractText digs a response out of whatever you logged', () => {
  it('reads a bare string', () => {
    expect(extractText('the response')).toBe('the response');
  });

  it('reads the obvious field names', () => {
    for (const field of ['text', 'output', 'content', 'response', 'completion', 'answer']) {
      expect(extractText({ [field]: 'the response' }), field).toBe('the response');
    }
  });

  it('reads a raw OpenAI envelope', () => {
    expect(extractText({
      choices: [{ message: { role: 'assistant', content: 'the response' } }],
    })).toBe('the response');
  });

  it('reads a raw Anthropic envelope', () => {
    expect(extractText({
      content: [{ type: 'text', text: 'the response' }],
      stop_reason: 'end_turn',
    })).toBe('the response');
  });

  it('reads one buried in a wider log record', () => {
    expect(extractText({
      level: 'info', msg: 'reply', payload: { text: 'the response' },
    })).toBe('the response');
  });

  /**
   * A tool-call turn carries no assistant text. Returning '' would put an
   * `EMPTY: 1` spike into a calibration run describing the agent's tool use
   * rather than any degeneration, which is the bug `tool-calls.ts` exists for.
   */
  it('returns null rather than an empty string for a tool-call turn', () => {
    expect(extractText({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] } }],
    })).toBeNull();
  });

  it('returns null when nothing looks like a response', () => {
    expect(extractText({ unrelated: 1 })).toBeNull();
    expect(extractText(null)).toBeNull();
    expect(extractText(42)).toBeNull();
  });
});
