# Calibrating against your own traffic

The shipped presets are tuned on this repo's fixture corpus, which is not your
traffic. This is how you replace them with numbers you can defend.

## If you do not have a week of logged scores

You probably have something better already: the responses themselves. `check`
scores them, and its output is exactly what `calibrate` reads.

```bash
# a directory of captured responses
npx llm-output-guard check logs/*.txt --json > scores.jsonl

# or the response log you already write, one JSON record per line
cat responses.jsonl | npx llm-output-guard check --jsonl --json > scores.jsonl

# the whole loop, in one line
npx llm-output-guard check logs/*.txt --json | npx llm-output-guard calibrate --fpr 0.001
```

Under `--jsonl` the response text is dug out of each line the same way
`calibrate` digs out scores — a bare string, an obvious field name, or a raw
provider envelope all work:

```
"the response text"
{"text":"the response text"}
{"choices":[{"message":{"content":"the response text"}}]}
{"content":[{"type":"text","text":"the response text"}]}
```

Lines carrying no response are **counted and reported**, not scored as healthy.
A logged tool-call turn has no assistant text, so it lands in that count rather
than putting an `EMPTY: 1` spike into your distribution that describes your
agent's tool use instead of any degeneration.

`check` is also an assertion. The exit code is **0** when everything passed,
**1** when anything was judged degenerate, and **2** when the input could not be
read — so it drops into CI or an eval suite as-is:

```bash
npx llm-output-guard check fixtures/*.txt --preset strictJson --quiet
```

## Calibrating against your own traffic

The shipped presets are tuned on the fixture corpus, which is not your traffic.
Log your scores for a week, then let the CLI read them back:

```bash
npx llm-output-guard calibrate scores.jsonl
# or:  cat scores.jsonl | npx llm-output-guard calibrate --fpr 0.001
```

```
8,000 verdicts — flagging budget 0.10% of traffic
! sample is too small for a 0.10% rate: it rests on the top ~8 scores, and
  ~10,000 verdicts are needed before that tail means anything

REPETITION   n=7,993
  p50 0.000   p90 0.000   p99 0.100   p99.9 0.944   max 0.991
  gap 0.114 -> 0.705  (15 above, 0.19% of traffic)
  suggest maxRepetition: 0.409

TAIL_LOOP   n=7,993
  p50 0.000   p90 0.000   p99 0.000   p99.9 0.000   max 0.789
  gap 0.000 -> 0.789  (1 above, 0.01% of traffic)
  suggest maxTailLoop: 0.394
    ! the separation rests on 1 sample; treat it as a lead to confirm, not a
      calibrated threshold
```

Input is JSONL and the parsing is deliberately forgiving — a bare scores
object, a whole `Verdict`, or either of those buried in a wider log record all
work, because a calibration step you have to reshape your logs for is one you
will not run. `--json` emits the same analysis as data.

If you log `modes` alongside `scores`, detectors are segmented by tokenizer and
reported as `TAIL_LOOP [word]` and `TAIL_LOOP [char]`, each suggesting its own
option. Do this if your traffic is not all one script: pooled, the two
distributions produce a single threshold that is wrong for both — word-mode
`TAIL_LOOP` on Indonesian traffic has a healthy maximum near 0.35 where character
mode's is near 0.06.

**What it can and cannot tell you.** The corpus can compute a real margin
because every fixture is labelled. Your logs are not, and no arithmetic
recovers a label that was never written down. So these numbers bound *false
positives* — how much of your own traffic a threshold would flag — on the
assumption that degeneration is rare in it. They say nothing about what a
threshold catches; a detector that never fires has a perfect false-positive
rate. The `gap` line is the exception worth trusting, because a hole between
the bulk and a cluster of outliers is real separation observed in your data
rather than an assumption about rarity — and when that hole rests on one or
two samples, the report says so.

### The same thing, as a function

The CLI is a wrapper. If your scores already live somewhere the shell cannot
reach them — a metrics store, a warehouse query, a test — call `calibrate`
directly. It takes the same flat objects the JSONL format describes:

```ts
import { calibrate } from 'llm-output-guard';

const { n, summaries } = calibrate(
  [
    { REPETITION: 0.03, TAIL_LOOP: 0 },
    { REPETITION: 0.91, TAIL_LOOP: 0.88, modes: { TAIL_LOOP: 'char' } },
    // ...one entry per logged verdict
  ],
  { falsePositiveRate: 0.001 },
);

for (const s of summaries) {
  s.code;               // 'REPETITION'
  s.mode;               // 'word' | 'char', when the samples recorded one
  s.suggested;          // threshold flagging falsePositiveRate of this sample
  s.gap;                // { below, above, count, share } | null — stronger evidence
  s.distribution;       // { n, nonZero, min, max, p50, p90, p99, p999 }
  s.caveats;            // everything that makes `suggested` untrustworthy
}
```

`modes` rides along in the same object and is not read as a score. Log it, and
`summaries` comes back segmented — one entry per `code`+`mode` — for the reason
in the paragraph above. `summarise(code, scores, options)` is exported too, for
when you have one detector's numbers already grouped.

**Read `caveats` before `suggested`.** It is where a sample too small for the
requested rate says so, and a `suggested` number carries no warning of its own.

## Calibrating `AGENT_LOOP` from your own runs

`maxAgentLoop` defaults to **0.4**, and of every threshold this package ships it
is the one resting on the least evidence: eighteen fixtures written in one
sitting, none of them from a real agent. The separation on that corpus is clean
— every healthy run 0.000, the weakest degenerate one 0.455 — but it is clean
against cases chosen by someone who knew what the detector does. Yours are not.

`check --trace` scores runs the way `check` scores responses, so the same loop
closes:

```bash
npx llm-output-guard check runs.jsonl --trace --json \
  | npx llm-output-guard calibrate --fpr 0.001
```

Each line of `runs.jsonl` is one run: a list of turns, on its own or under a
`turns` key. Turns are read as liberally as responses are — a native
`AgentTurn`, or the raw envelope from any provider this package adapts, so
whatever your agent already logs is probably already the right shape:

```jsonl
[{"text":"Reading.","toolCalls":[{"name":"read_file","arguments":{"path":"a.ts"}}]}]
{"run":"job-14","turns":[{"choices":[{"message":{"content":"…"}}]}]}
```

A file that parses whole as one array is read as a single run, so a run logged
as one pretty-printed document needs no reshaping either.

The turns are found under `turns`, `messages`, `history`, `conversation` or
`steps`, at the top level or one object down — so a whole request body, or a run
logged inside a wider record, needs no reshaping.

**A chat history works without reshaping**, which is the shape most people
have: an agent loop keeps a `messages` array and logs that far more often than
it logs raw completion envelopes. Only the model's own messages are read —
`system`, `user` and `tool` messages are skipped rather than counted as turns,
so a run of twelve messages scores on the four the model actually produced.

That gate is not tidiness. A user message spelled
`{ role: 'user', content: [{ type: 'text', … }] }` is shape-identical to an
Anthropic response, so without it a mixed history built a trace from the wrong
speaker.

**Name your polling tools before you calibrate, not after.** `AGENT_LOOP`
cannot tell a job poller from a loop — that is a documented limitation, not a
bug — so a run that polls flags by default, and a sample full of flagged
polling runs teaches you a threshold shaped by false positives:

```bash
npx llm-output-guard check runs.jsonl --trace \
  --ignore-tools get_job_status,sleep,read_clock --json \
  | npx llm-output-guard calibrate
```

`--max-agent-loop`, `--window` and `--min-turns` take the other knobs, so a
candidate threshold can be replayed against the same sample before you commit
to it.

The report is the one you already know, reading the axis it measured:

```
AGENT_LOOP   n=43
  p50 0.000   p90 0.000   p99 1.000   p99.9 1.000   max 1.000
  gap 0.000 -> 1.000  (3 above, 6.98% of traffic)
  suggest maxAgentLoop: 0.500
```

**A `gap` line is worth more here than anywhere else in this document.**
`AGENT_LOOP` is bimodal in a way the prose detectors are not: a run is circling
or it is not, and the scores pile up at 0.000 and near 1.000 with nothing in
between. That makes the gap easy to find and a percentile nearly meaningless —
`p99` on healthy-heavy traffic is 0.000 right up until it is 1.000. Read the
gap, not the percentile, and confirm the runs above it really were stuck before
you move the number.

One caution the report cannot give you. A trace corpus scraped from production
is **survivor-biased against this detector**: if you already kill runs at a turn
limit, every loop in your logs is truncated at that limit, and the coverage
score of a truncated loop is lower than the same loop left to run. Calibrating
on it suggests a threshold tuned to loops you interrupted rather than loops you
would have paid for.

## On thresholds

A miss is annoying. **A false positive is worse**: a healthy response gets discarded and retried against a slower provider for nothing.

So the corpus carries deliberate traps — markdown tables, repeated-prefix lists, code blocks, rhetorical refrains — all of which a naive detector flags. `npm run calibrate` prints the margin between the worst healthy score and the weakest degenerate one:

```
=== TAIL_LOOP [word] ===
  healthy max   :  0.000  (code-block-typescript)
  degenerate min:  0.900  (tail-loop-after-good-start)
  margin        :  0.900  OK

=== TAIL_LOOP [char] ===
  healthy max   :  0.291  (prose-zh-poem-refrain)
  degenerate min:  0.829  (cjk-refrain-x20)
  margin        :  0.538  OK
```

Detectors with two tokenizers are reported per mode, and each detector is scored
only against fixtures labelled for it — otherwise a tail loop that `LOW_ENTROPY`
was never meant to catch drags `LOW_ENTROPY`'s margin negative and the report
reads like a regression in something nobody touched.

If that margin ever goes thin, the answer is a better detector, not a nudged
threshold. That rule is why `REPETITION` has no character mode: the one that was
built came out with a *negative* margin, so it was deleted rather than tuned.

## Growing the corpus

```bash
GROQ_API_KEY=… node scripts/generate-fixtures.mjs --model llama-3.1-8b-instant --n 8
```

Output lands in `test/fixtures/raw/` **unreviewed**. Read each one, label it, then move it into `bad/` or `good/`. Nothing is auto-promoted: a fixture you have not read is a threshold you cannot defend.

---

[← Back to the README](../README.md) · [Try the playground](https://edwinsatya.github.io/llm-output-guard/)
