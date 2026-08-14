# Detector reference

Every detector, the signal it reads, and the function that exposes it on its own.

## Detectors

| Code | Catches | Signal | Exported as |
|---|---|---|---|
| `EMPTY` | Whitespace, lone punctuation, `{}`, empty fences | Content presence | `emptinessScore` |
| `TOO_SHORT` | Non-empty but useless | Length vs. minimum | `shortnessScore` |
| `REPETITION` | Loops and stutters | Duplicate word n-gram fraction | `repetitionScore` |
| `TAIL_LOOP` | Good start, then a stuck ending | Periodicity in the trailing window, over words or characters | `tailLoopScore`, `tailLoopDetail` |
| `LOW_ENTROPY` | Character-level collapse, token artifacts | Hand-rolled LZ77 compression ratio | `compressibilityScore`, `compressionRatio` |
| `TRUNCATED` | Cut off mid-thought | `finish_reason`, unbalanced fences/brackets | `truncationScore` |
| `INVALID_JSON` | Prose around the payload, missing keys, wrong types | Parse + key contract + optional schema | `jsonScore`, `stripFence` |
| `LANG_MISMATCH` | Answered in the wrong language | Function-word profile (coarse, opt-in) | `languageMismatchScore`, `languageProfile`, `supportedLanguages` |

Every detector is exported on its own if you only want one, and every name in
that last column is covered by semver — see **Stability**.

```ts
import { repetitionScore, tailLoopDetail, stripFence } from 'llm-output-guard';

repetitionScore(text);                  // 0..1, higher is worse
repetitionScore(text, { n: 4 });        // n-gram size
tailLoopDetail(text, { mode: 'char' }); // { score, mode } — which tokenizer ran
stripFence('```json\n{"a":1}\n```');    // '{"a":1}'
```

Each takes `(text, options?)` and returns a `0..1` score, with three exceptions
worth knowing: `shortnessScore(text, minChars)` takes its minimum positionally,
`stripFence` returns a string, and `jsonScore` / `tailLoopDetail` return a detail
object rather than a bare number. `supportedLanguages` is a value, not a
function — the array `['id', 'en', 'es']`.

#### Arrays of repeated records

A model asked for the status of twenty services and returning twenty identical
rows has done what it was told. Measured across the document that is a perfect
loop, so `TAIL_LOOP` reads **1.000** and the response fails — under every preset,
`lenient` included. Three identical records is enough, and an array that is only
75% repetitive fails on `REPETITION`.

The scores are not wrong; twenty identical records *are* exactly periodic. The
detectors are being asked about the wrong span. If your payloads look like this,
scope them:

```ts
checkOutput(raw, { ...presets.strictJson, redundancyScope: 'jsonValues' });
```

`REPETITION` and `TAIL_LOOP` then read each string value of a parsed payload on
its own — repetition **across records** is the shape you asked for, repetition
**inside a value** is the signal.

It is more sensitive, not less. A loop confined to one element of an array is
averaged away across a document and reads clearly on its own, so this closes a
false negative as well as a false positive. Text that does not parse is measured
as a document regardless, so prose, truncated payloads and every mid-stream check
are unaffected, as are the six non-redundancy detectors.

It is **opt-in**: switching it on by default would change which of your responses
get discarded, and this package treats that as a major.

---

---

[← Back to the README](../README.md) · [Try the playground](https://edwinsatya.github.io/llm-output-guard/)
