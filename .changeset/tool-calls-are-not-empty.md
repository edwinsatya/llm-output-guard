---
'llm-output-guard': patch
---

Stop failing every tool call as `EMPTY`.

A model that answers by calling a tool returns no assistant text: OpenAI sends
`content: null` beside `tool_calls`, and the AI SDK sends a `content` array with
no `text` part. Both adapters concatenated text parts and handed the result to
`checkOutput`, which scored the empty string `EMPTY: 1` and threw — correctly for
the question it was asked, and uselessly, because it was asked the wrong one.

The effect was that `withOutputGuard(new OpenAI())` and `outputGuard()` threw
`DegenerateOutputError` on every tool-calling turn of every agent. It went
unnoticed because the whole fixture corpus is prose, and no fixture made of prose
can contain a tool call.

Both adapters now treat the presence of tool calls as meaning the text, if any,
is a preamble rather than the answer. A text-free tool call is not judged at all
and reports nothing to `onVerdict` — an `EMPTY` there would put a spike of
`EMPTY: 1` samples into every `calibrate` run, describing an agent's tool use
rather than any degeneration. Text beside a call is still measured for redundancy,
because a model looping in its preamble is still a model that is looping;
`TOO_SHORT`, `TRUNCATED` and `INVALID_JSON` are switched off for it, each of
which failed healthy tool calls under `presets.longForm` or `presets.strictJson`.

`EMPTY` is not disarmed: a response with neither text nor tool calls still fails,
which is the case this package exists for. Both halves are covered by
`test/tool-calls.test.ts`.

A patch rather than a minor: no name, option or threshold changed, and the only
responses whose verdict moves are ones that were being failed wrongly.
