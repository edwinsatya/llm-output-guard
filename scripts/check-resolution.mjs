/**
 * Do the published types resolve in a consumer's TypeScript?
 *
 *   npm run check:resolution
 *
 * ## The bug this exists to catch, which it did not catch
 *
 * Under `moduleResolution: "node"` -- classic node10, still the default
 * whenever `module` is `commonjs` -- every adapter subpath failed to typecheck
 * with TS2307. `node` resolution ignores the `exports` map entirely: it finds
 * the root through the top-level `types` field and finds *nothing* for a
 * subpath. A consumer on an older tsconfig could import `llm-output-guard` and
 * not one adapter.
 *
 * Nothing here would have noticed. This repo typechecks under `bundler`, and so
 * does `check-peers.mjs`, so both halves of the existing type coverage sat on
 * the side of the fence where it works. The fix -- `typesVersions` -- is
 * currently defended by a unit test that derives the list from `exports`, which
 * catches the list drifting but never asks TypeScript whether it actually
 * resolves. This asks.
 *
 * ## Why this is not folded into `check-peers.mjs`
 *
 * That script answers a different question -- does a declared peer range still
 * work -- and answers it per peer per version. Resolution is a property of
 * *our own* package, identical for every peer, so running it inside that matrix
 * would repeat the same answer seven times.
 *
 * It needs no peer installed at all, which is the design paying off: every
 * adapter subpath is structurally typed against its SDK rather than importing
 * from it, so the types resolve and check with nothing beside them.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every entry point, exercised for types rather than merely imported.
 *
 * A bare `import` can be elided by the compiler; using the values keeps the
 * declarations genuinely resolved. The adapter clients are stubs because these
 * subpaths are structurally typed -- that is exactly what is being asserted.
 */
const PROBE_TS = `
import { checkOutput, assertOutput, presets, type Verdict, type ReasonCode } from 'llm-output-guard';
import { withOutputGuard as guardOpenAI, toTurn as fromOpenAI } from 'llm-output-guard/openai';
import { withOutputGuard as guardAnthropic, toTurn as fromAnthropic } from 'llm-output-guard/anthropic';
import { withOutputGuard as guardGoogle, toTurn as fromGoogle } from 'llm-output-guard/google';
import { outputGuard, toTurn as fromAiSdk } from 'llm-output-guard/ai-sdk';
import {
  checkTrace,
  assertTrace,
  createAgentGuard,
  agentLoopScore,
  type AgentTurn,
} from 'llm-output-guard/agent';

const verdict: Verdict = checkOutput('some model output', presets.chat);
const codes: ReasonCode[] = verdict.reasons.map((r) => r.code);
const text: string = assertOutput('some model output', presets.lenient);

const turn: AgentTurn = { text: 'Reading.', toolCalls: [{ name: 'read_file', arguments: {} }] };
const runVerdict: Verdict = checkTrace([turn]);
const guard = createAgentGuard({ ignoreTools: ['get_job_status'] });
const size: number = guard.size;
const score: number = agentLoopScore([turn]);

export const surface = {
  codes,
  text,
  runVerdict,
  size,
  score,
  assertTrace,
  guardOpenAI,
  guardAnthropic,
  guardGoogle,
  outputGuard,
  mappers: [fromOpenAI, fromAnthropic, fromGoogle, fromAiSdk],
};
`;

/**
 * Which compiler, and which resolutions on it.
 *
 * Two TypeScript majors, because the failing mode does not exist in both.
 * **TypeScript 7 removed `moduleResolution: "node"` outright** -- it errors
 * TS5108 rather than resolving badly -- so node10 can only be expressed on 5.x.
 * That bounds who was ever at risk from the `exports`-only gap: consumers on
 * TypeScript 5 and earlier, which is also the majority of tsconfigs in the wild
 * and the population that inherits `node` as the default under
 * `module: commonjs` rather than choosing it.
 *
 * 7.x is still exercised on the three modern modes, because "new consumers get
 * the newest compiler" is the other half of the question and the repo's own
 * typecheck runs on 5.x.
 */
const MATRIX = [
  {
    typescript: 'typescript@5',
    modes: [
      { moduleResolution: 'node', module: 'commonjs' },
      { moduleResolution: 'node16', module: 'node16' },
      { moduleResolution: 'nodenext', module: 'nodenext' },
      { moduleResolution: 'bundler', module: 'esnext' },
    ],
  },
  {
    typescript: 'typescript@7',
    modes: [
      { moduleResolution: 'node16', module: 'node16' },
      { moduleResolution: 'nodenext', module: 'nodenext' },
      { moduleResolution: 'bundler', module: 'esnext' },
    ],
  },
];

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const workspace = mkdtempSync(join(tmpdir(), 'lug-resolution-'));
let failures = 0;

try {
  console.log('building and packing the local package...');
  run('npm', ['run', 'build'], root);
  run('npm', ['pack', '--pack-destination', workspace], root);
  const tarball = join(workspace, readdirSync(workspace).find((f) => f.endsWith('.tgz')));

  for (const { typescript, modes } of MATRIX) {
    const dir = join(workspace, typescript.replace(/[^a-z0-9]/gi, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'resolution-probe', private: true, version: '0.0.0' }, null, 2),
    );
    writeFileSync(join(dir, 'probe.ts'), PROBE_TS);

    run('npm', ['install', '--no-audit', '--no-fund', tarball, typescript], dir);
    const version = JSON.parse(
      run('node', ['-p', "JSON.stringify(require('typescript/package.json').version)"], dir),
    );
    console.log(`### typescript ${version}`);

    for (const { moduleResolution, module } of modes) {
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              target: 'ES2022',
              lib: ['ES2022'],
              module,
              moduleResolution,
              noEmit: true,
              skipLibCheck: true,
              types: [],
            },
            include: ['probe.ts'],
          },
          null,
          2,
        ),
      );

      try {
        run(join(dir, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], dir);
        console.log(`  OK    moduleResolution=${moduleResolution}`);
      } catch (error) {
        failures += 1;
        const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
        console.log(`  FAIL  moduleResolution=${moduleResolution}`);
        for (const line of output.split('\n').slice(0, 6)) console.log(`          ${line}`);
      }
    }
    console.log('');
  }

} finally {
  rmSync(workspace, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(
    `\n${failures} resolution mode(s) cannot see this package's types. A subpath ` +
      'that resolves under bundler and not under node needs a `typesVersions` ' +
      'entry beside its `exports` entry.\n',
  );
  process.exit(1);
}
console.log('every entry point resolves under every supported mode.\n');
