---
"llm-output-guard": minor
---

New opt-in detector: `SCRIPT_MISMATCH`, for a model that answered in the wrong
alphabet.

```ts
checkOutput(raw, { ...presets.chat, expectScript: 'latin' });
```

A model that ignores "answer in English" does not return broken English, it
returns fluent Chinese — with a `200 OK`. `LANG_MISMATCH` was the only thing
here that looked at language, and it is the weakest detector in the package by
its own admission: three languages, a function-word list, and unreliable under
25 words. It cannot see this failure at all for Chinese, Japanese, Korean,
Russian, Arabic, Hindi, Greek, Hebrew or Thai, because it does not know those
languages.

Counting characters answers the easier question — *is this even the right
alphabet* — and answers it with no word list and no minimum a two-sentence reply
cannot meet. Measured on this repo's corpus:

```
full answer in the wrong script, against expectScript: 'latin'
  zh 1.000   ja 1.000   ko 1.000   ru 1.000   ar 1.000
  hi 1.000   el 1.000   he 1.000   th 1.000

healthy response against the script it is written in
  0.000 – 0.028      (0.028 is Korean prose quoting Latin API names)
```

The default `maxScriptMismatch` is **0.5**, sitting between those with room on
both sides. The worst healthy case anyone constructed — an English answer that
quotes a long Chinese passage — scores 0.184, and is now a corpus fixture.

**Code fences, inline code and URLs are stripped before measuring.** Every
identifier in a TypeScript block is Latin because TypeScript is, and counting
them is how a correct Chinese answer gets discarded: the new
`prose-zh-with-code-fence` fixture scores 0.000 as shipped and 0.632 with
`ignoreCode` disabled. A response that is *only* a code block abstains entirely.

**Pass every script the answer may legitimately contain** — `['han', 'latin']`
for Chinese, `['han', 'kana', 'latin']` for Japanese. Kana alone scores 0.314 on
healthy Japanese prose, because Japanese uses both.

**It is a separate code from `LANG_MISMATCH`, not a replacement for it.** Spanish
against English scores 0 here and is exactly what the function-word profile is
for. The two compose, report separate scores, and are calibrated separately — a
share of letters and a relative share of function-word hits are different
distributions, and one histogram holding both describes neither. `calibrate`
learned `maxScriptMismatch` accordingly.

**It does not run mid-stream, deliberately.** Which language a model answered in
is a property of the whole response, and a mid-stream check reads a trailing
window. On the English-quoting-Chinese shape: 0.114 across the document, 0.206
over the last 1000 characters, 0.500 over the last 400 — the document is healthy
and the window says it is half wrong. The early signal is one line for anyone who
wants it, and `stream.ts` documents it:

```ts
const verdict = checkOutput(guard.text, { expectScript: 'latin' });
```

Off in every preset, so nothing changes for an existing caller who does not ask
for it. New exports: `scriptMismatchScore`, `scriptProfile`, `supportedScripts`,
and the types `ScriptName` and `ScriptOptions`.

One thing to know before upgrading: `ReasonCode` gained a member. That is a
minor under this package's own rule for an opt-in detector, and it is still a
compile error for a consumer who switches exhaustively over `ReasonCode` with a
`never` fallback.
