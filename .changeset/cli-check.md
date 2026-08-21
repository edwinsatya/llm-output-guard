---
"llm-output-guard": minor
---

New CLI command: `llm-output-guard check`, which scores responses you already
have.

```bash
npx llm-output-guard check reply.txt
npx llm-output-guard check logs/*.txt --json > scores.jsonl
cat responses.jsonl | npx llm-output-guard check --jsonl --json
```

## The loop was missing its first half

`calibrate` has asked for a week of logged scores since 0.4, and nothing in the
package produced them. You could derive thresholds from scores, and you could
get scores at runtime through `onVerdict` — but if you already had a directory
of captured responses, there was no way to score them without writing a script
first. A calibration step you have to prepare for is one you do not run.

The two commands now compose with no reshaping between them:

```bash
npx llm-output-guard check logs/*.txt --json | npx llm-output-guard calibrate --fpr 0.001
```

## The exit code is the other half of the point

- **0** — everything passed
- **1** — something was judged degenerate
- **2** — the input could not be read, or the usage was wrong

Distinguishing 1 from 2 is deliberate: in CI, "it found something" and "it broke"
need different responses. That makes `check` an assertion you can drop into a
test job or an eval suite as-is:

```bash
npx llm-output-guard check fixtures/*.txt --preset strictJson --quiet
```

## Reading whatever you already log

Under `--jsonl` the response text is dug out of each line as liberally as
`extractScores` digs out scores, and for the same reason. A bare string, an
obvious field name (`text`, `output`, `content`, `response`, `completion`,
`answer`), a raw OpenAI or Anthropic envelope, or any of those buried one level
down in a wider log record all work.

**Lines carrying no response are counted and reported, not scored as healthy.**
A logged tool-call turn has no assistant text, so it lands in that count rather
than putting an `EMPTY: 1` spike into a calibration run that describes your
agent's tool use instead of any degeneration — the same failure `tool-calls.ts`
exists to prevent at runtime.

## Options

```
--preset <name>  chat | strictJson | longForm | lenient (default chat)
--jsonl          read input as JSONL, one logged response per line
--json           emit a verdict per response as JSONL, for calibrate
--quiet          no per-response output; the exit code is the answer
```

**Existing invocations are unchanged.** `llm-output-guard scores.jsonl` and
`llm-output-guard calibrate scores.jsonl` both still calibrate, with or without
the subcommand word — that has been the documented form since 0.4 and requiring
the word now would break it for every reader of an older README.
