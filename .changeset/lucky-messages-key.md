---
'llm-output-guard': patch
---

`check --trace` finds the turns where they actually are.

It read a bare array or a `turns` key, and nothing else — so the likeliest
container there is did not work:

```jsonl
{"model":"gpt-4","messages":[{"role":"assistant", …}]}
```

`messages` is OpenAI's own request field and what essentially every agent
framework calls its history. Now `turns`, `messages`, `history`, `conversation`
and `steps` all read, at the top level or one object down — so a whole request
body, or a run logged inside a wider record, needs no reshaping. That is the
intent stated at the top of `cli.ts`: a calibration step you have to prepare
your logs for is one you do not run.

**Named keys rather than any array, and that limit was learned the hard way.**
Scanning every array-valued property was written first and thrown away.
`extractTurn` reads a bare string as a prose turn, so `{ tags: ['a', 'b'] }`
became a two-turn run and a repeated tag list would have scored `AGENT_LOOP` —
the same wrong-speaker failure the `role` gate had just fixed, reintroduced one
level up by the liberality meant to help. Being liberal about the *shape* of a
turn is the point here; guessing which field holds a conversation is not.
