# Provider adapters

One wrap per client. Every adapter drives the same `createStreamGuard`;
none of them reimplements it.

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

---

[← Back to the README](../README.md) · [Try the playground](https://edwinsatya.github.io/llm-output-guard/)

## Tool-call arguments

A tool-calling turn is judged by its preamble — the text beside the call — because
that text is not the answer. Which leaves the answer itself, the arguments,
unmeasured. Before 1.5 nothing here looked at them at all.

```ts
const client = withOutputGuard(new OpenAI(), {
  ...presets.chat,
  checkToolArguments: true,
});
```

Your provider already validates arguments against the schema you declared. That
covers **types**, not content — and a model that loops does not produce the wrong
type, it produces a valid string with nothing in it:

```json
{ "query": "site reliability engineering site reliability engineering …", "limit": 10 }
```

Schema-valid. Passes the provider. Reaches your tool as a garbage search, or,
if the tool writes, persists the loop.

**What is measured.** Redundancy only, per string value — `REPETITION` and
`TAIL_LOOP`, under the same thresholds your guard already uses. The reason codes
are unchanged so existing handling keeps working; the `message` says the loop was
found in an argument rather than in the prose.

**What is not, and why.** `LOW_ENTROPY` is off because JSON is legitimately
repetitive at the character level, the same reason `presets.strictJson` turns it
off. `TRUNCATED`, `TOO_SHORT` and `INVALID_JSON` are off because the provider
already guarantees the arguments parse and match your schema — they would be
answering a question that has been answered. `SCRIPT_MISMATCH` and
`LANG_MISMATCH` are off because an argument is not prose addressed to a user: a
search query in another language is ordinary, not degenerate.

Values are measured **individually**, never as a serialised document. Two calls
against the same schema are legitimately near-identical documents, and an array
of repeated records inside one argument is the shape that was asked for — the
same rule `redundancyScope: 'jsonValues'` follows, for the same reason.

**Nothing is measured when there is nothing to measure.** A tool that takes no
parameters is called with `{}`, and arguments carrying no strings at all — 
`{"lat":-6.2,"zoom":11}` — have no prose to judge. Both are skipped rather than
scored, so a no-argument tool does not fail on `EMPTY`.

**Non-streaming responses only.** Arguments arrive as JSON fragments that do not
parse until the call is complete, so there is nothing meaningful to measure
mid-stream.

Off by default. Switching it on can only make a response fail that previously
passed, so it is opt-in like every other behaviour change in this package.

## Prompt echo

`PROMPT_ECHO` catches a model that replays your prompt instead of answering it.
It needs the prompt, and a guard is configured once when you wrap the client
while the prompt changes on every call — so this is a switch rather than a
value, and the adapter reads the prompt out of each request it is already
forwarding.

```ts
const client = withOutputGuard(new OpenAI(), {
  ...presets.chat,
  checkPromptEcho: true,
});
```

Works on all three adapters, and each reads its own request shape:
`messages` for `chat.completions`, `instructions` plus `input` for `responses`,
`system` plus `messages` for Anthropic, and the spec's normalised `params.prompt`
for the AI SDK. Content is read whether it is a plain string or a list of parts;
non-text parts (images, audio, files) contribute nothing, which is correct — they
are not text the model could echo back.

**Prior assistant turns are excluded.** The failure being measured is a model
replaying its *input*, and a model that keeps its terminology consistent across a
long conversation is doing its job. Counting its own earlier answers would make
that look worse the longer the conversation ran. Nothing is lost: a model that
loses the turn boundary and replays the whole transcript replays the system and
user text too.

**An explicit `prompt` in the options wins.** If you have a fixed system prompt
and prefer to state it once when wrapping the client, the adapter does not
override it.

**On a stream the check runs at the end**, not on the mid-stream windows,
because the score is a share of the whole output and a trailing window measures
the share of that window. See
[docs/detectors.md](./detectors.md#returning-the-prompt-instead-of-an-answer)
for the numbers.

> **Do not enable this on a rewrite, translate, summarise or extract endpoint.**
> Copying from the input is the job on those, so a correct answer scores high and
> the detector measures the task rather than a failure.
