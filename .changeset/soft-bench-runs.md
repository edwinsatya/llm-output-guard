---
'llm-output-guard': patch
---

`npm run bench` covers the cross-turn path, and `docs/performance.md` reports it.

The README has claimed sub-millisecond since 1.0, and since 1.9.0 that claim had
an uncovered public hot path: `checkTrace` and `createAgentGuard` read a window
of turns rather than a span of text, so none of the existing numbers described
them. Their cost scales with the size of the **tool arguments** a model passes,
not with the length of any response — a different lever from the one the rest of
the document is about.

Over a 12-turn window carrying 9 KB of arguments per turn: `checkTrace` 0.069 ms
p50, `observe()` 0.075 ms, and the same twelve turns as prose 0.003 ms. That last
row is the shape of it — with no arguments to canonicalise the same trace is
twenty times cheaper.

Also written down: **`observe()` does redundant work and it is staying.** It
re-fingerprints every retained turn per call rather than caching, repeating the
window's work each time — about 14x one turn's fingerprint. Measured before it
was defended: 0.075 ms per turn is 15 ms across a 200-turn run, against 200 model
calls that take seconds each. A cache would buy nothing observable and would put
an invalidation question into a hot path.
