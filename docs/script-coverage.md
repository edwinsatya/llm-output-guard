# Script coverage

What works on Chinese, Japanese and Thai, what does not, and the measurements
behind both.

## Script coverage

The dividing line is **whether a script puts spaces between words**, not whether
it is Latin. Korean, Cyrillic, Greek, Arabic and Devanagari all separate words
and are handled exactly like English. Han, Hiragana, Katakana and Thai do not,
and get different treatment:

| | Chinese / Japanese / Thai | Everything else |
|---|---|---|
| `TAIL_LOOP` | **Character mode**, `maxCharTailLoop` (default 0.7) | Word mode, `maxTailLoop` (default 0.5) |
| `REPETITION` | **Blind — see below** | Word n-grams, works |
| `LOW_ENTROPY`, `TRUNCATED`, `INVALID_JSON`, `EMPTY`, `TOO_SHORT` | Character- or structure-based, unaffected | Same |
| `SCRIPT_MISMATCH` | **Covered** — `expectScript: ['han', 'kana', 'thai', …]` | Covered, all ten scripts |
| `LANG_MISMATCH` | Not covered (`id`/`en`/`es` only) | `id`/`en`/`es` only |

Mode is chosen per detector, from the span that detector actually reads — so a
reply that answers in English and then loops in Chinese puts the *tail* detector
into character mode without moving anything else. It is reported in
`Verdict.modes`.

**`REPETITION` is blind on these scripts, and we could not fix it.** A word
tokenizer sees a punctuation-delimited Chinese clause as one token, and a loop
with no punctuation as one token for the entire response, so it scores 0.000 on
an obvious loop. A character n-gram fallback was built, measured, and rejected —
because **it would add no coverage and cost a false-positive surface**.

It adds nothing because `TAIL_LOOP`'s character mode already catches every
degenerate non-Latin sample in the corpus, at a margin of 0.538.

It costs something because healthy *structured* CJK output scores high under it.
Repeated key scaffolding around short CJK values is genuinely redundant
character-by-character:

```
healthy json-zh-keys-valid, char n-grams (n=4), all items distinct
   8 items  0.396     20 items  0.543     40 items  0.597
  12 items  0.474     30 items  0.577
```

That flattens rather than diverging — it converges on the scaffolding's own
proportion — so a threshold does exist. But the plateau near 0.6 against the
weakest pure loop at 0.872 leaves about **0.19**, under the 0.2 margin this
package holds itself to, and the healthy side climbs with the number of keys a
payload carries. A detector with nothing to add and a structure-sensitive margin
is a false positive waiting for someone's payload shape to change, which is the
wrong trade here.

`TAIL_LOOP`'s character mode covers the gap in practice — it requires *exact*
periodicity, which scaffolding never produces, and it catches every degenerate
non-Latin sample in the corpus. But a mid-response CJK loop that recovers before
the end is not detected by anything here. If that is your failure mode, log
`LOW_ENTROPY` and threshold it yourself.

Two more things worth knowing:

- **Character mode abstains below 80 characters.** Three identical short
  sentences closing a 40-character reply look like total coverage and are not
  evidence of anything.

### Character mode is deliberately slower to fire

The two modes do not flag the same shape at the same point, and the gap is
large. Taking the clearest case — a response ending in an identical repeated
line — measured on both:

| Repeats of an identical closing line | English (`maxTailLoop` 0.5) | Chinese (`maxCharTailLoop` 0.7) |
|---|---|---|
| 3 | **flagged** (0.563) | 0.000 — under the 80-character floor |
| 5 | flagged (0.682) | 0.000 |
| 9 | flagged (0.794) | 0.686 |
| 10 | flagged (0.811) | **flagged** (0.708) |
| 20 | flagged (0.900) | flagged (0.829) |

**English flags at 3 repeats, Chinese at about 10** — and nearer 30 when a long
healthy passage precedes the loop, because the score is coverage of the trailing
window rather than a count.

This is a decision, not an accident of two constants. Word mode counts tokens,
so a repeated clause is several tokens and accumulates fast. Character mode
measures how much of a fixed trailing window one repeating block covers, and a
short refrain takes many repeats to fill it. Tightening `maxCharTailLoop` toward
word-mode aggression would put it into the range where ordinary CJK structured
output sits, which is the trade this package refuses.

**The practical consequence: a looping model answering in Chinese, Japanese or
Thai generates several times more output before the guard fires than the same
model looping in English.** Detection is later and the token saving is smaller.
If you serve mostly non-spaced-script traffic and that cost matters more to you
than the false-positive risk, lower `maxCharTailLoop` toward 0.5 — and calibrate
it against your own traffic first, because that is the range healthy structured
output starts to reach.

## Answering in the wrong script

The one row in that table where non-spaced scripts are not the disadvantaged
case. `LANG_MISMATCH` reads function words and knows three languages, none of
them written in these scripts. `SCRIPT_MISMATCH` reads characters, so it covers
all ten — and it is *more* certain here than on Latin traffic, because Han, Kana,
Hangul, Thai, Cyrillic, Arabic, Devanagari, Greek and Hebrew each occupy a
disjoint block of Unicode:

```
full answer in the wrong script, measured against expectScript: 'latin'
  zh 1.000    ja 1.000    ko 1.000    ru 1.000    ar 1.000
  hi 1.000    el 1.000    he 1.000    th 1.000
```

Against the same measurement, a healthy response scored against the script it is
written in lands at **0.000–0.028** — the 0.028 being Korean technical prose
quoting Latin API names, which is why `'latin'` belongs in almost every
expectation you write.

The rule for building one: pass every script the answer may legitimately
contain. **Japanese needs `['han', 'kana']`** — Kanji and Kana in one sentence
is Japanese working correctly, and `'kana'` alone scores 0.314 on healthy
Japanese prose. Full table in
[docs/detectors.md](./detectors.md#answering-in-the-wrong-language).

Two things it does not do. It is **not a language detector**: Spanish measured
against `'latin'` scores 0, and Chinese measured against `'han'` scores 0 whether
it answered the question or not. And it **does not run mid-stream**, because a
trailing window measures the language of a window — see the reference for the
numbers behind that.

---

[← Back to the README](../README.md) · [Try the playground](https://edwinsatya.github.io/llm-output-guard/)
