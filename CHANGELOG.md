# llm-output-guard

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
