---
"llm-output-guard": minor
---

New opt-in detector: `PROMPT_ECHO`, for a model that returns your prompt instead
of an answer.

```ts
checkOutput(raw, { ...presets.chat, prompt });
```

## Why it needed a detector of its own

A response that replays the system prompt, the question, or a few-shot example is
non-empty, long enough, not repetitive, properly terminated, valid JSON if that
is what the prompt held, in the right script and the right language. **All ten of
the other detectors read it as healthy**, and each of them is right: by every
measure they take, it is.

It shows up most with quantised and self-hosted models, and with a chat template
that has drifted from the one the weights were trained on. The model loses track
of which turn it is in and continues the transcript rather than answering it.

## Runs, not similarity

The question is not how similar two texts are, it is how much of the output the
model actually wrote. A good answer to a detailed question reuses the question's
vocabulary heavily and its *sequences* not at all, so the detector matches runs
of five word tokens (twelve characters in non-spaced scripts). Measured:

```
full echo of the prompt                     1.000
echoed system prompt                        0.953
the question repeated, then an answer       0.463
the whole system prompt, then an answer     0.446
half the system prompt, then an answer      0.354
an answer that shares the question's words  0.060
a clean answer                              0.000
```

`maxPromptEcho` defaults to **0.6** — above every case that still contains an
answer, below every true echo.

The score is a **share**, so partial leaks land in the middle by design and a
longer answer dilutes the same leak further. That is the honest reading: an
output that is 10% leaked prompt and 90% answer is a milder failure than one that
is nothing but prompt. Lower the threshold toward 0.4 to fail those too.

## The false positive it cannot avoid

Rewriting, translating, summarising, fixing grammar, extracting fields: on all of
these, copying from the input **is** the job, and a correct answer scores high.
Nothing in the text separates that from a degenerate echo, because there is no
difference in the text — the difference is in what you asked for.

So it is opt-in, absent from every preset, and requires the prompt to be passed
deliberately. **Do not enable it on a rewrite endpoint.** There is a test
asserting a correct grammar fix scores 0.717, so this cannot later be mistaken
for a bug.

## Limits

**It does not run mid-stream**, for a sharper version of the reason
`SCRIPT_MISMATCH` does not: the score is a share of the whole output, so a
trailing window measures the share of that window. One leak-then-answer response
reads 0.707 over its opening 400 characters and 0.446 across the document.

**It is a `checkOutput` option, not an adapter one.** Adapter options are fixed
when you wrap the client, and the prompt changes per call, so a static value
there would be meaningless. Reading the prompt out of the request is a natural
follow-up and is not in this release.

Off by default and absent from every preset, so nothing changes for an existing
caller. `ReasonCode` gained a member, which is a minor under this package's rule
for an opt-in detector and is still a compile error for a consumer switching
exhaustively over it with a `never` fallback.

New exports: `promptEchoScore`, `promptEchoDetail`, and the types
`PromptEchoOptions` and `PromptEchoResult`.
