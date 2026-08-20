# Performance

What `checkOutput` costs, measured rather than asserted.

"Safe on a hot path" is a latency claim, and for most of this package's life
there was no latency figure anywhere near it. `npm run bench` reproduces
everything below; `npm run bench -- --json` emits it for tracking over time.

## A whole check

| `checkOutput(presets.chat)` | p50 | p99 |
|---|---|---|
| 500 B | 0.383 ms | 0.480 ms |
| 2 KB | 0.457 ms | 0.553 ms |
| 8 KB | 0.677 ms | 0.858 ms |
| 32 KB | 1.014 ms | 1.235 ms |

Sub-millisecond up to 8 KB, and just over it at 32 KB — which is a larger
response than most models will produce in one turn.

## One detector is most of the bill

| detector, 2 KB input | p50 |
|---|---|
| `LOW_ENTROPY` | 0.376 ms |
| `PROMPT_ECHO` | 0.111 ms |
| `SCRIPT_MISMATCH` | 0.066 ms |
| `REPETITION` | 0.048 ms |
| `TAIL_LOOP` | 0.026 ms |
| `LANG_MISMATCH` | 0.019 ms |
| `INVALID_JSON` | 0.006 ms |
| `TRUNCATED` | 0.002 ms |

`LOW_ENTROPY` is 0.376 ms against 0.19 ms for the other seven combined. The
hand-rolled LZ77 pass is doing that, and nothing else here is close.

`PROMPT_ECHO` is second because it is the only detector that reads two texts, so
its cost depends on the prompt as well as the response.

## The one lever

If you ever need this cheaper, there is exactly one thing to turn off:

```ts
checkOutput(raw, { ...presets.chat, maxCompressibility: null });
```

`presets.strictJson` already pulls it, for an unrelated reason — JSON is
legitimately repetitive at the character level, so the detector is not
meaningful there — and gets **0.082 ms against `chat`'s 0.457 ms** as a side
effect. Roughly 5×, from disabling one detector.

It is also why the streaming guard defers `LOW_ENTROPY` to the end rather than
running it every few hundred characters. See
[docs/streaming.md](./streaming.md), which documents the conditions that
deferral depends on.

## Reading these numbers honestly

They are wall-clock timings on one machine (Node 24, darwin/arm64), on an
idle-ish system, in one process with a warm JIT, over 500 runs after 200 warmup
iterations, on varied prose.

They are useful for **ratios between detectors** and for order of magnitude.
They are not a promise about your hardware, and the absolute values will differ
on CI, on a shared runner, and under a cold JIT. The ratios are the durable
part.

---

[← Back to the README](../README.md) · [Try the playground](https://edwinsatya.github.io/llm-output-guard/)
