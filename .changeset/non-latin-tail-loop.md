---
'llm-output-guard': minor
---

Detect loops in Chinese, Japanese and Thai, which the guard silently missed.

`TAIL_LOOP` now measures characters instead of words when a span is written in a
script that does not space its words, under its own threshold
(`maxCharTailLoop`, default 0.7). `Verdict.modes` reports which tokenizer
produced each score.

**What was broken.** The tokenizer splits on runs of letters and digits, so a
punctuation-delimited Chinese clause is one token and a loop with no punctuation
is one token for the whole response. 640 characters of pure Chinese loop scored
`REPETITION 0.000` and `TAIL_LOOP 0.000`. `LOW_ENTROPY` caught the long ones, so
this looked survivable — but it is deferred mid-stream, which meant **streaming
CJK had no detection at all** and a looping model ran to `max_tokens` on your
budget. Shorter loops were missed outright: 128 characters of pure loop scored
`LOW_ENTROPY 0.585` against a 0.75 threshold and passed every detector on a
complete response.

The dividing line is spacing, not script. Korean is non-Latin and was never
affected. Thai *appeared* to work because its vowel and tone marks are `\p{M}`
and fragment the `\p{L}` runs — shredding, not tokenizing, and not something to
rely on.

**Dispatch is per detector span, not per response.** A reply that answers in
English and then loops in Chinese measures 0.47 non-spaced overall and 1.00
across its tail. Deciding once for the whole response puts the tail detector in
word mode over text with no words in it and scores an obvious loop at 0.000;
deciding from the tail scores it at ceiling. `LOW_ENTROPY` reads ~0 on that shape
too — the healthy English dominates the sample — so nothing else covered it.

**`REPETITION` gets no character mode, deliberately.** One was built and
rejected, because it would add no coverage and cost a false-positive surface.
`TAIL_LOOP`'s character mode already catches every degenerate non-Latin fixture
in the corpus at a margin of 0.538, so there is nothing left for it to find.
Meanwhile healthy *structured* CJK output scores high under it: repeated key
scaffolding around short CJK values is genuinely redundant character-by-character,
and `json-zh-keys-valid` measures 0.543 over twenty distinct items, plateauing
near 0.6. Against the weakest pure loop at 0.872 that is a margin of ~0.19 —
under the 0.2 bar this package holds itself to, and rising with the number of
keys a payload carries. `TAIL_LOOP` is immune because it needs *exact*
periodicity, which scaffolding never produces. The README states this gap plainly
rather than implying coverage that does not exist.

Also in this change:

- All four presets set `maxCharTailLoop`, `strictJson` included. It nulls
  `maxCompressibility` because JSON is legitimately compressible; nulling the
  char threshold too would have rebuilt the same blind spot on the preset most
  likely to be pointed at non-English payloads.
- `calibrate` segments by **detector-mode pair** and suggests the matching option,
  so `TAIL_LOOP [word]` and `TAIL_LOOP [char]` get separate thresholds. Pooled,
  one number fits neither. Logs without `modes` still calibrate unsegmented.
- `npm run calibrate` reports per mode, and scores each detector only against
  fixtures labelled for it — previously any above-noise degenerate fixture
  counted toward every detector's margin.
- 14 labelled fixtures: six degenerate, eight healthy traps (CJK numbered lists,
  identical trailing clauses, markdown tables, a Chinese JSON array, a legitimate
  refrain, a Thai prefix list, Korean prose).
- The mid-stream `LOW_ENTROPY` deferral is unchanged but its comment now records
  the condition it depends on and what would invalidate it. Character-mode
  `TAIL_LOOP` scores 0.854-1.000 on every degenerate CJK fixture at the
  240-character warmup, where `LOW_ENTROPY` reads 0.453-0.805 — below its own
  threshold on most. Deferring is still correct, and now for a stated reason.
- Fixed the dispatch ratio for scripts with combining marks. `\p{Script=Thai}`
  matches marks that `\p{L}` does not, so the numerator and denominator counted
  different sets and Thai returned 1.28.

Streaming savings on non-Latin degeneration are **0-85%**, against the 48-92%
measured on Latin, and the README now states both. A response that loops from the
start saves what a Latin one saves; one that answers properly and then loops is
caught late because there is nothing to detect until the loop starts. That still
stops a broken response being cached or served, but it is not a token saving.
