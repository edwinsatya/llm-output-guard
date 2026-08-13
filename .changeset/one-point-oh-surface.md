---
'llm-output-guard': major
---

Freeze the public API for 1.0, and remove two exports rather than support them.

`percentile` and `findGap` are no longer exported from the root. Both shipped in
0.4.0, were mentioned only in that release's changeset, and were never documented
anywhere a user would look. Both also take a **pre-sorted ascending** array and
return confidently wrong numbers when given anything else — a precondition that
is fine for the internal callers they were written for, and a poor thing to
promise for a year. The useful half of `findGap` is already public as
`Summary.gap`, and `percentile` is generic statistics with nothing to do with
what this package is about. `calibrate` and `summarise` are unaffected.

Nothing else changes. The rest of the surface was audited export by export and
kept deliberately:

- **Core** — `checkOutput`, `assertOutput`, `DegenerateOutputError`, `presets`.
- **Streaming** — `createStreamGuard`, `guardStream`.
- **Detectors, individually** — `emptinessScore`, `shortnessScore`,
  `repetitionScore`, `tailLoopScore`, `tailLoopDetail`, `compressibilityScore`,
  `compressionRatio`, `truncationScore`, `jsonScore`, `stripFence`,
  `languageMismatchScore`, `languageProfile`, `supportedLanguages`. The README
  has always promised these individually and they are cheap to keep stable.
  `tailLoopDetail` sits alongside `tailLoopScore` rather than replacing it: the
  `...Score` naming matches the other seven detectors, and the detail form is
  what you need when the tokenization mode matters.
- **Calibration** — `calibrate`, `summarise`.
- **Types** — `CheckOptions`, `Verdict`, `Reason`, `ReasonCode`, `TokenMode`, the
  per-detector options types, and the calibration result types.

The two adapter subpaths export `outputGuard` / `withOutputGuard`,
`OutputGuardOptions` and `DegenerateAction` and nothing else.

**`AdapterGuardOptions` is internal and stays internal**, at 1.0 and after. It is
exported from no subpath and reachable by no import path a user has. Each
adapter's `OutputGuardOptions` is its own public contract; they share a base
today and are free to diverge tomorrow. That is what keeps a future
provider-specific option cheap — it goes on that subpath's interface, and no
shared type has to be widened or split after a freeze. `DegenerateAction` *is*
public through both subpaths, so its members are covered by semver on each.

The **Stability** section shipped with the README in 0.5.0; 1.0.0 is where it
starts binding. Its load-bearing rule is the one the usual semver wording leaves
ambiguous: **threshold and preset value changes are behaviour changes and ship in
a major**, because they do not break a build — they change which of your
production responses get discarded and retried, which is invisible until your
traffic hits it.
