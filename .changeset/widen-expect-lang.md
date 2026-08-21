---
"llm-output-guard": minor
---

`expectLang` grows from three languages to eight: `pt`, `it`, `fr`, `de` and
`nl` join `id`, `en` and `es`.

`SCRIPT_MISMATCH` covers every cross-alphabet case, which left the same-alphabet
half — the one that has to tell French from Portuguese — knowing three
languages, none of which are the ones most often confused with each other.

## A profile is not a frequency list

The score is `(best - target) / best` across every profile, so a word that two
languages both own raises `target` as much as `best` and pushes the score toward
zero. Building a profile from a language's *commonest* function words therefore
builds the worst possible profile: those are exactly the words its neighbours
share.

The new profiles are built from where neighbouring languages differ instead —
`não`/`no`, `com`/`con`, `em`/`en`, `uma`/`una`, `do`/`del` for Portuguese
against Spanish; `il`/`el`, `di`/`de`, `che`/`que`, `gli`, `più` for Italian;
`les`, `des`, `du`, `dans`, `avec`, `cette` for French.

Measured over two unrelated sample sets per language: every language scores
**0.000** against itself, and every expectation other than `es` scores **0.70 or
better** against every other language.

## `expectLang: 'es'` is the weak expectation, and it stays that way

The `es` profile predates that rule and is built from precisely the generic
Romance words it warns against — `de`, `que`, `por`, `para`, `no`, `se`, `como`
— which hit Portuguese, Italian and French text nearly as hard as they hit
Spanish. Across the two sample sets:

```
pt 0.36 / 0.50     it 0.83 / 0.33     fr 0.30 / 0.33
```

Those sit under the 0.6 default, so **`expectLang: 'es'` does not reliably catch
Portuguese, Italian or French**, and `expectScript` cannot help because all four
share the Latin alphabet. It still catches English, Indonesian, German and Dutch
comfortably.

Re-choosing the `es` profile would fix it and is a behaviour change, so it waits
for a major. The limitation is documented in the README, in `docs/detectors.md`,
and asserted in tests so it cannot be mistaken for a bug later or quietly get
worse.

## The regression that did not happen

Adding a profile adds a candidate for `best`, so a new language that out-scored
`en` on English text would have started failing healthy English responses. All
three original languages still score 0.000 on their own text across both sample
sets, and there is a test that says so.

`supportedLanguages` now reads `['id', 'en', 'es', 'pt', 'it', 'fr', 'de', 'nl']`.
Still opt-in, still absent from every preset.
