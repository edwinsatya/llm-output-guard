---
'llm-output-guard': minor
---

`responses.stream()` is guarded. It was the last unguarded path in the package.

```ts
const client = withOutputGuard(new OpenAI(), presets.chat);

for await (const event of client.responses.stream({ model, input })) { … }
// throws DegenerateOutputError, and the upstream request is cancelled
```

**Why it shipped unguarded until now.** A `ResponseStream` is an `EventStream`,
readable six ways — `for await`, `finalResponse()`, `done()`, `on()`,
`once()`/`emitted()`, `events()`. Replacing its iterator, which is how a
`Stream` is guarded, would have covered one of those and left five reading an
unchecked stream. Half a guard on the SDK's default streaming surface looks like
coverage and is not, so it was left plainly unguarded and documented instead.

**What makes it tractable** is that all six are fed by one event pump, so a
single listener sees every delta however the caller reads, and `abort()` reaches
the transport for all of them. That splits the problem in two:

| path | detected | cancelled | throws |
|---|---|---|---|
| `for await` · `finalResponse()` · `done()` | yes | yes | yes |
| `on()` · `once()`/`emitted()` · `events()` | yes | yes | — |

Throwing cannot be universal: three paths have an error channel and three do
not. A caller who only attached `on()` callbacks gets the `onVerdict` report and
a stream that stops — the half that saves tokens — but no exception, because a
callback has nowhere to receive one. The table is in
`docs/adapters.md`, and every row is a test.

`onDegenerate: 'abort'` ends the iterator cleanly and keeps what arrived;
`finalResponse()` and `done()` still reject under it, because neither has a
partial value it could honestly return. An abort this package did not cause is
rethrown untouched.

Tested against the **real** `ResponseStream` via `fromReadableStream`, driven by
a faithful Responses event sequence — so it runs through the SDK's own
accumulator and its own abort machinery rather than a double that could drift
from either. Two bugs surfaced doing that and are fixed here: proxying a class
whose getters read `#private` fields needs the real instance as the receiver
(`ended`, `aborted` threw otherwise), and `'abort'` must swallow the SDK's
`APIUserAbortError` on the iterator rather than re-raising a cancellation the
caller never asked for.

`messages.stream()` on `./anthropic` is still unguarded. The mechanism added
here is provider-neutral, so it is now a matter of supplying Anthropic's event
names rather than a question of whether it can be done.
