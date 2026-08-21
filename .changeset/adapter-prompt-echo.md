---
"llm-output-guard": minor
---

`PROMPT_ECHO` now works from the adapters, via `checkPromptEcho: true`.

```ts
const client = withOutputGuard(new OpenAI(), {
  ...presets.chat,
  checkPromptEcho: true,
});
```

1.5.0 shipped the detector as a `checkOutput` option only, because a guard is
configured once when you wrap a client while the prompt changes on every call.
That left it **unreachable from the API the README leads with** — anyone using
`withOutputGuard` or `outputGuard` could not use it at all.

The fix is a switch rather than a value: the adapter reads the prompt out of each
request it is already forwarding. All three adapters, each reading its own
shape — `messages` for `chat.completions`, `instructions` plus `input` for
`responses`, `system` plus `messages` for Anthropic, and the spec's normalised
`params.prompt` for the AI SDK. Content is read whether it is a string or a list
of parts, and non-text parts contribute nothing.

**Prior assistant turns are deliberately excluded.** The failure being measured
is a model replaying its *input*. Including its own earlier answers would create
a false positive that grows with conversation length, because a model that keeps
its terminology consistent across a long conversation is doing its job. Nothing
is lost in coverage: a model that loses the turn boundary and replays the whole
transcript replays the system and user text too.

**An explicit `prompt` in the options wins**, so a caller with a fixed system
prompt who prefers to state it once is not overridden by what the adapter found.

Also fixed while wiring this: the tool-call branch of the streaming path was
reading the client-wide options rather than the per-call ones, so a
tool-calling stream would not have seen the prompt the rest of the call did.
That path was added in 1.5.0 and never shipped a wrong verdict, because nothing
was per-call until now.

Off by default. `dist/` behaviour is unchanged for any caller who does not set
the new option, and no threshold moved.
