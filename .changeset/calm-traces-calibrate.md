---
'llm-output-guard': minor
---

`check --trace`, so `AGENT_LOOP` can be calibrated against your own agent runs.

```bash
npx llm-output-guard check runs.jsonl --trace --json \
  | npx llm-output-guard calibrate --fpr 0.001
```

The README's central claim is that shipped thresholds are tuned on a corpus that
is not your traffic. `maxAgentLoop: 0.4` shipped in 1.9.0 with no way to act on
that — and of every threshold in this package it rests on the least evidence:
eighteen fixtures written in one sitting, none from a real agent.

Narrower than it sounds, because `calibrate` was already code-agnostic:
`ScoreSample` is keyed by `ReasonCode`, so `AGENT_LOOP` samples flow through the
existing engine untouched. What was missing was only a producer. `check` reads
responses; nothing turned a run into a sample.

Each line is one run — a list of turns, on its own or under a `turns` key — and
a turn is read as liberally as a response already was: a native `AgentTurn`, or
the raw envelope from any provider this package adapts, mapped by that
provider's own `toTurn` so the CLI cannot drift from the library. A file that
parses whole as one array is read as a single run, because a run logged as one
pretty-printed document is at least as common as one logged as a line.

`AGENT_LOOP` also joins the CLI's known codes and `OPTION_FOR`, so `calibrate`
parses those samples and suggests `maxAgentLoop` rather than reporting a
distribution with no knob attached.

Two things `docs/calibration.md` now says that the report cannot. **Read the
`gap` line, not the percentiles**: `AGENT_LOOP` is bimodal in a way the prose
detectors are not, so `p99` on healthy-heavy traffic reads 0.000 right up until
it reads 1.000. And a trace corpus scraped from production is **survivor-biased
against this detector** — if you already kill runs at a turn limit, every loop
in your logs is truncated at that limit and scores lower than the same loop left
to run, so the suggestion is tuned to loops you interrupted rather than loops
you would have paid for.
