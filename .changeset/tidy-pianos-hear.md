---
"llm-output-guard": minor
---

New subpath: `llm-output-guard/agent`, for degeneration **across** turns.

```ts
import { createAgentGuard } from 'llm-output-guard/agent';

const guard = createAgentGuard();

while (!done) {
  const response = await model.step();
  const verdict = guard.observe({ text: response.text, toolCalls: response.toolCalls });
  if (!verdict.ok) break; // the run is circling; stop paying for it
}
```

An agent that calls `read_file` on the same path six turns running has produced
six healthy responses. Every existing detector scores each of them **0.000**,
correctly — nothing is wrong with any *response*. What is wrong is the sequence,
which is not something a per-response detector can see. `AGENT_LOOP` is the
first code here that reads more than one response, and the only one
`checkOutput` never reports.

`checkTrace(turns)` is the same check without the retained state, for a
transcript you already have. `assertTrace` throws the existing
`DegenerateOutputError` rather than introducing a second error type: a
degenerate response and a degenerate run want the same `catch`.

**The score is `TAIL_LOOP`'s, one granularity up.** The periodicity search moved
to `internal/periodicity.ts` unchanged and is now shared by both — word tokens,
characters and turn fingerprints are three granularities of one question, and a
second copy is how two of them quietly stop agreeing.

**A turn carrying tool calls is fingerprinted by its calls, and its prose is
never read.** This is the rule the adapters already apply to a single response,
and here it is what separates the two shapes that matter: an identical preamble
on every turn with different arguments is an agent working through a list, and
the same arguments under different prose is an agent stuck. Argument keys are
sorted at every depth and a JSON-string payload is parsed before comparing, so
the same call fingerprints the same whether it arrived from OpenAI or Anthropic.

**Exact periodicity, which is what makes it safe.** Every healthy trace in the
new corpus scores 0.000 — not "under threshold", zero — including twenty reads
of twenty files, edit/test/edit/test with a different file each time,
pagination, and a retry. The weakest degenerate trace scores 0.455, so
`maxAgentLoop` defaults to 0.4. `npm run measure:agent` reproduces it.

**One shape is measurably out of reach and ships as a gap.** An agent circling
without repeating — `build`, read a file, `build`, read another, `build` — has no
exact cycle. The signal that reads it, turn redundancy, scores that trace 0.444
and a *healthy* edit/test rhythm 0.375: a margin of 0.069 against this package's
0.2 bar, with a healthy trace sitting above another healthy trace. Built,
measured, rejected. It lives in `test/fixtures/agent/uncaught/` with a test
asserting both that it is still missed and that the margin is still too small to
ship.

Polling is indistinguishable from a loop by shape, so it is named rather than
guessed: `ignoreTools: ['get_job_status']`.

`checkTrace` never throws — not on a non-array, not on nulls, not on entries
that are not turns. It sits inside an agent loop, and a guard that can crash the
loop it guards is a worse failure than the one it catches.

`AGENT_LOOP` joins the `ReasonCode` union. Nothing that runs by default changed,
and `checkOutput`'s behaviour is untouched.
