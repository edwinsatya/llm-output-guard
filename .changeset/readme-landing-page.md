---
'llm-output-guard': patch
---

Restructure the README as a landing page, and add badges.

It was 37 KB and roughly 5,000 words — thorough, and the wrong shape for the
thirty seconds someone spends deciding whether to install a reliability library.
`## Usage` alone ran 421 lines before the detector table appeared.

The README now leads with the problem, the install, a nine-line example, and the
detector table, and it is 13 KB. Badges for version, min+gzip size, the
zero-dependency claim, CI and licence sit above the fold, because "3 KB and no
dependencies" is the pitch and it was previously buried in Design notes.

**Nothing was deleted, only moved.** The long-form material is now five files
under `docs/`, each linked from the section that summarises it:

- `docs/detectors.md` — the full reference, every exported scorer, and the
  repeated-records case
- `docs/adapters.md` — OpenAI, Anthropic and the Vercel AI SDK in full, plus
  tool-call handling
- `docs/streaming.md` — mid-stream detection and the measured latencies
- `docs/calibration.md` — the CLI, the programmatic form, and how thresholds are
  set
- `docs/script-coverage.md` — what works on Chinese, Japanese and Thai, and the
  measurements behind what does not

The **Stability** section stays in the README, including the 0.4.2 incident. It
is a trust asset, not an appendix — it is the part that tells a reader what a
version number means here, and it should not require a second click.

`docs/` remains outside the `files` allowlist, so the published tarball is
unaffected apart from the smaller README. A `.nojekyll` file keeps GitHub Pages
serving the playground as written now that Markdown sits beside it.
