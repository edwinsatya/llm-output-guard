---
'llm-output-guard': patch
---

`./openai` reads `toolCalls` as well as `tool_calls`, which fixes a total
failure against Mistral's SDK.

`tool_calls` is the wire protocol, and what Groq, Together, OpenRouter,
Fireworks, vLLM and Ollama's compatibility endpoint all send. Mistral's
generated SDK renames it to `toolCalls` on the way out.

**That rename did not degrade the guard, it inverted it.** A tool-calling turn
carries no prose, so a message whose call list went unrecognised read as
`content: ''` — and the empty string scores `EMPTY: 1`:

```ts
// every tool-calling turn from a Mistral client, before this release
const client = withOutputGuard(new Mistral(), { ...presets.chat, onDegenerate: 'abort' });
await client.chat.completions.create(params); // throws DegenerateOutputError
```

That is `internal/tool-calls.ts`'s founding bug reintroduced for one provider by
a spelling, and invisible to every fixture in the corpus, all of which are
prose. It affected `withOutputGuard`, `checkToolArguments` and `toTurn` alike,
because all three read the same list — so all three now go through one helper.

Reading both spellings is safe rather than merely convenient: no response in the
OpenAI family carries both fields, so there is nothing to disambiguate and no
shape where the extra read changes an existing answer.

`test/openai-alikes.test.ts` now pins the whole table — which provider envelopes
map fully, which map to nothing — and the invariant that matters more than the
table: **there is no partial outcome.** A turn with its text read and its calls
missed fingerprints by its preamble prose rather than its arguments, so an agent
reusing one preamble across twenty files would read as a total collapse. That is
a false positive on a healthy run, and it is how this bug would have surfaced in
`AGENT_LOOP` had the `EMPTY` failure not surfaced it first.
