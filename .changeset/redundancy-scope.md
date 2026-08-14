---
'llm-output-guard': minor
---

Add `redundancyScope`, which stops a JSON array of repeated records being read as
a loop.

A model asked for the status of twenty services and returning twenty identical
rows has done exactly what it was told. Measured across the document that is a
perfect loop, and 1.2.1 scores it `TAIL_LOOP: 1.000` and fails it under **every
preset — `lenient` and `strictJson` included**. Three identical records is enough
to trip it, and an array that is only 75% repetitive fails on `REPETITION`.
`strictJson` is the preset most likely to be pointed at exactly that payload.

The scores were never wrong: twenty identical records *are* exactly periodic. The
detectors were being asked about the wrong span.

```ts
checkOutput(raw, { ...presets.strictJson, redundancyScope: 'jsonValues' });
```

Under `'jsonValues'`, `REPETITION` and `TAIL_LOOP` read each string value of a
parsed payload on its own, on the rule that repetition **across records** is the
shape that was requested and repetition **inside a value** is the signal.

**It is more sensitive, not less.** A loop confined to one element of an array is
averaged away across a document — 1.2.1 misses a 30× repeated Chinese clause
sitting in one of five array items entirely — and reads 1.000 when that element
is measured alone. So this removes a false positive and closes a false negative
in the same change.

Text that does not parse is measured as a document regardless, so prose, a
truncated payload and every mid-stream check behave exactly as before. Only the
two redundancy detectors are scoped; `LOW_ENTROPY`, `TRUNCATED`, `INVALID_JSON`,
`EMPTY`, `TOO_SHORT` and `LANG_MISMATCH` read the whole response as they always
have.

The default stays `'document'`, and that default is asserted byte-identical to
the published 1.2.1 tarball across all 228 fixture × preset combinations —
compared against the release, not against itself. No preset or threshold changed.

Left opt-in rather than made the default deliberately. Switching it on by default
would change which production responses get discarded, which this package's
stability table calls a major, and 1.0.0 shipped four days ago.
