# Streaming

Catching degeneration mid-response, so a loop stops costing you tokens.

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

---

[← Back to the README](../README.md) · [Try the playground](https://edwinsatya.github.io/llm-output-guard/)

## Judging the whole response, early

`SCRIPT_MISMATCH` and `PROMPT_ECHO` are deferred to `end()` by default. Both
measure a property of the whole response, and a mid-stream check reads a
trailing window — so what a window would measure is the language of a window,
not of the response.

`earlyDocumentChecks: true` gives them the right span instead: the buffer so
far, rather than the window.

```ts
const guarded = guardStream(model.textStream, {
  ...presets.chat,
  expectScript: 'latin',
  earlyDocumentChecks: true,
  onDegenerate: () => controller.abort(),
});
```

**What you buy is tokens.** A model answering in the wrong language commits to
it in its first sentence, so this aborts at around 600 characters instead of
after the whole response is paid for.

### Why it is off by default

The buffer is a **prefix**, and a prefix over-reports both detectors, because a
response that opens with a quotation in another script — or leaks the prompt
before answering — is at its worst when the least of it has arrived. Measured
on exactly those shapes:

```
                                                240   640  1040  1440   final
opens with a Chinese quote, then English       1.00  0.42  0.26  0.19   0.186
a long English preamble, then Chinese          1.00  0.66  0.39         0.359
leaks the prompt, then answers at length       0.00  0.54  0.33  0.24   0.093
```

Every one of those is healthy, and every one reads as **totally degenerate** at
240 characters — the guard's own warmup.

So a prefix is only allowed to condemn a response it is entirely wrong about:

- nothing is judged below **600 characters**, and
- the bar is **0.9**, whatever threshold you configured. A lowered
  `maxScriptMismatch` applies at `end()`, not to a prefix.

Even then the worst healthy case above reads 0.66 against a bar of 0.9. That
margin is 0.24, which is why this is opt-in and why `end()` remains the default:
it catches all of these with no such risk.

### What it costs

Bounded, and deliberately so. The first version re-scanned the whole buffer on
every check, taking a 32,000-character stream from 9.06 ms to **65.48 ms** — the
quadratic cost `window` exists to prevent, reintroduced by a second span with no
window of its own.

Both detectors read only the first `maxSample` characters, so past that the
score is frozen and re-checking cannot change it. The span is capped there,
checks stop once it saturates, and until then they run on a doubling schedule:

| stream | off | on |
|---|---|---|
| 2 KB | 1.21 ms | 1.12 ms |
| 8 KB | 3.36 ms | 4.29 ms |
| 32 KB | 8.99 ms | 10.46 ms |
| 128 KB | 32.03 ms | 33.99 ms |

A stream of any length gets about five of these checks, not one per check.
