# llm-output-guard

## 0.3.0

### Minor Changes

- Add `llm-output-guard/ai-sdk`: `outputGuard()`, middleware for the Vercel AI SDK.

  One `wrapLanguageModel` call guards both `generateText` and `streamText`. On a
  stream it cancels the provider mid-generation — driven through the real SDK
  against a looping model, the provider was asked for 17 of 137 parts before the
  guard cut it off, and the rest was never generated or billed. On `generateText`
  the tokens are already spent, so it throws `DegenerateOutputError` instead.

  `onDegenerate` takes `'throw'` (default; also cancels the stream), `'abort'`
  (stop cleanly, keep what arrived) or `'ignore'`, and `onVerdict` reports every
  verdict either way, so a logging-only rollout is the default posture rather than
  an afterthought.

  `ai` is an optional peer dependency and the adapter is structurally typed rather
  than importing from it, so the package still has zero runtime dependencies and
  the main entry point still has no peers. `finishReason` is accepted as both the
  v2 string and the v4 `{ unified, raw }` object, so one adapter covers both specs.

  Also adds the `./package.json` export, which some tooling reads.

## 0.2.0

### Minor Changes

- Add streaming detection: `guardStream` and `createStreamGuard`.

  Checking a finished response only tells you that you already paid for it. A
  model that starts looping keeps going until `max_tokens`, billing you for every
  token and making you wait. These watch the response as it arrives and report
  degeneration early enough to abort the generation — 48-92% of the tokens on the
  degenerate fixtures, with none of the healthy ones tripping.

  Two things make it safe to leave on:

  - **Only the redundancy detectors run mid-stream.** Partial output really is
    short, really is cut off, and really is invalid JSON, so `TOO_SHORT`,
    `TRUNCATED`, `INVALID_JSON` and `LANG_MISMATCH` would fire on every healthy
    generation. They are deferred to `end()`, which runs the full check.
  - **Each check reads a trailing window, not the whole buffer**, so cost is
    ~0.05ms per check and flat as the stream grows rather than quadratic in its
    length. `LOW_ENTROPY` is deferred as well — at ~100x the cost of the other
    detectors it is affordable once per response and ruinous per check, and
    everything it catches early is caught by `REPETITION` regardless.

  The guard never aborts anything itself: it holds no `AbortController` and knows
  nothing about your transport. It tells you, and you decide.

## 0.1.1

### Patch Changes

- Stop `calibrate` from suggesting a threshold it cannot support, and correct the
  compressibility docs.

  Where every healthy fixture is pinned to the same floored score — `TAIL_LOOP`
  and `LOW_ENTROPY` both are — the healthy distribution carries no information
  about how close healthy output actually came, so half the margin was a number
  with nothing behind it. Those detectors now print `n/a` with the reason, and
  `LOW_ENTROPY` additionally reports the pre-clamp compression ratio spread,
  where the real separation is visible: healthy 0.670+, degenerate 0.203 and
  below, a true gap of 0.468.

  The `compressionRatio` doc claimed healthy prose lands at 0.30-0.55. Measured
  against the corpus it lands at 0.67-0.97, which would have misled anyone tuning
  `pivot`. No thresholds or scores changed.

- Treat a non-string response as an `EMPTY` verdict instead of throwing.

  `checkOutput(undefined)` previously threw a raw `TypeError` from the first
  detector. That broke the package's own documented use: a retry policy keyed on
  `err instanceof DegenerateOutputError` does not catch a `TypeError`, so a
  provider that "succeeded" while returning no text slipped through the guard
  entirely — the exact failure this package exists to catch.

  `checkOutput` and `assertOutput` now accept `string | null | undefined` and
  report the offending type in the reason message.

## 0.1.0

Initial release. Deterministic detection of degenerate LLM output that arrives
with a successful HTTP status.

Detectors for emptiness, shortness, n-gram repetition, tail loops, character-level
entropy collapse, truncation, JSON validity, and language mismatch. Ships
`checkOutput` (verdict) and `assertOutput` (throwing, for existing retry layers),
four calibrated presets, and a fixture corpus with deliberate false-positive traps.
