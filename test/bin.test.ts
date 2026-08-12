import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const BIN = join(ROOT, 'src', 'bin.ts');
// The local binary, not `npx` -- resolution alone costs seconds per spawn.
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

/**
 * These spawn the entry point as its own process rather than importing it.
 *
 * Every in-process test of the CLI passed while the published binary printed
 * nothing at all: the entry point decided whether to run by inspecting
 * `process.argv[1]`, and through npm's bin symlink that string is
 * `node_modules/.bin/llm-output-guard`, which the check did not recognise.
 * Importing `main` and calling it can never catch that -- only running the
 * thing the way a user runs it can.
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

    // Closing stdin is what lets the no-file path finish; leaving it open is
    // how the first version of this helper hung until the test timed out.
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

describe('the executable', () => {
  it('actually produces output when run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-cal-'));
    const file = join(dir, 'scores.jsonl');
    const lines = Array.from({ length: 60 }, () =>
      JSON.stringify({ scores: { REPETITION: 0.01, TAIL_LOOP: 0 } }),
    );
    lines.push(JSON.stringify({ scores: { REPETITION: 0.92, TAIL_LOOP: 0.95 } }));
    writeFileSync(file, `${lines.join('\n')}\n`);

    const { code, stdout } = await cli(['calibrate', file]);
    expect(code).toBe(0);
    expect(stdout).toContain('61 verdicts');
    expect(stdout).toContain('REPETITION');
    expect(stdout).toContain('suggest maxRepetition');
  }, 30_000);

  it('reads stdin when given no file', async () => {
    const input = `${Array.from({ length: 40 }, () =>
      JSON.stringify({ REPETITION: 0.02 }),
    ).join('\n')}\n`;
    const { code, stdout } = await cli(['calibrate'], input);
    expect(code).toBe(0);
    expect(stdout).toContain('40 verdicts');
  }, 30_000);

  it('prints usage and exits non-zero with no arguments', async () => {
    const { code, stdout } = await cli([]);
    expect(code).toBe(1);
    expect(stdout).toContain('calibrate');
  }, 30_000);

  it('exits non-zero on an unreadable file', async () => {
    const { code, stderr } = await cli(['calibrate', 'nope.jsonl']);
    expect(code).toBe(1);
    expect(stderr).toContain('Could not read');
  }, 30_000);
});
