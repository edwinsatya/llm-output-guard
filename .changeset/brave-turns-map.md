---
'llm-output-guard': minor
---

`toTurn`, from all four adapter subpaths, for building the turns
`llm-output-guard/agent` reads.

```ts
import { createAgentGuard } from 'llm-output-guard/agent';
import { toTurn } from 'llm-output-guard/openai';

const guard = createAgentGuard();
const verdict = guard.observe(toTurn(completion));
```

1.9.0 shipped the detector and left the wiring to the caller. That wiring is
four lines, and one of them is `call.function.arguments` — **reach into the
wrong field and nothing throws, warns or scores high.** Every turn fingerprints
differently, `AGENT_LOOP` reports 0.000 for the life of the process, and the
result is a guard you believe in and do not have. Same shape as the `.catch()`
hole fixed in 1.8.0, one layer up and on the least familiar API in the package.

Each mapper carries what the adapter beside it already knew: both OpenAI APIs
discriminated on `choices` plus the legacy `function_call` spelling; Anthropic's
server tools alongside `tool_use`, with thinking blocks read as neither text nor
a call; Gemini's thought summaries excluded and `executableCode` counted; and
the AI SDK's `content` parts array or flat `{ text, toolCalls }`, with `input`
and the older `args` reaching the same fingerprint.

**OpenAI and Gemini read the first choice or candidate only**, where
`withOutputGuard` joins them all. The two are asking different questions:
`n > 1` offers alternatives to one question and an agent feeds exactly one of
them onward, so fingerprinting the concatenation would describe a turn that
never happened — and describe it unstably, since which alternatives arrive
varies per call.

The Anthropic rule is the one that bites hardest. Two turns whose reasoning
differs and whose action is identical are the same turn: an agent retrying
`run_tests` with a fresh rationalisation each time is looping, and reading
thinking as text scores that at zero.

**No mapper throws.** Anything unrecognised maps to an empty turn, which the
trace drops rather than counts. That covers a `content` that is a string —
which is what an Anthropic *request* message looks like, an easy thing to pass
by mistake, and the case that crashed the mapper before a test caught it. A
mapper sits between a provider and a guard, which is the worst place in the
stack to throw.
