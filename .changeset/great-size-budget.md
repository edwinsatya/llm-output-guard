---
'llm-output-guard': patch
---

`npm run size` — the front-page size claim, measured and enforced.

The README said **~5 KB gzipped**. The root entry measures **6.1 KB** min+gzip,
so the claim had drifted 24% — while the bundlejs badge two lines above it
displayed the real figure the whole time. A number in prose is the cheapest
thing in a repo to go stale: it is written once, true once, and nothing fails
when it stops being.

So it is a budget now, asserted in CI beside the zero-dependency check, for the
same reason that one exists.

```
  entry         min+gzip    budget
  .               6.1 KB     7.0 KB
  ./openai        6.7 KB     7.6 KB
  ./agent         2.2 KB     2.7 KB
```

**Measured the way a bundler sees it**, which is not the size of
`dist/index.js`: that file is code-split and re-exports from shared chunks, so
on its own it reads about a third of the truth. Each entry is bundled and
minified first.

Two things the table says that prose had not. An adapter subpath is **not
additive** with the root — it bundles the detectors it needs, so importing both
costs about what the larger costs alone. And `./agent` is a quarter the size of
everything else because it shares almost nothing with the per-response
detectors: a different axis, and very nearly a different package.

Budgets sit ~15% above today's figures, so ordinary changes do not trip them
while a dependency creeping in would. Raising one is a deliberate act with a
diff, and the README sentence moves with it.
