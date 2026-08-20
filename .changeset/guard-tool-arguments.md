---
"llm-output-guard": minor
---

New opt-in: `checkToolArguments`, for a model that loops inside the arguments it
passes to a tool.

```ts
const client = withOutputGuard(new OpenAI(), {
  ...presets.chat,
  checkToolArguments: true,
});
```

Available on all three adapters — `./openai` (both `chat.completions` and
`responses`), `./anthropic`, and `./ai-sdk`.

## The hole

1.0.1 established that a tool-calling turn is judged by its **preamble**, because
the text beside a tool call is not the answer. That was right, and it left the
answer itself unmeasured. The README said so and pointed at the provider's schema
validation as the thing covering it.

Schema validation covers *types*. A model that loops does not produce the wrong
type — it produces a valid string with nothing in it:

```json
{ "query": "site reliability engineering site reliability engineering …", "limit": 10 }
```

That is a schema-valid `string`. The provider hands it to your tool without
complaint, and you have issued a garbage search — or, if the tool writes,
persisted the loop. For anyone running agents this was invisible, on the traffic
shape agents produce most.

## What it measures

Redundancy only, per string value, under the thresholds your guard already uses.
Reason codes are unchanged, so existing handling keeps working; the `message`
says the loop was found in an argument. `message` is outside this package's
semver promise, which is what makes it the right place to put that.

Everything else is deliberately off. `LOW_ENTROPY` because JSON is legitimately
repetitive at the character level — the same reason `presets.strictJson` turns it
off. `TRUNCATED`, `TOO_SHORT` and `INVALID_JSON` because the provider already
guarantees the arguments parse and match the schema. `SCRIPT_MISMATCH` and
`LANG_MISMATCH` because an argument is not prose addressed to a user, and a query
in another language is ordinary rather than degenerate.

Values are measured individually, never as a serialised document — two calls
against one schema are legitimately near-identical documents, which is the rule
`redundancyScope: 'jsonValues'` already follows.

## The false positive it would otherwise have shipped

A tool that takes no parameters is called with `{}`, and `{}` is one of the
shapes `emptinessScore` exists to catch — so the obvious implementation scores
`EMPTY: 1` and fails every call to a no-argument tool. That is the 1.0.1
tool-call bug again in a new place, and it was caught by a test rather than by
review.

Arguments carrying no strings at all (`{"lat":-6.2,"zoom":11}`) are skipped for
the same reason: no content to judge, so no verdict is manufactured. A call with
nothing measurable and no preamble reports nothing, following `checkPreamble`'s
existing `null` rule so a calibration run is not poisoned with `EMPTY` spikes
that describe an agent's tool use.

## Limits

**Non-streaming responses only.** Arguments arrive as JSON fragments that do not
parse until the call is complete, so there is nothing meaningful to measure
mid-stream.

Off by default and absent from every preset, so nothing changes for an existing
caller. Switching it on can only make a response fail that previously passed.
