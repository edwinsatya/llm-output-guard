---
'llm-output-guard': minor
---

Add `llm-output-guard/openai`: `withOutputGuard()`, a guard for the OpenAI SDK.

One wrap guards both `chat.completions.create({ stream: false })` and
`{ stream: true }`. This is the larger half of who can use this package without
writing glue: it covers **Groq, Together, OpenRouter, Fireworks, DeepInfra, vLLM
and Ollama** too, because the adapter is typed against the chat-completions shape
rather than against OpenAI specifically — anything behind an OpenAI-compatible
`baseURL` works.

On a non-streaming call the tokens are already bought, so a degenerate response
throws `DegenerateOutputError`. On a stream it **cancels the HTTP request**:
`Stream.controller.abort()` makes the SDK call `reader.cancel()` on the response
body, closing the connection so the provider stops generating.

That distinction is the whole claim, so it is tested at the transport rather than
at the loop. The tests drive a real `OpenAI` client through a mock `fetch` whose
response body counts the chunks the server was actually asked to produce and
records whether it was cancelled. A guard that stops iterating while the
connection keeps streaming would pass a "did abort fire" assertion and still be
billed in full. Measured that way against a looping model: **16 of 135 chunks
generated, 88% never produced**, with the unguarded baseline asserted at the full
135 so the comparison means something.

- `onDegenerate` (`'throw'` | `'abort'` | `'ignore'`) and `onVerdict` are now
  defined once in a shared internal module and used by both adapters, so the two
  option surfaces cannot drift. Reading one set of docs is meant to be enough for
  the other.
- Streaming reuses `createStreamGuard`, so the deferral rules are identical:
  mid-stream runs only the redundancy detectors, and `TOO_SHORT`, `TRUNCATED`,
  `INVALID_JSON`, `LANG_MISMATCH` and `LOW_ENTROPY` are evaluated in `end()`.
  Tested rather than assumed, in both directions.
- `finish_reason: 'length'` is mapped into the final check, so `TRUNCATED` fires
  when a response hit `max_tokens`.
- Verdicts carry `modes` and `Reason.mode`, so an OpenAI user gets the same
  verdict an AI SDK user gets — including character-mode `TAIL_LOOP` on Chinese,
  Japanese and Thai.
- The wrapper is a proxy. Every other client method passes through, and
  `create()`'s `APIPromise` keeps `.withResponse()` and friends.

`openai` is an **optional peer dependency** and nothing is imported from it at
runtime. Verified by installing the packed tarball into a project containing
neither `ai` nor `openai`: the core entry works and the `./openai` subpath still
loads.

The declared range `^4 || ^5 || ^6 || ^7` is one that has been run, not assumed —
the lesson from the `ai` range being wrong at both ends. `scripts/check-ai-peer.mjs`
is generalised to `scripts/check-peers.mjs`, covering both peers, and CI now
checks `openai` at 4.0.0, 5.23.2, 6.49.0 and 7.4.0 as well as the three `ai`
versions. Every one typechecks the documented usage and cancels the response body
at 16 of 135 chunks.

