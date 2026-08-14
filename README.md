# llm-output-guard

Detect LLM responses that failed **while returning `200 OK`**.

Zero runtime dependencies. Deterministic. Composes with whatever retry or fallback layer you already have.

```bash
npm i llm-output-guard
```

**[Try it in your browser →](https://edwinsatya.github.io/llm-output-guard/)** — every detector, running on
this repo's own fixtures or on your own pasted output. No API key and no request:
the library is zero-dependency and synchronous, so the page runs the real thing.

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

`requiredKeys` only asks whether a name is present. A model returning
`{ "score": "very good" }` where you wanted a number satisfies it and still
breaks everything downstream that does arithmetic. Pass a **schema** to check
the shape rather than the spelling:

```ts
import { z } from 'zod';

const Review = z.object({
  score: z.number().min(0).max(10),
  notes: z.string(),
  followUp: z.array(z.string()),
});

const verdict = checkOutput(raw, { ...presets.strictJson, schema: Review });

if (verdict.ok) use(verdict.json); // parsed, validated, defaults applied
```

Any [Standard Schema](https://standardschema.dev) validator works — **Zod 4,
Valibot, ArkType**, or your own. The spec is types-only, so this costs an
interface and **no dependency**: your validator is one you already have, and
`llm-output-guard` still installs with nothing behind it.

On success `verdict.json` is the schema's *output*, so defaults, coercions and
transforms are applied and the value matches the type you declared. On failure
you get `INVALID_JSON` with the failing path in the message —
`score: Expected number, received string`. It is the same reason code as a
missing key or an unparseable payload because it wants the same handling: retry,
or fall through to another provider.

The two compose, and keys are checked first, so a missing key is still reported
as a missing key rather than as whatever the schema calls it.

> **The schema must validate synchronously.** `checkOutput` is synchronous by
> design — that is what makes it safe on a hot path — so a schema carrying an
> async refinement throws a `TypeError` telling you so, rather than silently
> passing. Everything Zod, Valibot and ArkType produce otherwise is synchronous.
> This is the one thing in the package that throws about your configuration; it
> still never throws about a response.

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

Against the degenerate fixtures, the guard reports a failure after **8-52%** of
each fixture's characters:

```
repetition-word-stutter        caught at  240/2999 chars ->  92% not yet read
repetition-clause-loop         caught at  240/1680 chars ->  86% not yet read
tail-loop-after-good-start     caught at  640/1569 chars ->  59% not yet read
tail-loop-trailing-phrase      caught at  640/1238 chars ->  48% not yet read
```

**Read that as detection latency, not as a saving.** It is measured by feeding
fixture strings to `createStreamGuard` in-process — there is no provider and no
connection involved, so it says how early the signal is available and nothing
about tokens or cost. What you do with the signal is the part that saves money,
and how much it saves depends on your provider.

Zero of the healthy fixtures trip it, and the watching costs **~0.05ms per
check** — around 0.7ms across a 5,500 character response, flat as the stream
grows rather than quadratic in its length.

**Those numbers are measured on Latin-script fixtures and do not carry over
unchanged.** For Chinese, Japanese and Thai the same in-process measurement
gives **0-85%**, and the spread is the whole story:

```
cjk-tail-loop-th-nopunct       caught at  240/1640 chars ->  85% not yet read
cjk-tail-loop-ja-nopunct       caught at  240/800  chars ->  70% not yet read
cjk-tail-loop-zh-nopunct       caught at  240/640  chars ->  63% not yet read
cjk-tail-loop-diluted          caught at 1840/2303 chars ->  20% not yet read
cjk-tail-loop-short            never mid-stream (128 chars, under the warmup)
```

A response that loops from the start saves what a Latin one saves. A response
that answers properly and *then* falls into a Chinese loop is caught late,
because there is nothing to detect until the loop begins — 20% on that fixture,
and less on a longer healthy prefix. Responses shorter than the 240-character
warmup are never judged mid-stream at all; they are caught by `end()`, after you
have paid for them.

Late detection is still worth having: it stops a broken response being cached,
returned, or counted as a success, which is the reason this package exists. It
is just not the token saving, and you should not budget for one.

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

### Vercel AI SDK

One wrap, and both `generateText` and `streamText` are guarded:

```ts
import { wrapLanguageModel } from 'ai';
import { outputGuard } from 'llm-output-guard/ai-sdk';
import { presets } from 'llm-output-guard';

const model = wrapLanguageModel({
  model: groq('llama-3.3-70b-versatile'),
  middleware: outputGuard({ ...presets.chat, onDegenerate: 'abort' }),
});
```

On `streamText` this cancels the provider's stream mid-generation. Driven
through the real SDK over a **mock part stream**, the source was pulled for **17
of 137 parts** before the guard cut it off. That figure is parts never requested
from a stub, not tokens never billed by a provider: the SDK's cancellation path
is exercised for real, the thing on the other end of it is not. On
`generateText` the tokens are already bought, so it throws
`DegenerateOutputError` instead, which your fallback layer can act on.

`onDegenerate` takes `'throw'` (default, also cancels the stream), `'abort'`
(stop cleanly, keep what arrived), or `'ignore'`. Start with `'ignore'` plus
`onVerdict` to watch your own traffic before letting a threshold fail anything:

```ts
outputGuard({
  ...presets.chat,
  onDegenerate: 'ignore',
  onVerdict: (verdict, { streaming }) => metrics.record(verdict.scores, { streaming }),
});
```

`ai` is an **optional peer dependency** — importing the subpath does not pull it
in, and the main entry point has no peers at all. Supported: **`ai` v5, v6 and
v7**. CI installs the packed tarball against each of those and both typechecks
and runs the adapter, so the range is one that has been executed rather than
assumed.

**`ai` v4 is not supported, and forcing it will look like a bug in this
package.** v4's middleware hands back `text` where v5+ hands back a `content`
array, and streams `{ textDelta }` where v5+ streams `{ delta }`. This adapter
reads the v5+ shape, so on v4 it sees the empty string for every response —
which means **every healthy generation is flagged `EMPTY`, and under the default
`onDegenerate: 'throw'` every call throws `DegenerateOutputError`.** It is not
that the guard misses things on v4; it rejects everything. The peer range now
refuses the install so you find out at `npm install` rather than in production.
If you are pinned to v4, do not override it — stay on the core entry point and
call `checkOutput` on the result yourself.

### OpenAI SDK — and anything speaking its protocol

One wrap, and both APIs are guarded — `chat.completions.create` and
`responses.create`, streaming and not:

```ts
import OpenAI from 'openai';
import { withOutputGuard } from 'llm-output-guard/openai';
import { presets } from 'llm-output-guard';

const client = withOutputGuard(new OpenAI(), {
  ...presets.chat,
  onDegenerate: 'abort',
});

await client.chat.completions.create({ model, messages });   // guarded
await client.responses.create({ model, input });             // guarded
```

The Responses API spells its stop reason `incomplete_details.reason` rather than
`finish_reason`, and its length stop `max_output_tokens` rather than `length`.
Both are mapped, so `TRUNCATED` fires the same way on either. `content_filter`
is deliberately *not* read as truncation — a filtered response is a different
failure, and reporting it as `TRUNCATED` would send a retry layer after the
wrong fix.

> **`responses.stream()` is not guarded.** It returns a `ResponseStream` — an
> event emitter with `.on()` and `.finalResponse()`, not just an async iterable
> — and wrapping only its iteration would guard a `for await` consumer while
> leaving `.finalResponse()` unchecked. A guard you believe in and do not have
> is the failure this package was written about, so it is left plainly
> unguarded rather than half-wrapped. Use `create({ stream: true })`, which is
> guarded, or run `checkOutput` on `await stream.finalResponse()` yourself.

This is also how you guard **Groq, Together, OpenRouter, Fireworks, DeepInfra,
vLLM and Ollama** — anything you reach through an OpenAI-compatible `baseURL`
works, because the adapter is typed against the wire shapes rather than against
OpenAI the company.

Non-streaming calls are already paid for by the time anything can run, so a
degenerate one throws `DegenerateOutputError` for your fallback layer to catch:

```ts
const completion = await client.chat.completions.create({ model, messages });
```

Streaming is where it pays. The guard watches deltas and **cancels the HTTP
request** the moment a loop is detectable:

```ts
const stream = await client.chat.completions.create({ model, messages, stream: true });
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
```

Driven through the real SDK against a looping model over a **mock transport**,
the response body was cancelled after **16 of 135 chunks** were generated — 88%
of the chunks were never produced.

**What that number is, precisely:** chunks a mock server was never asked to
produce after the client closed the connection, measured against an unguarded
baseline of the full 135. It is stronger than a "did abort fire" assertion —
the test observes cancellation at the response body, so a guard that stopped
iterating while the connection stayed open would fail it. It is **not** a
billing figure. A real provider sits behind buffering, its own chunking, and
server-side generation that may already have run ahead of what it has sent;
none of that exists in the mock. Treat 88% as evidence that cancellation
reaches the transport promptly, and measure your own provider before putting a
number in a budget.

`onDegenerate` and `onVerdict` are the same options as the Vercel adapter, from
the same type — `'throw'` (default, also cancels the stream), `'abort'` (stop
cleanly, keep what arrived), or `'ignore'`. Start with `'ignore'` plus
`onVerdict` to watch your own traffic first:

```ts
withOutputGuard(new OpenAI(), {
  ...presets.chat,
  onDegenerate: 'ignore',
  onVerdict: (verdict, { streaming }) =>
    metrics.record(verdict.scores, { streaming, modes: verdict.modes }),
});
```

`openai` is an **optional peer dependency**, and the wrapper is a proxy: every
other method on the client, and `create()`'s own `.withResponse()`, pass through
untouched. `finish_reason: 'length'` is mapped into the final check, so
`TRUNCATED` fires on a response that hit `max_tokens`.

**What runs when.** Mid-stream only the redundancy detectors are meaningful:
partial output is genuinely short, genuinely cut off, and genuinely not valid
JSON, so `TOO_SHORT`, `TRUNCATED`, `INVALID_JSON` and `LANG_MISMATCH` would
fire on every healthy generation and teach you to ignore the guard. They are
deferred to `end()`. `LOW_ENTROPY` is deferred too, for cost — it is ~100x the
other detectors, and everything it would have caught early is caught by
`REPETITION`, or by `TAIL_LOOP`'s character mode on non-spaced scripts.

Every adapter shares this behaviour because they all drive the same
`createStreamGuard`. None of them reimplements it.

### Anthropic SDK

Same one wrap, same options:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { withOutputGuard } from 'llm-output-guard/anthropic';
import { presets } from 'llm-output-guard';

const client = withOutputGuard(new Anthropic(), {
  ...presets.chat,
  onDegenerate: 'abort',
});

await client.messages.create({ model, max_tokens, messages });               // guarded
await client.messages.create({ model, max_tokens, messages, stream: true }); // guarded
```

Two things are specific to this API:

**Extended thinking is not read as the answer.** `thinking` blocks are the
model's reasoning, they are often longer than the answer, and they repeat
themselves as a matter of course while working a problem. Folding them into the
measured text would raise every repetition score on every thinking response and
flag the ones that thought hardest — so only `text` blocks are measured, and a
`thinking` block is not mistaken for a tool call either.

**Both of Anthropic's length stops map to `TRUNCATED`.** `max_tokens` passes
straight through; `model_context_window_exceeded` is the same event under a
different name and is normalised in the adapter. `refusal` is deliberately *not*
truncation — a refusal is a complete response that says no, which is a content
judgement this package does not make.

> **`messages.stream()` is not guarded**, for the same reason `responses.stream()`
> isn't: it returns a `MessageStream` — an event emitter with `.on()` and
> `.finalMessage()` — and guarding only its iteration would leave
> `.finalMessage()` unchecked. Use `create({ stream: true })`, or run
> `checkOutput` on `await stream.finalMessage()` yourself. `messages.batches` is
> unguarded too, and less interestingly: a batch is retrieved later as a file of
> results, so there is no response at `create` time to inspect.

`@anthropic-ai/sdk` is an **optional peer dependency**, declared
`>=0.60.0 <1.0.0` and verified at 0.60.0, 0.90.0 and 0.117.1 — each installing
the packed tarball and running the adapter for real, not just typechecking.

### Tool calls and agents

A model that answers by calling a tool returns no assistant text — OpenAI sends
`content: null` beside `tool_calls`, and the AI SDK sends a `content` array with
no `text` part. Handed to `checkOutput`, that is an empty string, and an empty
string scores `EMPTY`.

So **the presence of tool calls means the text, if any, is a preamble rather
than the answer**, and both adapters judge it as one:

| | On a tool-calling turn |
|---|---|
| No text at all | Nothing is judged, and nothing is reported to `onVerdict` |
| Text beside the call | `REPETITION`, `TAIL_LOOP` and `LOW_ENTROPY` still run |
| `TOO_SHORT` | Off — "Let me look that up" is sixteen characters and correct |
| `TRUNCATED` | Off — a preamble ends without terminal punctuation as a matter of course |
| `INVALID_JSON` | Off — the JSON is in the call arguments, which your provider already validated against the schema |

The redundancy detectors stay on because a model looping in its preamble is
still a model that is looping. `EMPTY` is not disarmed either: a response with
neither text nor tool calls still fails, which is the case this package exists
for.

Nothing is reported to `onVerdict` for a text-free tool call on purpose. Those
samples are what a `calibrate` run is built from, and a spike of `EMPTY: 1` in
them would describe your agent's tool use rather than any degeneration.

---

## The verdict

```ts
{
  ok: false,
  reasons: [
    { code: 'REPETITION', score: 0.83, threshold: 0.4, message: '83% of 3-grams are duplicates.' },
    { code: 'TAIL_LOOP',  score: 0.90, threshold: 0.5, message: 'Response ends in a repeating block…',
      mode: 'word' },
  ],
  scores: { EMPTY: 0, TOO_SHORT: 0, REPETITION: 0.83, TAIL_LOOP: 0.90, LOW_ENTROPY: 0.41 },
  modes:  { TAIL_LOOP: 'word' },
}
```

Every detector runs even after one fails, so `reasons` shows the whole picture instead of whichever check happened to be ordered first. `scores` includes passing detectors too — send them to your metrics and you will know your real degeneration rate within a day.

`modes` says which tokenizer produced a score, for the detectors that have more
than one. **Log it next to `scores`.** `TAIL_LOOP` measures words on spaced
scripts and characters on Chinese, Japanese and Thai; those are two
distributions with different base rates, and aggregating them into one histogram
gives you a number that describes neither.

## Detectors

| Code | Catches | Signal | Exported as |
|---|---|---|---|
| `EMPTY` | Whitespace, lone punctuation, `{}`, empty fences | Content presence | `emptinessScore` |
| `TOO_SHORT` | Non-empty but useless | Length vs. minimum | `shortnessScore` |
| `REPETITION` | Loops and stutters | Duplicate word n-gram fraction | `repetitionScore` |
| `TAIL_LOOP` | Good start, then a stuck ending | Periodicity in the trailing window, over words or characters | `tailLoopScore`, `tailLoopDetail` |
| `LOW_ENTROPY` | Character-level collapse, token artifacts | Hand-rolled LZ77 compression ratio | `compressibilityScore`, `compressionRatio` |
| `TRUNCATED` | Cut off mid-thought | `finish_reason`, unbalanced fences/brackets | `truncationScore` |
| `INVALID_JSON` | Prose around the payload, missing keys, wrong types | Parse + key contract + optional schema | `jsonScore`, `stripFence` |
| `LANG_MISMATCH` | Answered in the wrong language | Function-word profile (coarse, opt-in) | `languageMismatchScore`, `languageProfile`, `supportedLanguages` |

Every detector is exported on its own if you only want one, and every name in
that last column is covered by semver — see **Stability**.

```ts
import { repetitionScore, tailLoopDetail, stripFence } from 'llm-output-guard';

repetitionScore(text);                  // 0..1, higher is worse
repetitionScore(text, { n: 4 });        // n-gram size
tailLoopDetail(text, { mode: 'char' }); // { score, mode } — which tokenizer ran
stripFence('```json\n{"a":1}\n```');    // '{"a":1}'
```

Each takes `(text, options?)` and returns a `0..1` score, with three exceptions
worth knowing: `shortnessScore(text, minChars)` takes its minimum positionally,
`stripFence` returns a string, and `jsonScore` / `tailLoopDetail` return a detail
object rather than a bare number. `supportedLanguages` is a value, not a
function — the array `['id', 'en', 'es']`.

## Presets

`chat` · `strictJson` · `longForm` · `lenient`

They are starting points calibrated against the fixture corpus in this repo — not universal truths. Log your scores for a week, then set your own thresholds.

---

## Calibrating against your own traffic

The shipped presets are tuned on the fixture corpus, which is not your traffic.
Log your scores for a week, then let the CLI read them back:

```bash
npx llm-output-guard calibrate scores.jsonl
# or:  cat scores.jsonl | npx llm-output-guard calibrate --fpr 0.001
```

```
8,000 verdicts — flagging budget 0.10% of traffic
! sample is too small for a 0.10% rate: it rests on the top ~8 scores, and
  ~10,000 verdicts are needed before that tail means anything

REPETITION   n=7,993
  p50 0.000   p90 0.000   p99 0.100   p99.9 0.944   max 0.991
  gap 0.114 -> 0.705  (15 above, 0.19% of traffic)
  suggest maxRepetition: 0.409

TAIL_LOOP   n=7,993
  p50 0.000   p90 0.000   p99 0.000   p99.9 0.000   max 0.789
  gap 0.000 -> 0.789  (1 above, 0.01% of traffic)
  suggest maxTailLoop: 0.394
    ! the separation rests on 1 sample; treat it as a lead to confirm, not a
      calibrated threshold
```

Input is JSONL and the parsing is deliberately forgiving — a bare scores
object, a whole `Verdict`, or either of those buried in a wider log record all
work, because a calibration step you have to reshape your logs for is one you
will not run. `--json` emits the same analysis as data.

If you log `modes` alongside `scores`, detectors are segmented by tokenizer and
reported as `TAIL_LOOP [word]` and `TAIL_LOOP [char]`, each suggesting its own
option. Do this if your traffic is not all one script: pooled, the two
distributions produce a single threshold that is wrong for both — word-mode
`TAIL_LOOP` on Indonesian traffic has a healthy maximum near 0.35 where character
mode's is near 0.06.

**What it can and cannot tell you.** The corpus can compute a real margin
because every fixture is labelled. Your logs are not, and no arithmetic
recovers a label that was never written down. So these numbers bound *false
positives* — how much of your own traffic a threshold would flag — on the
assumption that degeneration is rare in it. They say nothing about what a
threshold catches; a detector that never fires has a perfect false-positive
rate. The `gap` line is the exception worth trusting, because a hole between
the bulk and a cluster of outliers is real separation observed in your data
rather than an assumption about rarity — and when that hole rests on one or
two samples, the report says so.

### The same thing, as a function

The CLI is a wrapper. If your scores already live somewhere the shell cannot
reach them — a metrics store, a warehouse query, a test — call `calibrate`
directly. It takes the same flat objects the JSONL format describes:

```ts
import { calibrate } from 'llm-output-guard';

const { n, summaries } = calibrate(
  [
    { REPETITION: 0.03, TAIL_LOOP: 0 },
    { REPETITION: 0.91, TAIL_LOOP: 0.88, modes: { TAIL_LOOP: 'char' } },
    // ...one entry per logged verdict
  ],
  { falsePositiveRate: 0.001 },
);

for (const s of summaries) {
  s.code;               // 'REPETITION'
  s.mode;               // 'word' | 'char', when the samples recorded one
  s.suggested;          // threshold flagging falsePositiveRate of this sample
  s.gap;                // { below, above, count, share } | null — stronger evidence
  s.distribution;       // { n, nonZero, min, max, p50, p90, p99, p999 }
  s.caveats;            // everything that makes `suggested` untrustworthy
}
```

`modes` rides along in the same object and is not read as a score. Log it, and
`summaries` comes back segmented — one entry per `code`+`mode` — for the reason
in the paragraph above. `summarise(code, scores, options)` is exported too, for
when you have one detector's numbers already grouped.

**Read `caveats` before `suggested`.** It is where a sample too small for the
requested rate says so, and a `suggested` number carries no warning of its own.

## On thresholds

A miss is annoying. **A false positive is worse**: a healthy response gets discarded and retried against a slower provider for nothing.

So the corpus carries deliberate traps — markdown tables, repeated-prefix lists, code blocks, rhetorical refrains — all of which a naive detector flags. `npm run calibrate` prints the margin between the worst healthy score and the weakest degenerate one:

```
=== TAIL_LOOP [word] ===
  healthy max   :  0.000  (code-block-typescript)
  degenerate min:  0.900  (tail-loop-after-good-start)
  margin        :  0.900  OK

=== TAIL_LOOP [char] ===
  healthy max   :  0.291  (prose-zh-poem-refrain)
  degenerate min:  0.829  (cjk-refrain-x20)
  margin        :  0.538  OK
```

Detectors with two tokenizers are reported per mode, and each detector is scored
only against fixtures labelled for it — otherwise a tail loop that `LOW_ENTROPY`
was never meant to catch drags `LOW_ENTROPY`'s margin negative and the report
reads like a regression in something nobody touched.

If that margin ever goes thin, the answer is a better detector, not a nudged
threshold. That rule is why `REPETITION` has no character mode: the one that was
built came out with a *negative* margin, so it was deleted rather than tuned.

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

## Script coverage

The dividing line is **whether a script puts spaces between words**, not whether
it is Latin. Korean, Cyrillic, Greek, Arabic and Devanagari all separate words
and are handled exactly like English. Han, Hiragana, Katakana and Thai do not,
and get different treatment:

| | Chinese / Japanese / Thai | Everything else |
|---|---|---|
| `TAIL_LOOP` | **Character mode**, `maxCharTailLoop` (default 0.7) | Word mode, `maxTailLoop` (default 0.5) |
| `REPETITION` | **Blind — see below** | Word n-grams, works |
| `LOW_ENTROPY`, `TRUNCATED`, `INVALID_JSON`, `EMPTY`, `TOO_SHORT` | Character- or structure-based, unaffected | Same |
| `LANG_MISMATCH` | Not covered (`id`/`en`/`es` only) | `id`/`en`/`es` only |

Mode is chosen per detector, from the span that detector actually reads — so a
reply that answers in English and then loops in Chinese puts the *tail* detector
into character mode without moving anything else. It is reported in
`Verdict.modes`.

**`REPETITION` is blind on these scripts, and we could not fix it.** A word
tokenizer sees a punctuation-delimited Chinese clause as one token, and a loop
with no punctuation as one token for the entire response, so it scores 0.000 on
an obvious loop. A character n-gram fallback was built, measured, and rejected —
because **it would add no coverage and cost a false-positive surface**.

It adds nothing because `TAIL_LOOP`'s character mode already catches every
degenerate non-Latin sample in the corpus, at a margin of 0.538.

It costs something because healthy *structured* CJK output scores high under it.
Repeated key scaffolding around short CJK values is genuinely redundant
character-by-character:

```
healthy json-zh-keys-valid, char n-grams (n=4), all items distinct
   8 items  0.396     20 items  0.543     40 items  0.597
  12 items  0.474     30 items  0.577
```

That flattens rather than diverging — it converges on the scaffolding's own
proportion — so a threshold does exist. But the plateau near 0.6 against the
weakest pure loop at 0.872 leaves about **0.19**, under the 0.2 margin this
package holds itself to, and the healthy side climbs with the number of keys a
payload carries. A detector with nothing to add and a structure-sensitive margin
is a false positive waiting for someone's payload shape to change, which is the
wrong trade here.

`TAIL_LOOP`'s character mode covers the gap in practice — it requires *exact*
periodicity, which scaffolding never produces, and it catches every degenerate
non-Latin sample in the corpus. But a mid-response CJK loop that recovers before
the end is not detected by anything here. If that is your failure mode, log
`LOW_ENTROPY` and threshold it yourself.

Two more things worth knowing:

- **Character mode abstains below 80 characters.** Three identical short
  sentences closing a 40-character reply look like total coverage and are not
  evidence of anything.

### Character mode is deliberately slower to fire

The two modes do not flag the same shape at the same point, and the gap is
large. Taking the clearest case — a response ending in an identical repeated
line — measured on both:

| Repeats of an identical closing line | English (`maxTailLoop` 0.5) | Chinese (`maxCharTailLoop` 0.7) |
|---|---|---|
| 3 | **flagged** (0.563) | 0.000 — under the 80-character floor |
| 5 | flagged (0.682) | 0.000 |
| 9 | flagged (0.794) | 0.686 |
| 10 | flagged (0.811) | **flagged** (0.708) |
| 20 | flagged (0.900) | flagged (0.829) |

**English flags at 3 repeats, Chinese at about 10** — and nearer 30 when a long
healthy passage precedes the loop, because the score is coverage of the trailing
window rather than a count.

This is a decision, not an accident of two constants. Word mode counts tokens,
so a repeated clause is several tokens and accumulates fast. Character mode
measures how much of a fixed trailing window one repeating block covers, and a
short refrain takes many repeats to fill it. Tightening `maxCharTailLoop` toward
word-mode aggression would put it into the range where ordinary CJK structured
output sits, which is the trade this package refuses.

**The practical consequence: a looping model answering in Chinese, Japanese or
Thai generates several times more output before the guard fires than the same
model looping in English.** Detection is later and the token saving is smaller.
If you serve mostly non-spaced-script traffic and that cost matters more to you
than the false-positive risk, lower `maxCharTailLoop` toward 0.5 — and calibrate
it against your own traffic first, because that is the range healthy structured
output starts to reach.

## Stability

What semver means for this package specifically. These rules bind from **1.0.0**
onward; under `0.x` they described an intent, and the surface was frozen — export
by export — in the 1.0.0 release.

**The public API is:** everything exported from `llm-output-guard`, plus
`outputGuard` / `OutputGuardOptions` / `DegenerateAction` from `./ai-sdk`, and
`withOutputGuard` / `OutputGuardOptions` / `DegenerateAction` from each of
`./openai` and `./anthropic`. Each subpath is its own contract; the adapters
share internal base types today and are free to diverge, so an option added to
one is not a promise about the others. Anything not exported from those four
entry points is internal, has no stability guarantee, and may move in any release
— `internal/proxy-guard.ts` and `internal/tool-calls.ts` included, however much
behaviour they carry. The list is asserted in `test/surface.test.ts`, so an
export cannot join it by accident.

**Threshold and preset values are behaviour, not implementation.** This is the
interesting case, so it gets a rule of its own:

| Change | Release type |
|---|---|
| Lowering a default threshold, or changing a preset's numbers | **major** |
| Adding a new detector that runs by default | **major** |
| Adding a new *option*, defaulted so nothing changes | minor |
| Adding a new detector that is opt-in | minor |
| Making an existing detector strictly more accurate on its own axis | minor |
| Docs, internals, performance, fixing a detector that was returning a wrong score | patch |

The reasoning: a threshold change does not break your build, it changes which of
your production responses get discarded and retried. That is a larger event than
a signature change, and it is invisible until your traffic hits it. A number in
`presets.chat` is part of the contract in the same way a function name is.

**Semver does not cover:** the exact scores a detector returns (only their
direction and the thresholds that act on them), the contents of the fixture
corpus, `message` strings in `Reason`, or the output format of the `calibrate`
CLI's human-readable report. `--json` output *is* covered.

**Peer ranges** are narrowed only in a major. They are verified rather than
assumed — `npm run check:peers` installs the packed tarball against each end of
each declared range and both typechecks and runs the adapter.

**Why this is written down.** Version 0.4.2 shipped the `ai` peer narrowing, the
new `./openai` subpath, and character-mode `TAIL_LOOP` — one breaking change, one
feature, and one behaviour change — under a **patch** number, which every default
version range upgrades into automatically. It was withdrawn from npm within the
72-hour unpublish window and re-released as 0.5.0, where `^0.4.1` correctly
resolves away from it. The rule it broke is the one in the table above: threshold
and preset changes are behaviour changes, and behaviour changes are never
patches.

## Limitations

- Not a hallucination detector. It measures *shape*, never truth.
- Tool *arguments* are not checked, only the prose beside them. A model that loops inside a JSON argument string is invisible here — your provider validates those against the schema you gave it.
- `openai`'s `responses.stream()` helper is not wrapped. See the note above; `create({ stream: true })` is.
- `REPETITION` does not work on Chinese, Japanese or Thai. See above — this is a known, measured gap, not an oversight.
- Language detection is a function-word heuristic covering `id`/`en`/`es`. Opt-in, and unreliable under 25 words.
- Truncation from a missing full stop is weak evidence, scored 0.55 and left below the default thresholds on purpose. Lower `maxTruncation` to ~0.5 to catch it, and expect false positives.
- Thresholds calibrated on the bundled corpus. Yours will differ — and the word and character thresholds need calibrating **separately**, because they are separate distributions.

## License

MIT
