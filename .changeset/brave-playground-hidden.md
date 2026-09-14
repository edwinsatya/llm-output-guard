---
'llm-output-guard': patch
---

The playground showed both modes at once. Two bugs, and neither was caught by a
test that passed.

**`hidden` lost to a class.** The page toggles containers with `el.hidden`, and
three of them are laid out by a class with `display: flex`. A UA stylesheet's
`[hidden] { display: none }` is lower specificity than a class rule, so setting
`hidden` changed the property and nothing on screen: both specimen lists
rendered in both modes, the preset row stayed put in agent mode, and the turn
strip followed you back into response mode. Fixed with an explicit
`[hidden] { display: none !important; }`.

**The turn strip was never emptied.** `runResponse` clears the meters and did
not clear the strip, so response mode kept rendering rows describing a run that
was not on screen. Visible before the CSS fix; a latent wrong answer to "what is
this page showing?" after it.

**Why the tests passed.** A DOM without layout reports `el.hidden === true`
quite happily, and happy-dom's `getComputedStyle` returns `flex` for a hidden
element regardless — so computed style cannot be asserted here. The tests now
assert the rule whose absence caused it, and exercise both modes **twice**,
because the strip only leaks on the second visit. Separately, every chip and
every preset in both modes is now driven in one pass.

One more instance of a pattern this repo keeps meeting: the guard's own regex
matched the CSS comment documenting the rule, reporting the weaker form. Strip
comments before scanning — third time, and it is written down in the test.
