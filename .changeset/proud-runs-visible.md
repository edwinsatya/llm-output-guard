---
'llm-output-guard': patch
---

The playground can show `AGENT_LOOP`.

`AGENT_LOOP` shipped in 1.9.0 and the page could not demonstrate it, which
mattered more than a missing feature usually would. The playground is the first
link in the README — *try it in your browser, no API key, no request* — and it
is regenerated on every release precisely so the demo cannot fall behind the
code. For two releases it had.

A new **agent run** mode: pick a trace, or paste a JSON array of turns, and see
the verdict with a turn-by-turn strip showing exactly which turns form the
cycle. `tool-loop-after-progress` is the one to look at — six turns of real work
left plain, then five identical `run_tests` calls highlighted, scoring 0.455.

**The traps are the half worth shipping.** Catching a loop is the part a reader
already believes; that twenty reads of twenty files, one preamble reused across
a whole run, edit/test/edit/test and a short poll all score `0.000` is the part
they arrive sceptical about, and one glance answers it better than a paragraph
can. Each turn now shows its preamble beside its arguments, so the
identical-prose-different-arguments case is visible rather than described.

Specimens come from `test/fixtures/agent/` at build time, like the prose ones,
and the build refuses if any of them stops behaving as labelled — so the demo
and the thresholds cannot drift apart. The page bundles from a synthetic entry
now, since the cross-turn detector deliberately is not exported from the root.

`test/playground.test.ts` executes the new mode rather than inspecting it,
including typing a half-finished trace one character at a time, on the same
reasoning the file was written for: a playground that renders an empty shell
passes every check that does not run it.
