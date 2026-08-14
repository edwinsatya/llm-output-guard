---
'llm-output-guard': patch
---

Add a browser playground at `docs/`, published to GitHub Pages.

Every detector, running on this repo's own fixtures or on your own pasted
output. No API key and no request: the library is bundled into the page rather
than fetched, so the numbers on screen are what `checkOutput` actually returns
rather than a reimplementation that can drift. That this is possible at all is a
consequence of the package being zero-dependency, pure and synchronous.

Each detector is drawn as a meter — a track filled to the score, with a tick at
the threshold — which is the one component that explains the whole model: scores
rather than booleans, every detector running even after one fails, and a greyed
track for a detector the current preset disables.

The specimens are the fixtures themselves, read from `test/fixtures` at build
time rather than copied, so a fixture edited there is a specimen changed here.
They include the traps as prominently as the failures: a markdown table, repeated
list prefixes, a rhetorical refrain, a Chinese poem refrain. False positives cost
more than misses, and that is easier to show than to assert.

Each specimen is pinned to the preset it is written for, and the page says so
when you switch away — `presets.chat` leaves truncation and JSON off entirely, so
a truncated specimen judged by it is not being missed, it is not being asked
about. Without that, two labelled-degenerate fixtures pass under the default
preset and the demo reads as broken rather than as a lesson about presets being
contracts for a task. The build refuses to emit a specimen whose label does not
hold under some preset.

The page is bundled from `src/` with esbuild rather than assembled from
`dist/index.js`, which is code-split — its first line is
`export { checkOutput, ... } from './chunk-XHP4LSIH.js'`. Inlining that produced
a page that asked the browser for a chunk nobody had copied, failed to load the
module, and rendered an empty shell. It failed *silently*: the file parsed, held
no placeholder, made no external request, and passed a theme audit. Every check
short of running it said the page was fine.

So `test/playground.test.ts` executes the real module against a real DOM and
asserts the page populated — specimens, presets, all eight meters, a computed
verdict, and a verdict that flips when a trap is selected. Those tests fail
against the broken build and pass against this one. A staleness check on the
stamped version catches the other half, since CI reads the committed page.

`npm run playground` regenerates it, and `prepublishOnly` now runs it, so a
release cannot ship a demo that lags the library. `docs/` is outside the `files`
allowlist and adds nothing to the published tarball.
