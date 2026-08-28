# Agent loops

The failure every other detector in this package scores `0.000` on, why the one
that catches it looks for *exact* cycles, and the shape that is measurably out
of reach.

## The failure

An agent calls `read_file` on the same path six turns running. Or it edits one
file, runs one test set, edits the same file the same way, runs the same tests,
until the step budget is gone.

Every response in that run is fine. Fluent, well-formed, the right length,
calling a tool that exists with arguments that match its schema.
`checkOutput` passes each one and is right to — nothing is wrong with any
*response*. What is wrong is the sequence, and a sequence is not something a
per-response detector can see.

```ts
import { createAgentGuard } from 'llm-output-guard/agent';

const guard = createAgentGuard();

while (!done) {
  const response = await model.step();
  const verdict = guard.observe({
    text: response.text,
    toolCalls: response.toolCalls,
  });
  if (!verdict.ok) break; // the run is circling; stop paying for it
}
```

`observe` returns a verdict about the **run**, not the turn. Guard the turns
with an adapter as usual; the two measure different things and neither replaces
the other.

`checkTrace(turns)` is the same check without the retained state, for a trace
you already have in hand — a replay, a stored transcript, an offline audit.

## Building a turn from your provider

Every adapter subpath exports `toTurn`, which maps that provider's response onto
the `AgentTurn` shape:

```ts
import { toTurn } from 'llm-output-guard/openai';     // chat.completions and responses
import { toTurn } from 'llm-output-guard/anthropic';  // messages.create
import { toTurn } from 'llm-output-guard/google';     // generateContent
import { toTurn } from 'llm-output-guard/ai-sdk';     // generateText
```

**Use it rather than mapping by hand**, and the reason is the failure mode
rather than the four lines saved. Reach into the wrong field — `arguments`
instead of `function.arguments`, `args` instead of `input` — and nothing
throws, nothing warns and no score rises. Every turn fingerprints differently,
so `AGENT_LOOP` reports 0.000 for the life of the process and you have a guard
you believe in and do not have. That is the same shape as the `.catch()` hole
fixed in 1.8.0, one layer up.

Each mapper carries the provider knowledge the adapter beside it already had:

| | Reads |
|---|---|
| `./openai` | Both APIs, discriminated on `choices`. The legacy `function_call` spelling too. **First choice only** |
| `./anthropic` | `tool_use` and every server tool. Thinking blocks are neither text nor a call |
| `./google` | Thought summaries excluded. **First candidate only**. `executableCode` counts as a call |
| `./ai-sdk` | The `content` parts array, or the flat `{ text, toolCalls }`. `input` and the older `args` |

Two of those say *first only*. `n > 1` and `candidateCount > 1` ask for
alternatives to one question, and an agent feeds exactly one of them onward —
so fingerprinting the concatenation would describe a turn that never happened,
and describe it unstably. `withOutputGuard` joins them all, because it is asking
a different question: whether the response degenerated, not what the agent did.

The Anthropic note is the one that bites hardest in practice. Two turns whose
reasoning differs and whose *action* is identical are the same turn — an agent
retrying `run_tests` with a fresh rationalisation each time is looping. Reading
thinking as text would score that at zero.

A mapper never throws. Anything it does not recognise maps to an empty turn,
which the trace drops rather than counts — including a `content` that is a
string, which is what a *request* message looks like and an easy thing to pass
by mistake.

## What makes two turns the same turn

A turn is reduced to one comparable fingerprint, and everything about the
detector follows from how that is built.

**A turn that carries tool calls is fingerprinted by the calls alone. Its text is
never read.** This is the rule the single-response adapters already apply — the
presence of tool calls means the text is a preamble rather than the answer — and
here it is the whole ballgame:

```
"Let me check the next file."   read_file { path: "src/a.ts" }
"Let me check the next file."   read_file { path: "src/b.ts" }
"Let me check the next file."   read_file { path: "src/c.ts" }
```

Word for word identical, and the agent is working perfectly. A fingerprint that
included the preamble would read this as total collapse. **The arguments are
where progress lives**, so the arguments are what gets measured. A turn with no
tool calls has only its prose, so prose is what it gets.

Three normalisations, each closing a way an obvious loop scores zero:

| | Why |
|---|---|
| Argument keys sorted, at every depth | Models do not emit key order consistently. `{query, limit}` one turn and `{limit, query}` the next is one call, and a raw `JSON.stringify` reads two |
| A JSON **string** parsed before comparing | OpenAI sends `function.arguments` as a string, Anthropic sends an object. A trace assembled from both still compares |
| Prose lowercased, whitespace collapsed | A trailing newline and a doubled space are not progress |

Array order is **not** normalised — it is meaningful in a way key order is not.
Calls issued together in one turn *are* sorted, because parallel calls have no
order to carry progress in.

A turn with nothing to compare — no text, no calls — is dropped from the trace
rather than counted. A run of empty turns is not a perfect cycle; it is no
evidence. Same rule as `checkPreamble` returning `null` on the no-text case.

## Exact periodicity, and what it buys

The score is `TAIL_LOOP`'s, one granularity up: **the largest share of the
trailing window covered by a block repeating to its end.** Same search, same
code — the tokens are turn fingerprints instead of words.

The block must repeat *exactly*. That is what makes it safe against the shapes
that dominate healthy agent traffic, and every one of these is in the corpus as
a trap:

```
                                   turns   cycle
batch-read-distinct-files             20   0.000   twenty reads of twenty files
identical-preamble-distinct-args       6   0.000   same sentence every turn, different args
alternating-with-progress              8   0.000   edit/test/edit/test, a different file each time
same-tool-drifting-args                6   0.000   pagination: one query, only the offset moving
retry-after-error-once                 4   0.000   a transient failure retried once
poll-status-three-times                5   0.000   a short poll
parallel-fanout-one-turn               3   0.000   five parallel calls in one turn
```

Every healthy trace in the corpus scores **0.000**. Not "under threshold" —
zero. The weakest degenerate trace scores 0.455:

```
                                   turns   cycle
tool-same-args-x6                      6   1.000   identical call, six times
tool-cycle-ab-x4                       8   1.000   period-2 cycle
tool-cycle-abc-x3                      9   1.000   period-3 cycle
tool-same-args-key-order               5   1.000   identical but for key order
text-restate-x5                        5   1.000   no tool calls, same sentence restated
tool-loop-after-progress              11   0.455   six good turns, then stuck
```

Margin **0.455**, against the 0.2 this package holds itself to. `maxAgentLoop`
defaults to **0.4**, sitting in that gap nearer the healthy side because nothing
healthy comes close. `npm run measure:agent` reproduces the table.

## Sensitivity: what it takes to fire

The score is coverage of the window, not a count, so the same loop reads
differently depending on how much healthy work precedes it. At the defaults
(`window: 12`, `minTurns: 4`, `minRepeats: 3`, `maxAgentLoop: 0.4`):

| Trailing shape | Fires from |
|---|---|
| One call repeated | 5 identical turns (5/12 = 0.417) |
| A 2-turn cycle | 3 repeats, 6 turns (0.5) |
| A 3-turn cycle | 3 repeats, 9 turns (0.75) |
| A 4-turn cycle | 3 repeats, 12 turns (1.0) |
| Anything, in a trace under 4 turns | never — it abstains |

A short trace is measured whole, so a 5-turn run that is 5 identical turns
scores 1.000 and fires at turn four. Deliberately: two identical turns is a
retry and three is a short poll, and neither is evidence that an agent has
stopped advancing.

Cycles longer than `window / minRepeats` — 4 turns at the defaults — are not
searched, because a block cannot repeat three times inside a window that does not
hold it three times. Raise `window` and `maxPeriod` together to look for longer
orbits, and expect a loop at the very end of a long trace to score lower as the
window grows.

## Polling is indistinguishable, and is named rather than guessed

A tool whose whole job is to be called repeatedly with identical arguments —
polling a job, sleeping, reading a clock — produces exactly the shape this
detector exists to catch. There is no signal separating them, in the same way
there is none separating `PROMPT_ECHO` from a translate endpoint.

So it is declared:

```ts
createAgentGuard({ ignoreTools: ['get_job_status'] });
```

Ignored calls are dropped before fingerprinting. A turn whose calls are *all*
ignored drops out of the trace entirely rather than falling back to its
preamble — which would rebuild the identical-preamble trap on precisely the
traces someone reached for this option to fix. A loop in the tools you did not
name still reads normally.

Three identical polls sit under the floor without any of this. Four do not.

## The gap: circling without repeating

**An agent that returns to one failing call between other work is not
detected.**

```
run_build → read error.log → run_build → read tsconfig.json → run_build → …
```

Degenerate, obviously. No exact cycle exists, so the shipped detector scores it
`0.000`.

The signal that reads it is turn redundancy — how much of the window is turns
seen before. It was built, measured, and rejected, because **it cannot be
separated from a healthy edit/test rhythm**:

```
turn redundancy, window 12
  thrash-return-to-same        0.444   degenerate
  alternating-with-progress    0.375   healthy
  poll-status-three-times      0.400   healthy
```

A margin of **0.069**, and the healthy side sits *above* a third healthy trace.
Both traces are one tool recurring between other work; the difference is whether
the other work changed anything, which is semantics, not shape. Under this
package's own 0.2 bar that is a false positive waiting for someone's agent to
have a slightly chattier tool.

So the gap ships as a gap. `thrash-return-to-same` lives in
`test/fixtures/agent/uncaught/` — not in `bad/`, because it does not fire, and
not in `good/`, because it is not healthy — with a test asserting both halves:
that it is still missed, and that the margin is still too small to ship. If
either changes, that test says so.

If this is your failure mode, log `scores.AGENT_LOOP` alongside a redundancy
measure of your own and threshold it against your own traffic. Your tool mix is
narrower than this corpus has to assume, and the margin that is unusable in
general may be perfectly usable for you.

## What this does not check

The turns themselves. A turn that loops *inside* itself is `checkOutput`'s job
and the adapters already do it; running both here would report one failure under
two codes. The adapter guards each response, this guards the run.

## Options

| Option | Default | |
|---|---|---|
| `maxAgentLoop` | `0.4` | Cycle-coverage threshold. `null` disables |
| `window` | `12` | Trailing turns inspected. Also caps cycle length, at `window / minRepeats` |
| `minTurns` | `4` | Below this it abstains |
| `minRepeats` | `3` | Repeats required to count as a cycle |
| `maxPeriod` | `4` | Longest cycle searched, in turns |
| `ignoreTools` | `[]` | Tools dropped before fingerprinting |

`checkTrace` never throws. A trace that is not an array, holds `null`s, or holds
things that are not turns produces a passing verdict — this sits inside an agent
loop, and a guard that can crash the loop it guards is a worse failure than the
one it was added to catch.
