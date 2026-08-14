---
'llm-output-guard': minor
---

Guard `responses.create` on the `openai` adapter.

`withOutputGuard` wrapped only `chat.completions.create`, so a caller on
OpenAI's Responses API — the surface OpenAI now points new code at — got a
client that looked guarded and checked nothing. That is worse than not
supporting the API: a guard you believe in and do not have is the failure this
package was written about.

Both shapes are now covered, streaming and not, on the same one wrap. The
adapter reads assistant text by walking `output` for `message` items rather than
trusting `output_text`, which is an SDK convenience absent from a raw envelope
or a gateway that reimplements the protocol. Tool calls are recognised as any
output item that is neither `message` nor `reasoning` — an allow-list of two,
because the output union is 28 members and all but those two are tool calls of
some kind, so a deny-list would be broken by the first new tool type and broken
in the direction that fails healthy responses.

`incomplete_details.reason` is mapped as this API's stop reason, so `TRUNCATED`
fires on `max_output_tokens` exactly as it does on chat's `length`.
`content_filter` is deliberately not read as truncation: a filtered response is a
different failure, and reporting it as `TRUNCATED` would send a retry layer after
the wrong fix.

**`responses.stream()` is deliberately left unguarded.** It returns a
`ResponseStream` — an event emitter with `.on()`, `.finalResponse()` and
`.abort()`, not merely an async iterable — and wrapping only its iteration would
guard a `for await` consumer while leaving `.finalResponse()` unchecked. That is
the same looks-guarded-but-is-not trap in a smaller box, so it is documented
rather than half-fixed. Use `create({ stream: true })`, or run `checkOutput` on
`await stream.finalResponse()` yourself.

No new exports, options or thresholds: `./openai`'s public surface is unchanged.
