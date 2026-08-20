---
"llm-output-guard": patch
---

Cut the README back down, add four badges, and give performance a page of its own.

Documentation only. No behaviour changed, no threshold moved, no export added.

1.3.1 restructured this README from 37 KB to 13 KB on the argument that a
reliability library gets about thirty seconds to explain itself. Four releases
of features since then took it back to **16.9 KB and 2,499 words**, mostly by
adding good material to the wrong file.

It is now **12.2 KB and 1,685 words**, a third shorter, and the rule is the one
1.3.1 set: **nothing was deleted, only moved.**

- **Structured output** — 55 lines of `requiredKeys`, Standard Schema, the
  synchronous-validation rule — moved to `docs/detectors.md`. The README keeps a
  six-line example and a link.
- **The benchmark tables** moved to a new `docs/performance.md`, along with the
  measurement caveats and the `maxCompressibility` lever. Design notes keep the
  headline: sub-millisecond, one detector accounting for most of it.
- **`SCRIPT_MISMATCH` and `PROMPT_ECHO`** each had a section explaining their
  reasoning; both now sit in a shared **Common setups** section at a few lines
  apiece, pointing at the reference for the numbers.
- **Script coverage** folded into a Design notes bullet, which is where a reader
  deciding whether to install actually needs it.

The **Stability** section stays in the README, tightened but not relocated, for
the reason 1.3.1 gave: it is what tells a reader what a version number means
here, and it should not require a second click.

Every internal link, anchors included, is verified to resolve.

## Badges

Four added, and the row split in two: what you are installing (npm, downloads,
min+gzip, dependencies, types, node) above whether it is looked after (CI, last
commit, commit activity, licence).

**Every GitHub-backed badge carries an explicit `cacheSeconds`,** because the
defaults are dangerous here. `last-commit` and `commit-activity` ship
`max-age=120`, which has camo refetch them **720 times a day** — 720 daily
chances to catch GitHub's API rate limited and pin the error badge for its whole
TTL. That is the failure 1.4.1 fixed on the downloads badge, and these two were
36× more exposed to it. They are now 6 hours and 24 hours respectively.

Five candidates were measured and rejected rather than added: `repo-size`
reports 832 KiB for a package that ships 5 KB, `contributors` reads 1,
`stars` renders no value at all, `issues` reads "0 open" which says nothing
either way, and `v/tag` duplicates the npm version badge.
