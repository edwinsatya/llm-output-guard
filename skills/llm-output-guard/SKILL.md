---
name: llm-output-guard
description: "Wire the llm-output-guard package into a codebase to catch LLM responses that fail while returning 200 OK — loops, empty replies, truncation, wrong language, unparseable JSON, and agent runs that stop advancing. Use this skill whenever the user wants to validate, guard, check or sanity-check model output; whenever they describe a model that repeats itself, returns nothing, gets cut off, answers in the wrong language, or produces JSON their parser rejects; whenever they want to retry or fall back to another provider on a bad response; and whenever an agent loop is spinning, stuck, or burning tokens without progress. It applies even when the user never names the package — if they are adding reliability, retries, fallbacks or quality checks around an LLM call, read this first, because the package has several defaults whose wrong choice silently disables the guard."
---

# Wiring llm-output-guard

This package produces the signal a retry layer is missing. Retries watch for
`429`, `5xx` and timeouts; they cannot see a model that looped until
`max_tokens`, returned `{}`, stopped mid-sentence, or answered in the wrong
language, because all of those arrive as a **successful request**.

Your job when this skill triggers is to wire it in **correctly**. The API is
small and the types will guide you. What the types cannot tell you is that
several reasonable-looking choices silently switch the guard off — those are
the parts this document exists for. Read "Traps" before writing code.

## Install

```bash
npm i llm-output-guard
```

Zero runtime dependencies. Node ≥ 18, and it works on edge, browser, Deno and
Bun. Provider SDKs are optional peers — the adapters are structurally typed, so
nothing new is installed for them.

## Step 1 — pick the entry point

Ask what the user is actually guarding. Three different questions, three
different imports:

| The user has | Use | Import from |
|---|---|---|
| a string of model output, anywhere | `checkOutput(text, options)` | `llm-output-guard` |
| a provider SDK client they call | `withOutputGuard(client, options)` | `llm-output-guard/openai` · `/anthropic` · `/google` |
| the Vercel AI SDK | `outputGuard(options)` as middleware | `llm-output-guard/ai-sdk` |
| an agent loop that runs many turns | `createAgentGuard()` | `llm-output-guard/agent` |

The adapter is usually the right answer when they own the call site — it guards
every response through that client, including streams, with one wrap. Reach for
bare `checkOutput` when the text arrives from somewhere they do not control (a
queue, a log, another service).

**The adapter and the agent guard solve different problems and compose.** The
adapter judges each response; the agent guard judges the *run*. An agent that
calls the same tool six turns running produces six individually healthy
responses — `checkOutput` scores every one of them 0.000, correctly. If the user
is debugging a stuck agent, they need `./agent`, not a stricter preset.

## Step 2 — wire it

### A string

```ts
import { checkOutput, presets } from 'llm-output-guard';

const verdict = checkOutput(text, presets.chat);
if (!verdict.ok) {
  log.warn({ scores: verdict.scores, modes: verdict.modes });
  return fallbackProvider(prompt);
}
```

`verdict.reasons` is an array of failures, one object each with `code`, `score`,
`threshold` and `message`. `verdict.scores` is an object keyed by code that
includes the detectors that **passed** — that is the one to log, because it is
what turns shipped thresholds into the user's own thresholds later.

### A provider client

```ts
import OpenAI from 'openai';
import { withOutputGuard } from 'llm-output-guard/openai';
import { presets } from 'llm-output-guard';

const client = withOutputGuard(new OpenAI(), presets.chat);
```

One wrap covers non-streaming and streaming, and on a stream it cancels the
upstream request the moment a loop is detectable — so the tokens after that
point are never generated. `./anthropic` and `./google` take the same shape.

This is also how to guard **Groq, Together, OpenRouter, Fireworks, DeepInfra,
vLLM, Ollama's OpenAI-compatible endpoint, Azure OpenAI and Mistral** — anything
reached through an OpenAI-compatible client works through `./openai`.

### An agent loop

```ts
import { createAgentGuard } from 'llm-output-guard/agent';
import { toTurn } from 'llm-output-guard/openai';

const guard = createAgentGuard();

while (!done) {
  const completion = await client.chat.completions.create(params);
  const verdict = guard.observe(toTurn(completion));
  if (!verdict.ok) break;  // the run is circling; stop paying for it
}
```

Use `toTurn` from the matching adapter subpath rather than building the turn by
hand — see the traps below for why that matters more than it looks.

## Traps

These are the mistakes that produce a guard which runs, reports, and stops
nothing. Each one has been made in real code, including in this package's own
documentation.

### `onDegenerate: 'abort'` does not stop a non-streaming call

`'abort'` ends a **stream** and keeps what arrived. A `chat.completions.create()`
has no stream to end, so the guard measures the response, reports it, and hands
it back.

| | non-streaming call | stream |
|---|---|---|
| `'throw'` (**default**) | fails the call with `DegenerateOutputError` | fails it *and* cancels the request |
| `'abort'` | reports only, **returns the response** | ends the stream, keeps what arrived |
| `'ignore'` | reports only | reports only |

`'throw'` is the default, so the shortest correct wrap passes no `onDegenerate`
at all. Reach for `'abort'` only on a stream where a partial answer beats no
answer. If you find yourself writing `onDegenerate: 'abort'` on a plain
completion, you have written a guard that cannot fail anything.

### Hand-mapping an agent turn fails silently

`AgentTurn` is `{ text, toolCalls: [{ name, arguments }] }` and it is tempting to
build it inline. Reach into the wrong field — `arguments` instead of
`function.arguments`, `args` instead of `input` — and nothing throws or warns.
Every turn fingerprints differently, `AGENT_LOOP` reports 0.000 for the life of
the process, and the user has a guard they believe in and do not have.

`toTurn` ships from all four adapter subpaths and carries the provider knowledge
that goes with it: both OpenAI APIs and the legacy `function_call` spelling,
Anthropic's server tools with thinking blocks excluded, Gemini's thought
summaries excluded, the AI SDK's two shapes.

### A turn with tool calls is judged by its arguments, never its prose

This is the rule that makes the agent guard usable, and it is worth telling the
user about when they ask why a run passed:

```
"Let me check the next file."   read_file { path: "src/a.ts" }
"Let me check the next file."   read_file { path: "src/b.ts" }
"Let me check the next file."   read_file { path: "src/c.ts" }
```

Word-for-word identical prose, and the agent is working perfectly. The arguments
carry the progress, so the arguments are what is measured.

### Polling looks exactly like a loop

A tool whose job is to be called repeatedly with identical arguments — a job
poller, a sleep, a clock — is indistinguishable from a loop by shape. There is
no signal that separates them, so name them:

```ts
createAgentGuard({ ignoreTools: ['get_job_status', 'sleep'] });
```

### `PROMPT_ECHO` must not be pointed at a rewrite endpoint

Rewriting, translating, summarising, fixing grammar, extracting fields: copying
from the input *is* the job on all of those, so a correct answer scores high.
Nothing in the text separates that from a degenerate echo — the difference is in
what was asked for. It is opt-in and absent from every preset for this reason.

It also **abstains under 40 word tokens**, so a short prompt echoed perfectly
scores 0.000 rather than 1.000. If the user tries it by hand with a one-line
prompt and reports it broken, that is why.

### `expectScript` needs every script the answer may legitimately contain

```ts
checkOutput(raw, { ...presets.chat, expectScript: ['han', 'latin'] });
```

Japanese needs `['han', 'kana']`. A technical answer in any non-Latin script
usually wants `'latin'` alongside it, because a Chinese answer about React still
contains `useEffect`. Passing one script where two are legitimate produces a
false positive on healthy output.

## Step 3 — roll out in the right order

Do not enable enforcement on day one. The shipped presets are calibrated against
this package's own fixture corpus, which is **not the user's traffic**, and a
threshold that is slightly wrong for their distribution throws away good
responses. Wire it in this order and say so when you hand the work over:

1. **Observe.** `onDegenerate: 'ignore'` with an `onVerdict` that logs
   `verdict.scores` and `verdict.modes` to wherever they keep metrics.
2. **Calibrate** once a representative sample has accumulated:
   ```bash
   npx llm-output-guard check logs/*.jsonl --jsonl --json \
     | npx llm-output-guard calibrate --fpr 0.001
   ```
   For agent runs, `check --trace` reads one run per line and accepts a raw
   `messages` array, so whatever the agent already logs is probably the right
   shape. Add `--ignore-tools` before calibrating if anything polls, or the
   sample is poisoned by the false positives that option removes.
3. **Enforce** with the thresholds the report suggests.

Log `modes` next to `scores`. `TAIL_LOOP` measures words on spaced scripts and
characters on Chinese, Japanese and Thai; those are different distributions, and
pooled into one histogram they describe neither.

## What it cannot do

Be straight with the user about these rather than letting them discover it in
production. Claiming more than the package does is worse than not using it.

- **It is not a hallucination detector.** It measures *shape*, never truth. It
  cannot tell you the model was wrong; it can tell you the model stopped
  producing language.
- **`REPETITION` is blind on Chinese, Japanese and Thai.** A word tokenizer sees
  a whole clause as one token there. `TAIL_LOOP` switches to character mode and
  covers it, but fires at around ten repeats rather than three.
- **An agent circling without repeating exactly is not detected** — `build`,
  read a file, `build`, read another. It has no exact cycle, and the only signal
  that reads it cannot be separated from a healthy edit/test rhythm.
- **Thresholds are not universal.** See step 3.

## Choosing a preset

`chat` · `strictJson` · `longForm` · `lenient` — starting points, not truths.
`strictJson` sets `expectJson` and turns `LOW_ENTROPY` off, because JSON is
legitimately repetitive at the character level. `longForm` has a 200-character
minimum that will fail every short answer, so do not reach for it as a generic
"stricter" setting.

Spread a preset and override rather than building options from scratch, so the
calibrated relationships between thresholds survive:

```ts
checkOutput(raw, { ...presets.strictJson, schema: z.object({ score: z.number() }) });
```

Any Standard Schema validator works — Zod, Valibot, ArkType — and the spec is
types-only, so this still costs no dependency. On success `verdict.json` is the
schema's output, with defaults and coercions applied.

## Further reading

The package's own docs are unusually detailed and carry the measurements behind
every default. Point the user at them rather than guessing at numbers:

- `docs/detectors.md` — every detector, with the data behind each threshold
- `docs/adapters.md` — per-provider behaviour and the streaming table
- `docs/agent-loops.md` — the cross-turn detector and its limits
- `docs/calibration.md` — how to derive thresholds from the user's own traffic
