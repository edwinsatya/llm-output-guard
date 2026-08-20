/**
 * What `checkOutput` costs, measured rather than asserted.
 *
 * The README calls this package "safe on a hot path" and "synchronous", which
 * are claims about latency made without a number anywhere near them. The only
 * figures that existed lived in a comment in `stream.ts`, cited to justify
 * deferring LOW_ENTROPY off the mid-stream path. A claim that decides whether
 * someone puts this in front of every LLM response deserves to be checkable.
 *
 *   npm run bench            # human-readable table
 *   npm run bench -- --json  # machine-readable, for tracking over time
 *
 * ## Read this before quoting a number from it
 *
 * These are wall-clock timings on whatever machine ran them, on an idle-ish
 * system, in one Node process with a warm JIT. They are useful for *ratios*
 * between detectors and for order of magnitude. They are not a promise about
 * your hardware, and the absolute values will differ on CI, on a shared
 * runner, and under a cold JIT.
 *
 * The p99 at the smallest size is routinely worse than the p50 at the largest
 * one. That is not noise in the measurement, it is the JIT still warming up on
 * the earliest samples, which is why `WARMUP` exists and why it is reported.
 */
import { checkOutput, presets, repetitionScore, tailLoopScore, compressibilityScore,
         truncationScore, jsonScore, scriptMismatchScore, languageMismatchScore } from '../dist/index.js';

const asJson = process.argv.includes('--json');

const RUNS = 500;
const WARMUP = 200;

/** Prose that is genuinely varied, so no detector gets an unrealistically easy input. */
const SENTENCES = [
  'The connection pool is created once per worker process and is never shared across them. ',
  'That single fact drives most of the confusion teams have with the retry budget. ',
  'Health checks belong at the orchestrator level rather than inside the application itself. ',
  'Multiply your per-worker pool size by the worker count before comparing it to the limit. ',
  'At-most-once delivery is the tradeoff you accept when you reach for a message bus. ',
];
const prose = (n) => {
  let out = '';
  for (let i = 0; out.length < n; i++) out += SENTENCES[i % SENTENCES.length];
  return out.slice(0, n);
};

const json = (n) => {
  const rows = [];
  for (let i = 0; rows.join(',').length < n; i++) {
    rows.push(`{"id":${i},"service":"svc-${i}","status":"healthy","latencyMs":${12 + (i % 40)}}`);
  }
  return `[${rows.join(',')}]`;
};

/** p50 and p99 of `fn`, in milliseconds. */
function time(fn) {
  for (let i = 0; i < WARMUP; i++) fn();
  const samples = new Float64Array(RUNS);
  for (let i = 0; i < RUNS; i++) {
    const start = process.hrtime.bigint();
    fn();
    samples[i] = Number(process.hrtime.bigint() - start) / 1e6;
  }
  const sorted = Array.from(samples).sort((a, b) => a - b);
  return { p50: sorted[Math.floor(RUNS * 0.5)], p99: sorted[Math.floor(RUNS * 0.99)] };
}

const SIZES = [500, 2_000, 8_000, 32_000];
const results = { meta: { node: process.version, platform: process.platform,
                          arch: process.arch, runs: RUNS, warmup: WARMUP },
                  whole: [], detectors: [], presets: [] };

for (const size of SIZES) {
  const text = prose(size);
  results.whole.push({ bytes: size, ...time(() => checkOutput(text, presets.chat)) });
}

/*
 * Per detector at one size, because the interesting number is not how fast any
 * of them are -- they are all fast -- but how far apart they are. LOW_ENTROPY
 * is the outlier that shapes the streaming design, and this is where that shows.
 */
const SAMPLE = prose(2_000);
const SAMPLE_JSON = json(2_000);
for (const [name, fn] of [
  ['REPETITION', () => repetitionScore(SAMPLE)],
  ['TAIL_LOOP', () => tailLoopScore(SAMPLE)],
  ['LOW_ENTROPY', () => compressibilityScore(SAMPLE)],
  ['TRUNCATED', () => truncationScore(SAMPLE)],
  ['INVALID_JSON', () => jsonScore(SAMPLE_JSON, {})],
  ['SCRIPT_MISMATCH', () => scriptMismatchScore(SAMPLE, 'latin')],
  ['LANG_MISMATCH', () => languageMismatchScore(SAMPLE, 'en')],
]) {
  results.detectors.push({ name, ...time(fn) });
}

for (const [name, preset] of Object.entries(presets)) {
  const text = preset.expectJson ? SAMPLE_JSON : SAMPLE;
  results.presets.push({ name, ...time(() => checkOutput(text, preset)) });
}

if (asJson) {
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
} else {
  const ms = (n) => `${n.toFixed(3)}ms`.padStart(9);
  const line = (label, r) => `  ${String(label).padEnd(17)}${ms(r.p50)}${ms(r.p99)}`;
  const { node, platform, arch } = results.meta;
  process.stdout.write(`\nllm-output-guard bench  (${node}, ${platform}/${arch}, ` +
    `${RUNS} runs after ${WARMUP} warmup)\n`);
  process.stdout.write(`\n  checkOutput(presets.chat)${' '.repeat(0)}\n`);
  process.stdout.write(`  ${'input'.padEnd(17)}${'p50'.padStart(9)}${'p99'.padStart(9)}\n`);
  for (const r of results.whole) {
    process.stdout.write(line(r.bytes >= 1000 ? `${r.bytes / 1000} KB` : `${r.bytes} B`, r) + '\n');
  }
  process.stdout.write(`\n  detectors, 2 KB input\n`);
  for (const r of results.detectors) process.stdout.write(line(r.name, r) + '\n');
  process.stdout.write(`\n  presets, 2 KB input\n`);
  for (const r of results.presets) process.stdout.write(line(r.name, r) + '\n');
  process.stdout.write('\n');
}
