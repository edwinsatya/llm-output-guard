---
'llm-output-guard': patch
---

Two detectors were reading characters they should not have been.

**`TRUNCATED` counted brackets and fences inside string literals.** A JSON
payload carrying a code snippet — an extremely ordinary thing for a model to
return — put those characters inside a value, and complete, valid JSON scored as
cut off:

```ts
truncationScore('{"note":"the opening brace { is literal","done":true}'); // 0.8
truncationScore('{"snippet":"```js","done":true}');                       // 0.9
```

A document that parses is complete by definition, which is stronger evidence
than the heuristics were reaching for, so a parseable payload now scores 0. The
provider's own stop reason still wins: a response can be both parseable and cut
short at the token ceiling. Genuinely truncated text is unaffected — an unclosed
fence still scores 0.9, an unclosed object 0.8, a severed sentence 0.55.

Gated on the first character, so prose costs one comparison rather than a parse
attempt.

**`LANG_MISMATCH` returned `NaN` for any language name on `Object.prototype`.**
The guard was `expected in PROFILES`, which walks the prototype chain, so
`expectLang: 'constructor'` passed it, then read a function as the target share
and produced `NaN` — a score neither above nor below any threshold, silently
disabling the detector and poisoning any histogram built from it. Now
`Object.hasOwn`, and an unmodelled language abstains at 0 as documented.

Same root cause as the `requiredKeys` fix in this release. Verified byte-identical
to the published 1.2.1 across all 228 fixture × preset combinations: the corpus
contains no payload with a brace inside a string, which is exactly why neither
bug was caught.
