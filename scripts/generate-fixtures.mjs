/**
 * Provokes real degenerate output from a live provider and saves it as fixtures.
 *
 * The hand-written corpus in test/fixtures is a starting point, not the goal.
 * Real failures are stranger than anything you would write on purpose, so keep
 * feeding this corpus from production logs and from runs like this one.
 *
 *   GROQ_API_KEY=... node scripts/generate-fixtures.mjs --model llama-3.1-8b-instant --n 8
 *
 * Output lands in test/fixtures/raw/ UNREVIEWED. Read each one, label it, and
 * move it into bad/ or good/ by hand. Never auto-promote: a fixture you have
 * not read is a threshold you cannot justify.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';

/*
 * Scored with the package itself, so a run tells you which provocations
 * actually worked instead of leaving you to read six files to find out.
 * Built output rather than src, because this is a plain .mjs script.
 */
let checkOutput, presets;
try {
  ({ checkOutput, presets } = await import('../dist/index.js'));
} catch {
  console.error('Run `npm run build` first — this scores each result with the package.');
  exit(1);
}

const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};

const MODEL = arg('--model', 'llama-3.1-8b-instant');
const COUNT = Number(arg('--n', '6'));
const MAX_TOKENS = Number(arg('--max-tokens', '800'));
const OUT = join(new URL('..', import.meta.url).pathname, 'test/fixtures/raw');

const KEY = env.GROQ_API_KEY;
if (!KEY) {
  console.error('Set GROQ_API_KEY. Any OpenAI-compatible endpoint works -- edit ENDPOINT below.');
  exit(1);
}
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/** Prompts and settings chosen to push a model off the rails on purpose. */
const PROVOCATIONS = [
  { label: 'high-temp-openended', temperature: 1.9, top_p: 1.0,
    prompt: 'Continue this sentence forever without ever concluding: The candidate' },
  { label: 'top-p-collapse', temperature: 0.1, top_p: 0.01,
    prompt: 'List interview questions about React state management.' },
  { label: 'token-starved', temperature: 0.7, max_tokens: 24,
    prompt: 'Write a detailed four paragraph review of this engineer\u2019s backend architecture decisions.' },
  { label: 'json-under-pressure', temperature: 1.6,
    prompt: 'Reply with ONLY raw JSON: {"score":number,"notes":string,"followUp":string[]}. No prose.' },
  { label: 'contradictory-instruction', temperature: 1.4,
    prompt: 'Answer in Indonesian. Also answer only in English. Also answer only in JSON. Explain hydration.' },
  { label: 'repetition-bait', temperature: 0.05, top_p: 0.05,
    prompt: 'Say "the candidate has experience" and then keep elaborating on that exact phrase.' },

  /*
   * The two below aim at a tail loop specifically: a reply that begins well and
   * only comes apart later. It is the most illustrative failure of the set,
   * because it is the one whole-output repetition scoring misses -- a healthy
   * opening dilutes the score enough to pass.
   */
  { label: 'tail-loop-after-good-start', temperature: 0.02, top_p: 0.02, max_tokens: 2000,
    prompt:
      'Answer in two parts. First, explain in one clear paragraph why cache invalidation is hard. ' +
      'Then, list every possible edge case one per line, and do not stop until you have listed them all.' },

  { label: 'starved-of-new-ideas', temperature: 0.01, top_p: 0.01, max_tokens: 1500,
    prompt:
      'Review this engineer: they have used TypeScript. Write 800 words. ' +
      'Do not invent any detail I have not given you.' },
];

mkdirSync(OUT, { recursive: true });

console.log(`\n${MODEL} — ${COUNT} runs\n`);
const results = [];

for (let i = 0; i < COUNT; i++) {
  const p = PROVOCATIONS[i % PROVOCATIONS.length];
  const maxTokens = p.max_tokens ?? MAX_TOKENS;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: p.prompt }],
        temperature: p.temperature,
        top_p: p.top_p,
        max_tokens: maxTokens,
      }),
    });

    if (!res.ok) {
      console.error(`  ${p.label.padEnd(28)} HTTP ${res.status} -- skipped`);
      continue;
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? '';
    const finishReason = choice?.finish_reason;

    const verdict = checkOutput(text, { ...presets.chat, finishReason });
    const record = {
      id: `${p.label}-${i}`,
      note: 'UNREVIEWED. Read this, label it, then move it into bad/ or good/.',
      category: 'unreviewed',
      model: MODEL,
      settings: { temperature: p.temperature, top_p: p.top_p, max_tokens: maxTokens },
      finishReason,
      verdict: { ok: verdict.ok, scores: verdict.scores },
      text,
    };
    writeFileSync(join(OUT, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n');

    results.push({ id: record.id, verdict, chars: text.length, finishReason });
    const codes = verdict.reasons.map((r) => `${r.code}=${r.score.toFixed(2)}`).join(' ');
    console.log(
      `  ${verdict.ok ? 'clean ' : 'LOOPED'} ${record.id.padEnd(30)} ` +
        `${String(text.length).padStart(5)} chars  finish=${finishReason ?? '?'}  ${codes}`,
    );
  } catch (err) {
    console.error(`  ${p.label}: ${err.message}`);
  }
}

/*
 * Ranked by how badly they came apart, because the point of a run is to find
 * the one worth reading -- not to read all of them.
 */
const degenerate = results
  .filter((r) => !r.verdict.ok)
  .sort((a, b) => {
    const worst = (r) => Math.max(...r.verdict.reasons.map((x) => x.score));
    return worst(b) - worst(a);
  });

if (results.length === 0) {
  // Distinct from "nothing degenerated": no run produced a reply at all, so
  // advice about sampling settings would point at the wrong problem.
  console.error('\nNo replies came back at all — check the key, the model id, and the endpoint.');
  exit(1);
}

console.log(`\n${degenerate.length} of ${results.length} came apart.`);
if (degenerate.length > 0) {
  console.log(`Start with:  test/fixtures/raw/${degenerate[0].id}.json`);
  console.log('\nTo see the shape of it:');
  console.log(`  node -e "console.log(require('./test/fixtures/raw/${degenerate[0].id}.json').text.slice(0,600))"`);
} else {
  console.log('Nothing degenerated. Try --max-tokens 2000, or a smaller model.');
}
console.log(`\nAll output is UNREVIEWED in ${OUT}.`);
console.log('Read each one before promoting it — a fixture you have not read is a threshold you cannot defend.\n');
