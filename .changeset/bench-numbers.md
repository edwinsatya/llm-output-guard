---
"llm-output-guard": patch
---

Add `npm run bench`, and publish what `checkOutput` actually costs.

Documentation and tooling only. No behaviour changed, no threshold moved, no
export added.

The README has called this package "safe on a hot path" since 0.1, which is a
latency claim, and there was no latency figure anywhere near it. The only
numbers that existed were in a comment in `stream.ts`, cited to justify
deferring `LOW_ENTROPY` off the mid-stream path.

```
checkOutput(presets.chat)      p50        p99
  500 B                     0.383ms    0.480ms
  2 KB                      0.457ms    0.553ms
  8 KB                      0.677ms    0.858ms
  32 KB                     1.014ms    1.235ms
```

The breakdown is the useful part. At 2 KB, `LOW_ENTROPY` is **0.376 ms** and the
other six detectors together are **0.081 ms** — the LZ77 pass is roughly 80% of
the cost of a full check. So there is exactly one latency lever in this package,
and `presets.strictJson` already pulls it: it sets `maxCompressibility: null`
because JSON is legitimately repetitive, and measures 0.082 ms against `chat`'s
0.457 ms as a side effect.

`npm run bench` prints the table; `npm run bench -- --json` emits it for tracking
over time. The script documents why its own absolute numbers should not be
quoted as a promise: they are wall-clock timings on one machine with a warm JIT,
and the ratios between detectors are the part that travels.
