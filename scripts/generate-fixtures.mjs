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

const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};

const MODEL = arg('--model', 'llama-3.1-8b-instant');
const COUNT = Number(arg('--n', '6'));
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
];

mkdirSync(OUT, { recursive: true });

for (let i = 0; i < COUNT; i++) {
  const p = PROVOCATIONS[i % PROVOCATIONS.length];
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: p.prompt }],
        temperature: p.temperature,
        top_p: p.top_p,
        max_tokens: p.max_tokens ?? 800,
      }),
    });

    if (!res.ok) {
      console.error(`  ${p.label}: HTTP ${res.status} -- skipped`);
      continue;
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const record = {
      id: `${p.label}-${i}`,
      note: 'UNREVIEWED. Read this, label it, then move it into bad/ or good/.',
      category: 'unreviewed',
      model: MODEL,
      settings: { temperature: p.temperature, top_p: p.top_p, max_tokens: p.max_tokens ?? 800 },
      finishReason: choice?.finish_reason,
      text: choice?.message?.content ?? '',
    };
    writeFileSync(join(OUT, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n');
    console.log(`  saved ${record.id}  (${record.text.length} chars, finish=${record.finishReason})`);
  } catch (err) {
    console.error(`  ${p.label}: ${err.message}`);
  }
}

console.log(`\nWrote to ${OUT}. Review each one before promoting it into the corpus.`);
