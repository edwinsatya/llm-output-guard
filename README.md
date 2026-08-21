<p align="center">
  <img src="https://raw.githubusercontent.com/edwinsatya/llm-output-guard/main/assets/logo.svg"
       width="240" alt="llm-output-guard" />
</p>

# llm-output-guard

**Detect LLM responses that failed while returning `200 OK`.**

<!--
  Two rows on purpose: what you are installing, then whether it is looked after.

  Every GitHub-backed badge carries an explicit cacheSeconds. Shields defaults
  these to max-age=120, which has GitHub's camo proxy refetch 720 times a day
  and gives 720 daily chances to catch the upstream API rate limited and cache
  the error for the whole TTL. That is not hypothetical: it happened to the
  downloads badge, which is why it carries one too.
-->
[![npm](https://img.shields.io/npm/v/llm-output-guard?color=0b7285)](https://www.npmjs.com/package/llm-output-guard)
[![downloads](https://img.shields.io/npm/dm/llm-output-guard?color=0b7285&cacheSeconds=86400)](https://www.npmjs.com/package/llm-output-guard)
[![minzipped](https://img.shields.io/bundlejs/size/llm-output-guard?color=0b7285&label=min%2Bgzip)](https://bundlejs.com/?q=llm-output-guard)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://github.com/edwinsatya/llm-output-guard/blob/main/package.json)
[![types](https://img.shields.io/npm/types/llm-output-guard?color=0b7285&cacheSeconds=86400)](https://www.npmjs.com/package/llm-output-guard)
[![node](https://img.shields.io/node/v/llm-output-guard?color=0b7285&cacheSeconds=86400)](https://nodejs.org)

[![CI](https://github.com/edwinsatya/llm-output-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/edwinsatya/llm-output-guard/actions/workflows/ci.yml)
[![last commit](https://img.shields.io/github/last-commit/edwinsatya/llm-output-guard?color=0b7285&cacheSeconds=21600)](https://github.com/edwinsatya/llm-output-guard/commits/main)
[![commit activity](https://img.shields.io/github/commit-activity/m/edwinsatya/llm-output-guard?color=0b7285&cacheSeconds=86400)](https://github.com/edwinsatya/llm-output-guard/graphs/commit-activity)
[![license](https://img.shields.io/npm/l/llm-output-guard?color=0b7285&cacheSeconds=86400)](./LICENSE)

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
| `SCRIPT_MISMATCH` | Answered in the wrong alphabet | Share of letters outside expected scripts · opt-in |
| `LANG_MISMATCH` | Wrong language, same alphabet | Function-word profile · opt-in |
| `PROMPT_ECHO` | Returned your prompt instead of an answer | Share of output copied from the prompt · opt-in |

Every detector runs even after one fails, so a verdict shows the whole picture
rather than whichever check happened to be ordered first. Each returns **0–1, not
a boolean** — you pick the line.

**Full reference, with the measurements behind every default:
[docs/detectors.md](docs/detectors.md)**

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
you stop paying for the rest of it. Two switches worth knowing:
`checkToolArguments: true` measures the arguments a model passes to a tool, and
`checkPromptEcho: true` reads the prompt out of each request so a model that
replays it instead of answering is caught.

**[docs/adapters.md](docs/adapters.md)** · **[docs/streaming.md](docs/streaming.md)**

## The hard part is not catching loops

A miss is annoying. **A false positive is worse** — a healthy response gets
discarded and retried against a slower provider for nothing.

So the corpus carries deliberate traps: markdown tables, repeated-prefix lists,
code blocks, rhetorical refrains, a Chinese poem refrain, a Chinese answer
wrapped around a TypeScript block. All of them look degenerate to a naive
detector, and all of them are fine. Paste one into the
[playground](https://edwinsatya.github.io/llm-output-guard/) and watch it pass.

---

## Common setups

**Structured output** — parse, check keys, and validate against a schema you
already have:

```ts
import { z } from 'zod';

const verdict = checkOutput(raw, {
  ...presets.strictJson,
  schema: z.object({ score: z.number(), notes: z.string() }),
});

if (verdict.ok) use(verdict.json); // parsed, validated, defaults applied
```

Any [Standard Schema](https://standardschema.dev) validator works — Zod 4,
Valibot, ArkType — and the spec is types-only, so this still costs **no
dependency**. Details, and the one case that throws:
[docs/detectors.md](docs/detectors.md#structured-output)

**Answered in the wrong language** — a model that ignores "answer in English"
returns fluent Chinese, not broken English:

```ts
checkOutput(raw, { ...presets.chat, expectScript: 'latin' });
```

Detectable by counting characters — no word list, decisive from about a dozen
letters. A wrong-script answer scores **1.000**; a healthy one measured against
its own script scores **0.000–0.028**. Pass every script the answer may
legitimately contain (`['han', 'latin']` for Chinese). Code fences and URLs are
excluded, so a TypeScript block never counts as answering in English.
[More →](docs/detectors.md#answering-in-the-wrong-language)

**Returned your prompt instead of an answer** — invisible to every other
detector here, because such a response is fluent, well-formed and the right
length:

```ts
checkOutput(raw, { ...presets.chat, prompt });
// or, from an adapter, which reads the prompt out of the request itself:
withOutputGuard(new OpenAI(), { ...presets.chat, checkPromptEcho: true });
```

Not for rewrite, translate or summarise endpoints, where copying the input is
the job. [More →](docs/detectors.md#returning-the-prompt-instead-of-an-answer)

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

`reasons` carries every failing signal, not just the first. `scores` includes the
passing detectors too — send them to your metrics and you will know your real
degeneration rate within a day.

`modes` says which tokenizer produced a score. **Log it next to `scores`:**
`TAIL_LOOP` measures words on spaced scripts and characters on Chinese, Japanese
and Thai, and pooling two distributions into one histogram gives you a number
that describes neither.

## Presets

`chat` · `strictJson` · `longForm` · `lenient`

Starting points calibrated against this repo's fixture corpus — not universal
truths.

## Calibrate against your own traffic

The shipped presets are tuned on a corpus that is **not your traffic**. Score the
responses you already have, then derive thresholds you can defend:

```bash
npx llm-output-guard check logs/*.txt --json | npx llm-output-guard calibrate --fpr 0.001
```

`check` also works as a CI assertion — it exits 1 when anything is degenerate,
2 when the input cannot be read.

The report tells you when your sample is too small to support the rate you asked
for, and distinguishes real separation in your data from a false-positive budget —
because only one of those is evidence.
**[docs/calibration.md](docs/calibration.md)**

## Design notes

- **Zero runtime dependencies**, enforced in CI. Node ≥ 18; works on edge, browser, Deno, Bun.
- **Pure and synchronous.** No network, no clock, no randomness — safe on a hot path, trivial to test.
- **Scores, not booleans.** Detectors report 0–1 and leave the threshold decision to you.
- **Abstains rather than guesses.** Samples too short to judge score 0.
- **Hand-rolled LZ77** rather than `node:zlib`, so the package stays runtime-agnostic.
- **Sub-millisecond**, 0.383 ms at 500 B and 1.014 ms at 32 KB, with one detector accounting for most of it. `npm run bench` reproduces it — **[docs/performance.md](docs/performance.md)**
- **Chinese, Japanese and Thai** are handled where they differ: `TAIL_LOOP` switches to character mode, `REPETITION` is blind and says so — **[docs/script-coverage.md](docs/script-coverage.md)**

## Stability

What semver means here specifically. These rules bind from **1.0.0** onward, and
the public surface was frozen export by export in that release.

**The public API is** everything exported from `llm-output-guard`, plus
`outputGuard` / `OutputGuardOptions` / `DegenerateAction` from `./ai-sdk` and
`withOutputGuard` / `OutputGuardOptions` / `DegenerateAction` from `./openai` and
`./anthropic`. Each subpath is its own contract, so an option added to one is not
a promise about the others. Anything else is internal and may move in any
release. The list is asserted in `test/surface.test.ts`, so an export cannot join
it by accident.

**Threshold and preset values are behaviour, not implementation.** That is the
interesting case, so it gets a rule of its own:

| Change | Release type |
|---|---|
| Lowering a default threshold, or changing a preset's numbers | **major** |
| Adding a new detector that runs by default | **major** |
| Adding a new *option*, defaulted so nothing changes | minor |
| Adding a new detector that is opt-in | minor |
| Making an existing detector strictly more accurate on its own axis | minor |
| Docs, internals, performance, fixing a detector that returned a wrong score | patch |

A threshold change does not break your build. It changes which of your production
responses get discarded and retried, which is a larger event than a signature
change and invisible until your traffic hits it. A number in `presets.chat` is
part of the contract in the same way a function name is.

**Not covered:** the exact scores a detector returns (only their direction and
the thresholds acting on them), the fixture corpus, `message` strings in
`Reason`, or the human-readable `calibrate` report. `--json` output *is* covered.

**Peer ranges** narrow only in a major, and are verified rather than assumed —
`npm run check:peers` installs the packed tarball against each end of each
declared range, then typechecks and runs the adapter.

**Why this is written down:** 0.4.2 shipped a peer narrowing, a new subpath, and
a behaviour change under a **patch** number, which every default version range
upgrades into automatically. It was unpublished within the 72-hour window and
re-released as 0.5.0. The rule it broke is the one in the table above.

## Limitations

- Not a hallucination detector. It measures *shape*, never truth.
- `REPETITION` does not work on Chinese, Japanese or Thai — a known, measured gap, not an oversight.
- `LANG_MISMATCH` is a function-word heuristic covering `id`/`en`/`es`/`pt`/`it`/`fr`/`de`/`nl`, and is unreliable under 25 words. `expectScript` is the stronger check wherever the alphabets differ.
- `expectLang: 'es'` does not reliably catch Portuguese, Italian or French: its profile is built from function words all four share. Measured, and unfixable without a threshold change — see **[docs/detectors.md](docs/detectors.md#answering-in-the-wrong-language)**.
- `PROMPT_ECHO` cannot tell a degenerate echo from a rewrite or translation — the difference is in what you asked for, not in the text.
- `SCRIPT_MISMATCH` and `PROMPT_ECHO` do not run mid-stream by default: both measure a property of the whole response, and a mid-stream check reads a trailing window. `earlyDocumentChecks: true` opts in, with a measured false-positive risk — see **[docs/streaming.md](docs/streaming.md)**.
- Tool *arguments* are measured only with `checkToolArguments: true`, non-streaming responses only.
- `openai`'s `responses.stream()` helper is not wrapped; `create({ stream: true })` is.
- Truncation from a missing full stop is weak evidence, scored 0.55 and deliberately left below the defaults. Lower `maxTruncation` to ~0.5 to catch it, and expect false positives.
- A JSON array of repeated identical records reads as a loop and fails from three records up. Set `redundancyScope: 'jsonValues'`.
- Thresholds are calibrated on the bundled corpus. Yours will differ — and the word and character thresholds need calibrating **separately**.

## License

MIT
