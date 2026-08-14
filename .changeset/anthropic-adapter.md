---
'llm-output-guard': minor
---

Add a `./anthropic` adapter for the Messages API.

`withOutputGuard(new Anthropic(), presets.chat)` guards `messages.create` in both
shapes, with the same options as the other two adapters. Claude users previously
had to hand-roll the guard around every call.

Two things are specific to this API, and both are the kind of detail that turns a
guard into a false-positive generator if it is got wrong:

**Extended thinking is not read as the answer.** `thinking` blocks are the
model's reasoning, are frequently longer than the answer, and repeat themselves
as a matter of course while working a problem. Folding them into the measured
text would raise every repetition score on every thinking response and flag the
ones that thought hardest, so only `text` blocks are measured — and a `thinking`
block is not mistaken for a tool call either, which would silently put the guard
into preamble mode for most modern responses.

**Both length stops map to `TRUNCATED`.** `max_tokens` was already one of the
stop reasons `truncationScore` treats as authoritative;
`model_context_window_exceeded` is the same event under a different name and is
normalised in the adapter rather than by widening the detector's own set, which
would spend a shared vocabulary on one provider's spelling. `refusal` is
deliberately not truncation: a refusal is a complete response that says no, which
is a content judgement this package does not make.

`messages.stream()` and `messages.batches` are left plainly unguarded and
documented, on the same reasoning as `./openai`'s `responses.stream()`.

`@anthropic-ai/sdk` is an optional peer, declared `>=0.60.0 <1.0.0` and verified
at 0.60.0, 0.90.0 and 0.117.1 — each installing the packed tarball and running
the adapter against a real client over a mock transport, not merely typechecking.
The main entry point still has no peers and the package still has no
dependencies, which `test/surface.test.ts` now asserts rather than trusting.

Internally, the client-wrapping machinery moved to `internal/proxy-guard.ts` and
is shared with `./openai` — the `APIPromise` proxying, the transport-level abort
and the tool-call handling are identical between the two SDKs, and two copies of
them is how one gets fixed and the other does not. `internal/` remains outside
the public API and outside semver.
