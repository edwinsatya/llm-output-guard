---
'llm-output-guard': patch
---

`check --trace` reads a chat history, and stops reading the wrong speaker.

Two failures, found by asking what someone actually has to hand. An agent loop
keeps a `messages` array and logs *that* far more often than it logs raw
completion envelopes — and a normal history did not work:

```jsonl
{"turns":[{"role":"assistant","content":"Running it.","tool_calls":[…]},
          {"role":"tool","content":"FAIL"}]}
```

**Every message in it was dropped, the model's included.** `extractTurn` knew
completions — `choices[0].message` — but not bare messages, so the calibration
path could not read the commonest input there is. It reported `No agent turns
found` and exited 2.

**The second one gave a wrong answer rather than none, and is the serious half.**
A user message spelled `{ role: 'user', content: [{ type: 'text', … }] }` is
shape-identical to an Anthropic response, so it *did* map. A mixed history
therefore built a trace out of the wrong speaker: someone typing "again" three
times scored `AGENT_LOOP` while the model's own turns, spelled differently,
stayed invisible. That is the trace-level twin of the partial-mapping failure
`toTurn` already refuses, and it is worse, because a wrong verdict from real
data outranks a missing one.

One idea closes both: a `role` means this is a message rather than a response,
and only `assistant` — or `model`, Gemini's spelling — is a turn. An Anthropic
response also carries `role: 'assistant'`, so it keeps reading as a response;
only the role now separates it from the request message it otherwise resembles.
