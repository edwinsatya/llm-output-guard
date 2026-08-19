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
| `SCRIPT_MISMATCH` | Answered in the wrong alphabet | Share of letters outside the expected scripts (opt-in) | `scriptMismatchScore`, `scriptProfile`, `supportedScripts` |
| `LANG_MISMATCH` | Answered in the wrong language, same alphabet | Function-word profile (coarse, opt-in) | `languageMismatchScore`, `languageProfile`, `supportedLanguages` |

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
object rather than a bare number. `scriptMismatchScore(text, expected)` takes its
expectation positionally. `supportedLanguages` and `supportedScripts` are values,
not functions — the arrays `['id', 'en', 'es']` and `['latin', 'han', 'kana',
'hangul', 'cyrillic', 'arabic', 'devanagari', 'greek', 'hebrew', 'thai']`.

#### Answering in the wrong language

Two detectors, and they are asking different questions.

```ts
checkOutput(raw, { ...presets.chat, expectScript: 'latin' });        // wrong alphabet
checkOutput(raw, { ...presets.chat, expectLang: 'en' });             // wrong language
checkOutput(raw, { ...presets.chat, expectScript: 'latin', expectLang: 'en' }); // both
```

`SCRIPT_MISMATCH` counts letters. It needs no word list, is decisive from about
a dozen letters, and covers every script in the table above. On this repo's
corpus a response answered entirely in the wrong script scores **1.000**, and a
healthy response measured against its own script scores **0.000–0.028**.

`LANG_MISMATCH` reads function words. It distinguishes languages that share an
alphabet — Spanish from English — and pays for it: three languages, and
unreliable under 25 words. Where both apply, the script answer is the one to
trust.

They report **separate codes and separate scores** on purpose. A share of
letters and a relative share of function-word hits are different distributions,
and one histogram holding both describes neither.

**Pass every script an answer may legitimately contain.**

| You asked for | Pass |
|---|---|
| English, Spanish, Indonesian, Vietnamese… | `'latin'` |
| Chinese | `['han', 'latin']` |
| Japanese | `['han', 'kana', 'latin']` |
| Korean | `['hangul', 'latin']` |
| Russian, Arabic, Hindi, Greek, Hebrew, Thai | `['cyrillic' \| 'arabic' \| …, 'latin']` |

`'latin'` belongs in almost all of them: a Chinese answer about React still
contains `useEffect`, and a Korean technical answer quotes Latin API names. It
costs nothing — including it only widens what counts as acceptable.

**Code fences, inline code and URLs are removed before measuring**, because
every identifier in a TypeScript block is Latin regardless of what language the
answer is in. The corpus carries this exact trap: a correct Chinese answer with
a TypeScript block scores 0.000, and 0.632 with `ignoreCode` disabled. A
response that is *only* a code block has no opinion about language and abstains
entirely.

The detector abstains — scores 0 — below 12 letters, on an unknown script name,
and on text with no letters at all.

**It does not run mid-stream.** Which language a model answered in is a property
of the whole response, and a mid-stream check reads a trailing window. Measured
on an English answer that ends by quoting a Chinese passage: 0.114 across the
document, 0.206 over the last 1000 characters, 0.500 over the last 400. The
document is healthy and the window says it is half wrong. If you want the early
signal — and it is a good one, since a model picks its language in the first
tokens — read the buffer yourself:

```ts
const verdict = checkOutput(guard.text, { expectScript: 'latin' });
```

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
