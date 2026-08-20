<p align="center">
  <img src="https://raw.githubusercontent.com/edwinsatya/llm-output-guard/main/assets/logo.svg"
       width="240" alt="llm-output-guard" />
</p>

# llm-output-guard

**Detect LLM responses that failed while returning `200 OK`.**

[![npm](https://img.shields.io/npm/v/llm-output-guard?color=0b7285)](https://www.npmjs.com/package/llm-output-guard)
[![downloads](https://img.shields.io/npm/dm/llm-output-guard?color=0b7285&cacheSeconds=86400)](https://www.npmjs.com/package/llm-output-guard)
[![minzipped](https://img.shields.io/bundlejs/size/llm-output-guard?color=0b7285&label=min%2Bgzip)](https://bundlejs.com/?q=llm-output-guard)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://github.com/edwinsatya/llm-output-guard/blob/main/package.json)
[![CI](https://github.com/edwinsatya/llm-output-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/edwinsatya/llm-output-guard/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/llm-output-guard?color=0b7285)](./LICENSE)

Your retry layer watches for `429`, `5xx` and timeouts. It cannot see a model that
looped until `max_tokens`, returned `{}`, stopped mid-sentence, or answered in the
wrong language — because all of those arrive as a **successful request**.

This produces the signal that layer is missing. Zero dependencies, ~5 KB gzipped,
synchronous, no network.

```bash
npm i llm-output-guard
```

```ts
import { checkOutput, presets } from 'llm-output-guard';

const verdict = checkOutput(await callModel(prompt), presets.chat);

if (!verdict.ok) {
  console.warn(verdict.reasons);  // [{ code: 'TAIL_LOOP', score: 0.9, ... }]
  // fall through to your next provider
}
```

**[Try it in your browser →](https://edwinsatya.github.io/llm-output-guard/)** —
every detector, running on your own pasted output. No API key, no request.

> **It is not a hallucination detector.** It measures *shape*, never truth. It
> cannot tell you the model was wrong; it can tell you the model stopped
> producing language.

---

## What it catches

| Code | Catches | Signal |
|---|---|---|
| `EMPTY` | Whitespace, lone punctuation, `{}`, empty fences | Content presence |
| `TOO_SHORT` | Non-empty but useless | Length vs. minimum |
| `REPETITION` | Loops and stutters | Duplicate word n-gram fraction |
| `TAIL_LOOP` | Good start, then a stuck ending | Periodicity in the trailing window |
| `LOW_ENTROPY` | Character-level collapse, token artifacts | Compression ratio |
| `TRUNCATED` | Cut off mid-thought | `finish_reason`, unbalanced fences |
| `INVALID_JSON` | Prose around the payload, wrong types | Parse + key + schema contract |
| `SCRIPT_MISMATCH` | Answered in the wrong alphabet | Share of letters outside the expected scripts (opt-in) |
| `LANG_MISMATCH` | Answered in the wrong language, same alphabet | Function-word profile (opt-in) |
| `PROMPT_ECHO` | Returned your prompt instead of an answer | Share of output copied verbatim from the prompt (opt-in) |

Every detector runs even after one fails, so a verdict shows the whole picture
rather than whichever check happened to be ordered first. Each returns **0–1, not
a boolean** — you pick the line. Full reference: **[docs/detectors.md](docs/detectors.md)**.

## Guard your provider in one wrap

```ts
import OpenAI from 'openai';
import { withOutputGuard } from 'llm-output-guard/openai';

const client = withOutputGuard(new OpenAI(), { ...presets.chat, onDegenerate: 'abort' });
```

Adapters for the **OpenAI SDK** (both `chat.completions` and `responses`),
**Anthropic**, and the **Vercel AI SDK** — plus anything speaking OpenAI's
protocol: Groq, Together, OpenRouter, Fireworks, vLLM, Ollama.

On a stream this **cancels the HTTP request** the moment a loop is detectable, so
you stop paying for the rest of it.

If you run agents, add `checkToolArguments: true`. A tool-calling turn is judged
by its preamble, which leaves the actual answer — the arguments — unmeasured.
Your provider validates those against your schema, and a schema covers *types*:
`{ "query": "site reliability site reliability …" }` is a valid `string`, and it
still reaches your tool as a garbage query. See **[docs/adapters.md](docs/adapters.md)**
and **[docs/streaming.md](docs/streaming.md)**.

## The hard part is not catching loops

A miss is annoying. **A false positive is worse** — a healthy response gets
discarded and retried against a slower provider for nothing.

So the corpus carries deliberate traps: markdown tables, repeated-prefix lists,
code blocks, rhetorical refrains, a Chinese poem refrain. All repetitive, all
fine, all flagged by a naive detector. Paste one into the
[playground](https://edwinsatya.github.io/llm-output-guard/) and watch it pass.

---

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

See **[docs/detectors.md](docs/detectors.md)** for arrays of repeated records —
a JSON array of identical rows reads as a loop under the default scope, and
`redundancyScope: 'jsonValues'` is the fix.

### Answering in the wrong language

```ts
checkOutput(raw, { ...presets.chat, expectScript: 'latin' });
```

A model that ignores "answer in English" does not produce broken English, it
produces fluent Chinese. That is a `200 OK` your retry layer cannot see, and it
is detectable by counting characters — no word list, no model, decisive from
about a dozen letters. A response answered entirely in the wrong script scores
**1.000**; a healthy response measured against its own script scores
**0.000–0.028**.

Pass every script the answer may legitimately contain — `['han', 'latin']` for
Chinese, `['han', 'kana', 'latin']` for Japanese. `'latin'` belongs in nearly all
of them, because a Chinese answer about React still contains `useEffect`. Code
fences, inline code and URLs are removed before measuring, so a TypeScript block
never counts as answering in English.

Same script means no signal: Spanish against English scores 0. That is what
`expectLang` is for, and the two compose under separate codes.

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

## Presets

`chat` · `strictJson` · `longForm` · `lenient`

They are starting points calibrated against the fixture corpus in this repo — not universal truths. Log your scores for a week, then set your own thresholds.

---

## Calibrating against your own traffic

The shipped presets are tuned on this repo's fixture corpus, which is **not your
traffic**. Log your scores for a week, then derive thresholds you can defend:

```bash
npx llm-output-guard calibrate scores.jsonl --fpr 0.001
```

The report tells you when your sample is too small to support the rate you asked
for, and distinguishes real separation in your data from a false-positive budget —
because only one of those is evidence. Full guide:
**[docs/calibration.md](docs/calibration.md)**.

## Script coverage

Korean, Cyrillic, Greek, Arabic and Devanagari separate words and are handled like
English. **Chinese, Japanese and Thai do not**, so `TAIL_LOOP` switches to
character mode and reads its own threshold. `REPETITION` is blind on those scripts —
a known, measured gap. `SCRIPT_MISMATCH` covers all ten scripts and is the one
detector these are *not* the weak case for. Numbers behind both in
**[docs/script-coverage.md](docs/script-coverage.md)**.

## Design notes

- **Zero runtime dependencies**, enforced in CI. Node ≥ 18, works on edge, browser, Deno, Bun.
- **Hand-rolled LZ77** rather than `node:zlib`, so the package stays runtime-agnostic. It is not a real compressor; it only needs to move monotonically with redundancy.
- **Pure and synchronous.** No network, no clock, no randomness — safe on a hot path, trivial to test.
- **Scores, not booleans.** Detectors report 0–1 and leave the threshold decision to you.
- **Abstains rather than guesses.** Samples too short to judge score 0.

### What it costs

"Safe on a hot path" is a latency claim, so here is the latency. `npm run bench`
reproduces it; `-- --json` gives machine-readable output.

| `checkOutput(presets.chat)` | p50 | p99 |
|---|---|---|
| 500 B | 0.383 ms | 0.480 ms |
| 2 KB | 0.457 ms | 0.553 ms |
| 8 KB | 0.677 ms | 0.858 ms |
| 32 KB | 1.014 ms | 1.235 ms |

**One detector is most of that.** At 2 KB, `LOW_ENTROPY` costs 0.376 ms and the
other seven together cost 0.19 ms — the LZ77 pass is the bulk of the bill:

| detector, 2 KB | p50 |
|---|---|
| `LOW_ENTROPY` | 0.376 ms |
| `PROMPT_ECHO` | 0.111 ms |
| `SCRIPT_MISMATCH` | 0.066 ms |
| `REPETITION` | 0.048 ms |
| `TAIL_LOOP` | 0.026 ms |
| `LANG_MISMATCH` | 0.019 ms |
| `INVALID_JSON` | 0.006 ms |
| `TRUNCATED` | 0.002 ms |

So if you ever need this cheaper, there is exactly one lever: `maxCompressibility: null`.
That is why `presets.strictJson` measures **0.082 ms** against `chat`'s 0.457 ms —
it disables that detector for an unrelated reason (JSON is legitimately
repetitive) and gets 5× the speed as a side effect. It is also why the streaming
guard defers `LOW_ENTROPY` to the end rather than running it every few hundred
characters.

Measured on Node 24, darwin/arm64, 500 runs after 200 warmup, on varied prose.
Your absolute numbers will differ; the ratios are the durable part.

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
- Tool *arguments* are checked only when you ask — `checkToolArguments: true` on any adapter, non-streaming responses only. Off by default, and unmeasured before 1.5.
- `openai`'s `responses.stream()` helper is not wrapped. See the note above; `create({ stream: true })` is.
- `REPETITION` does not work on Chinese, Japanese or Thai. See above — this is a known, measured gap, not an oversight.
- `PROMPT_ECHO` cannot tell a degenerate echo from a rewrite, translation or summary, because there is no difference in the text — only in what you asked for. Opt-in, and never enable it on those endpoints.
- Language detection is a function-word heuristic covering `id`/`en`/`es`. Opt-in, and unreliable under 25 words. `expectScript` is the stronger check where the languages differ in alphabet, and says nothing where they do not.
- `SCRIPT_MISMATCH` does not run mid-stream. A mid-stream check reads a trailing window, and the language of a window is not the language of the response — an English answer quoting a Chinese passage measures 0.114 whole and 0.500 over its last 400 characters.
- Truncation from a missing full stop is weak evidence, scored 0.55 and left below the default thresholds on purpose. Lower `maxTruncation` to ~0.5 to catch it, and expect false positives.
- A JSON array of repeated identical records reads as a loop under the default scope, and fails from three records up. Set `redundancyScope: 'jsonValues'` — see **Structured output**.
- Thresholds calibrated on the bundled corpus. Yours will differ — and the word and character thresholds need calibrating **separately**, because they are separate distributions.

## License

MIT
