---
'llm-output-guard': minor
---

`check --trace` takes the run-scoring options: `--ignore-tools`,
`--max-agent-loop`, `--window`, `--min-turns`.

`--ignore-tools` is the one that had to exist. `AGENT_LOOP` cannot tell a job
poller from a loop — the docs say so and offer `ignoreTools` as the answer — and
the CLI had no way to express it, because `checkTrace` was called with no
options at all.

That was worse on this path than it would have been in the library. `--trace` is
the **calibration** path: every polling run flagged, so the sample you derived a
threshold from carried exactly the false positives the option exists to remove,
and the number it suggested was shaped by them.

```bash
npx llm-output-guard check runs.jsonl --trace \
  --ignore-tools get_job_status,sleep --json \
  | npx llm-output-guard calibrate
```

Two things are now refused rather than ignored. `--preset` with `--trace` exits
2 and names `--max-agent-loop`: a preset is a per-response contract, runs are
scored on one axis with one threshold, and silently accepting it would leave a
caller believing they had tuned something. A run-scoring flag without `--trace`
exits 2 for the same reason. A non-numeric knob is refused rather than
defaulting quietly.
