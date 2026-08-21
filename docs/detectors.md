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
| `PROMPT_ECHO` | Returned your prompt instead of an answer | Share of output runs copied verbatim from the prompt (opt-in) | `promptEchoScore`, `promptEchoDetail` |

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

#### Structured output

```ts
const verdict = checkOutput(raw, {
  ...presets.strictJson,
  requiredKeys: ['score', 'notes', 'followUp'],
});

if (verdict.ok) use(verdict.json); // already parsed, fence stripped
```

`requiredKeys` only asks whether a name is present. A model returning
`{ "score": "very good" }` where you wanted a number satisfies it and still
breaks everything downstream that does arithmetic. Pass a **schema** to check the
shape rather than the spelling:

```ts
import { z } from 'zod';

const Review = z.object({
  score: z.number().min(0).max(10),
  notes: z.string(),
  followUp: z.array(z.string()),
});

const verdict = checkOutput(raw, { ...presets.strictJson, schema: Review });

if (verdict.ok) use(verdict.json); // parsed, validated, defaults applied
```

Any [Standard Schema](https://standardschema.dev) validator works — **Zod 4,
Valibot, ArkType**, or your own. The spec is types-only, so this costs an
interface and **no dependency**: your validator is one you already have, and
`llm-output-guard` still installs with nothing behind it.

On success `verdict.json` is the schema's *output*, so defaults, coercions and
transforms are applied and the value matches the type you declared. On failure
you get `INVALID_JSON` with the failing path in the message —
`score: Expected number, received string`. It is the same reason code as a
missing key or an unparseable payload because it wants the same handling: retry,
or fall through to another provider.

The two compose, and keys are checked first, so a missing key is still reported
as a missing key rather than as whatever the schema calls it.

> **The schema must validate synchronously.** `checkOutput` is synchronous by
> design — that is what makes it safe on a hot path — so a schema carrying an
> async refinement throws a `TypeError` telling you so, rather than silently
> passing. Everything Zod, Valibot and ArkType produce otherwise is synchronous.
> This is the one thing in the package that throws about your configuration; it
> still never throws about a response.

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
alphabet — Spanish from English — and pays for it: eight languages
(`id` `en` `es` `pt` `it` `fr` `de` `nl`), and unreliable under 25 words. Where
both apply, the script answer is the one to trust.

**A profile is not a frequency list.** The score is `(best - target) / best`
across every profile, so a word two languages both own raises `target` as much
as `best` and pushes the score toward zero. What separates languages is where
they spell the same idea differently, and that is what the profiles are built
from — `não`/`no`, `com`/`con`, `em`/`en`, `uma`/`una` for Portuguese against
Spanish; `il`/`el`, `di`/`de`, `che`/`que`, `gli` for Italian.

Every profile is built that way as of 1.7.0, `es` included. It used to hold the
twenty commonest Spanish function words — `de`, `que`, `por`, `para`, `no`,
`se`, `como` — which Portuguese, Italian and French all share, so a Portuguese
answer scored **0.36** against `expectLang: 'es'` and passed. Rebuilt around
where Spanish differs (`y`/`e`, `es`/`é`, `no`/`não`, `muy`/`muito`,
`cuando`/`quando`, `donde`/`onde`), the same answer scores **0.91**.

Measured over two unrelated sample sets, every language scores **0.000** against
itself and every cross-language pair scores **above the 0.6 default**.

#### Returning the prompt instead of an answer

```ts
checkOutput(raw, { ...presets.chat, prompt });
```

A model that replays your system prompt, your question, or the few-shot example
you included to demonstrate the format produces output that is non-empty, long
enough, not repetitive, properly terminated, in the right script and the right
language. **Every other detector here reads it as healthy**, correctly, because
by every measure they take it is. It happens most with quantised and self-hosted
models, and with a chat template that has drifted from the one the weights were
trained on.

Pass the whole prompt, system and user together. A model that loses the turn
boundary echoes whichever part it landed on, and a check that only knows the user
message misses a leaked system prompt.

**Runs, not similarity.** The question is not how similar two texts are, it is
how much of the output the model actually wrote. A good answer to a detailed
question reuses the question's vocabulary heavily and its *sequences* not at all,
so matching on runs of five words separates them cleanly:

```
full echo of the prompt                     1.000
echoed system prompt                        0.953
the question repeated, then an answer       0.463
the whole system prompt, then an answer     0.446
half the system prompt, then an answer      0.354
an answer that shares the question's words  0.060
a clean answer                              0.000
```

`maxPromptEcho` defaults to **0.6**: above everything that still contains an
answer, below every true echo. The score is a *share*, so a response that leaks
and then answers scores in the middle by design, and a longer answer dilutes the
same leak further. Lower it toward 0.4 to catch those too, and expect ordinary
preamble to come with them.

**It does not run mid-stream**, and the reason is sharper than for
`SCRIPT_MISMATCH`: the score is a share of the whole output, so a trailing window
measures the share of that window. The same leak-then-answer response reads 0.707
over its opening 400 characters and 0.446 across the document.

> **The false positive it cannot avoid.** Rewriting, translating, summarising,
> fixing grammar, extracting fields — copying from the input *is* the job, and a
> correct answer scores high. Nothing in the text separates that from a
> degenerate echo; the difference is in what you asked for. This is why the
> detector is opt-in, absent from every preset, and requires you to pass the
> prompt deliberately. **Do not enable it on a rewrite endpoint.**

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
