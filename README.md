# llm-output-guard

Detect LLM responses that failed **while returning `200 OK`**.

Zero runtime dependencies. Deterministic. Composes with whatever retry or fallback layer you already have.

```bash
npm i llm-output-guard
```

---

## Why this exists

A model in my interview-question pipeline started returning garbage — the same clause repeated until it hit the token ceiling. Every layer reported success:

- the provider returned `200`
- the SDK parsed the envelope without complaint
- the response had non-zero length

So the retry policy saw nothing worth acting on. The bad response was cached, served, and counted as a success. What surfaced instead was a *latency* problem, because downstream code kept retrying around a response that was technically fine.

Retry and fallback libraries key off **transport** signals: `429`, `5xx`, timeouts. None of them look at whether the content means anything. That is the gap this package fills.

## What it is not

This is **not** another fallback chain. Those exist and they are good:

- [`cockatiel`](https://github.com/connor4312/cockatiel) — retry, circuit breaker, timeout, bulkhead
- [`ai-fallback`](https://www.npmjs.com/package/ai-fallback) — model fallback for the Vercel AI SDK

`llm-output-guard` produces the *signal* those layers are missing. Use them together.

---

## Usage

```ts
import { checkOutput, presets } from 'llm-output-guard';

const text = await callModel(prompt);
const verdict = checkOutput(text, presets.chat);

if (!verdict.ok) {
  console.warn('degenerate output', verdict.reasons);
  // fall through to your next provider
}
```

### Throwing form, for existing retry layers

```ts
import { assertOutput, DegenerateOutputError, presets } from 'llm-output-guard';
import { retry, handleWhen, ExponentialBackoff } from 'cockatiel';

const policy = retry(
  handleWhen((err) => err instanceof DegenerateOutputError || isTransport(err)),
  { maxAttempts: 3, backoff: new ExponentialBackoff() },
);

const text = await policy.execute(async () =>
  assertOutput(await callModel(prompt), presets.chat),
);
```

`DegenerateOutputError` carries `.retryable === true` and the full `.verdict`.

### Structured output

```ts
const verdict = checkOutput(raw, {
  ...presets.strictJson,
  requiredKeys: ['score', 'notes', 'followUp'],
});

if (verdict.ok) use(verdict.json); // already parsed, fence stripped
```

### Streaming, where it stops costing you tokens

Checking a finished response tells you that you already paid for it. A model
that starts looping keeps looping until `max_tokens`, and you are billed for
every one of those tokens and made to wait for them.

`guardStream` watches the response as it arrives and tells you the moment it
goes wrong, so you can abort the generation instead of buying the rest of it:

```ts
import { guardStream, presets } from 'llm-output-guard';

const controller = new AbortController();
const stream = await callModel(prompt, { signal: controller.signal });

for await (const chunk of guardStream(stream, {
  ...presets.chat,
  onDegenerate: (verdict) => {
    console.warn('model started looping', verdict.reasons);
    controller.abort();
  },
})) {
  process.stdout.write(chunk);
}
```

Against the degenerate fixtures, aborting on the first failed check ends the
generation after **8-52%** of the tokens the model would otherwise have
produced:

```
repetition-word-stutter        caught at  240/2999 chars ->  92% never generated
repetition-clause-loop         caught at  240/1680 chars ->  86% never generated
tail-loop-after-good-start     caught at  640/1569 chars ->  59% never generated
tail-loop-trailing-phrase      caught at  640/1238 chars ->  48% never generated
```

Zero of the healthy fixtures trip it, and the watching costs **~0.05ms per
check** — around 0.7ms across a 5,500 character response, flat as the stream
grows rather than quadratic in its length.

For manual control over the loop, use the primitive:

```ts
const guard = createStreamGuard(presets.chat);

for await (const chunk of stream) {
  const verdict = guard.push(chunk); // null until a check actually runs
  if (verdict && !verdict.ok) break;
  yield chunk;
}

const final = guard.end(finishReason); // full check, all detectors
```

**What runs when.** Mid-stream only the redundancy detectors are meaningful:
partial output is genuinely short, genuinely cut off, and genuinely not valid
JSON, so `TOO_SHORT`, `TRUNCATED`, `INVALID_JSON` and `LANG_MISMATCH` would
fire on every healthy generation and teach you to ignore the guard. They are
deferred to `end()`. `LOW_ENTROPY` is deferred too, for cost — it is ~100x the
other detectors, and everything it would have caught early is caught by
`REPETITION` anyway.

---

## The verdict

```ts
{
  ok: false,
  reasons: [
    { code: 'REPETITION', score: 0.83, threshold: 0.4, message: '83% of 3-grams are duplicates.' },
    { code: 'TAIL_LOOP',  score: 0.90, threshold: 0.5, message: 'Response ends in a repeating block…' },
  ],
  scores: { EMPTY: 0, TOO_SHORT: 0, REPETITION: 0.83, TAIL_LOOP: 0.90, LOW_ENTROPY: 0.41 },
}
```

Every detector runs even after one fails, so `reasons` shows the whole picture instead of whichever check happened to be ordered first. `scores` includes passing detectors too — send them to your metrics and you will know your real degeneration rate within a day.

## Detectors

| Code | Catches | Signal |
|---|---|---|
| `EMPTY` | Whitespace, lone punctuation, `{}`, empty fences | Content presence |
| `TOO_SHORT` | Non-empty but useless | Length vs. minimum |
| `REPETITION` | Loops and stutters | Duplicate n-gram fraction |
| `TAIL_LOOP` | Good start, then a stuck ending | Periodicity in the trailing window |
| `LOW_ENTROPY` | Character-level collapse, token artifacts | Hand-rolled LZ77 compression ratio |
| `TRUNCATED` | Cut off mid-thought | `finish_reason`, unbalanced fences/brackets |
| `INVALID_JSON` | Prose around the payload, missing keys | Parse + key contract |
| `LANG_MISMATCH` | Answered in the wrong language | Function-word profile (coarse, opt-in) |

Every detector is exported on its own if you only want one.

## Presets

`chat` · `strictJson` · `longForm` · `lenient`

They are starting points calibrated against the fixture corpus in this repo — not universal truths. Log your scores for a week, then set your own thresholds.

---

## On thresholds

A miss is annoying. **A false positive is worse**: a healthy response gets discarded and retried against a slower provider for nothing.

So the corpus carries deliberate traps — markdown tables, repeated-prefix lists, code blocks, rhetorical refrains — all of which a naive detector flags. `npm run calibrate` prints the margin between the worst healthy score and the weakest degenerate one:

```
=== REPETITION ===
  healthy max   :  0.073  (code-python-snippet)
  degenerate min:  0.771  (tail-loop-after-good-start)
  margin        :  0.698  OK
```

If that margin ever goes thin, the answer is a better detector, not a nudged threshold.

## Growing the corpus

```bash
GROQ_API_KEY=… node scripts/generate-fixtures.mjs --model llama-3.1-8b-instant --n 8
```

Output lands in `test/fixtures/raw/` **unreviewed**. Read each one, label it, then move it into `bad/` or `good/`. Nothing is auto-promoted: a fixture you have not read is a threshold you cannot defend.

## Design notes

- **Zero runtime dependencies**, enforced in CI. Node ≥ 18, works on edge, browser, Deno, Bun.
- **Hand-rolled LZ77** rather than `node:zlib`, so the package stays runtime-agnostic. It is not a real compressor; it only needs to move monotonically with redundancy.
- **Pure and synchronous.** No network, no clock, no randomness — safe on a hot path, trivial to test.
- **Scores, not booleans.** Detectors report 0–1 and leave the threshold decision to you.
- **Abstains rather than guesses.** Samples too short to judge score 0.

## Limitations

- Not a hallucination detector. It measures *shape*, never truth.
- Language detection is a function-word heuristic covering `id`/`en`/`es`. Opt-in, and unreliable under 25 words.
- Truncation from a missing full stop is weak evidence, scored 0.55 and left below the default thresholds on purpose. Lower `maxTruncation` to ~0.5 to catch it, and expect false positives.
- Thresholds calibrated on the bundled corpus. Yours will differ.

## License

MIT
