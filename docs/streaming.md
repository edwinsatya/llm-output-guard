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
