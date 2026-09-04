/**
 * The size claim, measured rather than remembered.
 *
 *   npm run size
 *
 * The README says a number on its front page, and a number in prose is the
 * cheapest thing in a repo to go stale: it was written once, it is true once,
 * and nothing fails when it stops being. This one had drifted 24% before
 * anything noticed -- and the bundlejs badge two lines above it was showing the
 * real figure the whole time.
 *
 * So it is a build step with a budget, exactly as `no-runtime-deps` is in CI.
 * Zero dependencies is a promise this package keeps by asserting it; so is this.
 *
 * **Measured the way a consumer experiences it**, which is not the size of
 * `dist/index.js`. That file is code-split -- it re-exports from shared chunks,
 * so on its own it reads about a third of the truth. Each entry is bundled and
 * minified here first, which is what any bundler does before the byte count
 * means anything.
 */
import * as esbuild from 'esbuild';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/*
 * Budgets, in min+gzip bytes. Set roughly 15% above what each entry measures
 * today: loose enough that an ordinary change does not trip it, tight enough
 * that a dependency creeping in or a detector doubling does.
 *
 * Raising one is a deliberate act with a diff, which is the point. If a number
 * here has to move, the README sentence moves with it.
 */
const BUDGET = {
  'index': 7200,
  'openai': 7800,
  'anthropic': 7500,
  'google': 7800,
  'ai-sdk': 7000,
  'agent': 2800,
};

const results = [];
let over = 0;

for (const [entry, budget] of Object.entries(BUDGET)) {
  // In memory, and through esbuild's API rather than its binary -- the same
  // way `build-playground.mjs` reaches it.
  const built = await esbuild.build({
    entryPoints: [`${root}dist/${entry}.js`],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'error',
  });
  const bytes = gzipSync(built.outputFiles[0].contents, { level: 9 }).length;
  if (bytes > budget) over += 1;
  results.push({ entry, bytes, budget });
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
process.stdout.write('\nllm-output-guard size  (bundled, minified, gzip -9)\n\n');
process.stdout.write(`  ${'entry'.padEnd(12)}${'min+gzip'.padStart(10)}${'budget'.padStart(10)}\n`);
for (const { entry, bytes, budget } of results) {
  const flag = bytes > budget ? '  OVER' : '';
  const name = entry === 'index' ? '.' : `./${entry}`;
  process.stdout.write(`  ${name.padEnd(12)}${kb(bytes).padStart(10)}${kb(budget).padStart(10)}${flag}\n`);
}
process.stdout.write('\n');

if (over > 0) {
  process.stderr.write(
    `${over} entr${over === 1 ? 'y is' : 'ies are'} over budget. Either the growth is ` +
    'wanted -- raise the budget in scripts/size.mjs and the figure in the README ' +
    'together -- or it is not.\n',
  );
  process.exit(1);
}
