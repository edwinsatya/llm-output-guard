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

## Agent runs

`checkTrace` and `createAgentGuard` read a different axis and cost differently:
the work scales with the size of the **tool arguments** a model passes, not with
the length of any response. Measured over a 12-turn window carrying 9 KB of
arguments per turn — a file edit, which is the expensive end of realistic:

| | p50 | p99 |
|---|---|---|
| `checkTrace`, 12 tool turns | 0.069 ms | 0.118 ms |
| `guard.observe()`, steady state | 0.075 ms | 0.163 ms |
| `checkTrace`, 12 prose turns | 0.003 ms | 0.006 ms |

The prose row is the shape of the cost: with no arguments to canonicalise, the
same twelve turns are twenty times cheaper. Argument size is the lever here, the
way `LOW_ENTROPY` is the lever on a single response.

**`observe()` does redundant work, and it is left in.** It re-fingerprints every
retained turn on each call rather than caching, so it repeats the window's work
per turn — about 14× one turn's fingerprint at these settings. That was measured
before it was defended: 0.075 ms per turn means a 200-turn agent run spends
**15 ms** in the guard, against 200 model calls that take seconds each. A cache
would buy nothing you can observe and would put an invalidation question into a
hot path, so the redundancy stays and this paragraph exists instead.

## Size

Measured the way a bundler sees it — each entry bundled, minified and gzipped,
which is not the size of `dist/index.js`. That file is code-split and re-exports
from shared chunks, so on its own it reads about a third of the truth.

| Entry | min+gzip |
|---|---|
| `llm-output-guard` | 6.1 KB |
| `./openai` | 6.7 KB |
| `./anthropic` | 6.4 KB |
| `./google` | 6.6 KB |
| `./ai-sdk` | 5.9 KB |
| `./agent` | 2.2 KB |

An adapter subpath is *not* additive with the root: it bundles the detectors it
needs, so importing both costs about what the larger one costs alone. `./agent`
is the small one because it shares almost nothing with the per-response
detectors — a different axis, and nearly a different package.

`npm run size` reproduces the table and **fails over budget**. The budgets sit
about 15% above these figures, and raising one is a deliberate act with a diff,
because the README quotes this number on its front page and a figure in prose is
the cheapest thing in a repo to go stale. This one had drifted 24% before
anything noticed — while the bundlejs badge two lines above it showed the real
figure the whole time.

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
