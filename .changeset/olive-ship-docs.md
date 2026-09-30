---
'llm-output-guard': patch
---

The docs ship with the package.

`files: ["dist"]` meant a consumer got types and a README, while the material
that actually prevents mistakes — `docs/adapters.md`, `docs/calibration.md`,
`docs/agent-loops.md` and the rest — stayed in a repo they had no copy of.

This was measured rather than assumed. Testing an agent skill for wiring this
package in, the **baseline** agents — no skill, just the task — got every detail
right: the streaming-only meaning of `onDegenerate: 'abort'`, `toTurn` over
hand-mapping, leaving `PROMPT_ECHO` off a summarisation endpoint. They got it
right because they read `docs/`, and two of them said so unprompted. They were
running with the repo on disk. A real consumer never has that.

So the docs now ship: 75 KB of markdown, taking the tarball from 569 KB to
595 KB packed. Nothing about the bundle changes — the size budget measures
bundled JavaScript, and `docs/index.html` is excluded because it is the built
playground for GitHub Pages rather than anything a consumer needs.

`test/surface.test.ts` asserts it, since a `files` entry is the sort of thing
that regresses in silence. It checks the pattern rather than a list, so a doc
added later ships without an edit.
