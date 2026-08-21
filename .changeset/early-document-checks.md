---
"llm-output-guard": minor
---

New opt-in stream option: `earlyDocumentChecks`, which lets `SCRIPT_MISMATCH`
and `PROMPT_ECHO` judge a stream before it finishes.

```ts
const guarded = guardStream(model.textStream, {
  ...presets.chat,
  expectScript: 'latin',
  earlyDocumentChecks: true,
  onDegenerate: () => controller.abort(),
});
```

Both detectors were deferred to `end()` because they measure a property of the
whole response and a mid-stream check reads a trailing *window* — so what a
window measures is the language of a window. This gives them the right span
instead: the buffer so far. A model answering in the wrong language commits to
it in its first sentence, so the abort lands at around 600 characters rather
than after the whole response is paid for.

## Why it is off by default, with the numbers

The buffer is a **prefix**, and a prefix over-reports both detectors. A response
that opens with a quotation in another script, or leaks the prompt before
answering, is at its worst when the least of it has arrived:

```
                                                240   640  1040  1440   final
opens with a Chinese quote, then English       1.00  0.42  0.26  0.19   0.186
a long English preamble, then Chinese          1.00  0.66  0.39         0.359
leaks the prompt, then answers at length       0.00  0.54  0.33  0.24   0.093
```

Every one of those is a healthy response, and every one reads as totally
degenerate at 240 characters — which is the guard's own warmup.

So a prefix may only condemn a response it is entirely wrong about: nothing is
judged below **600 characters**, and the bar is **0.9** regardless of the
threshold configured. A lowered `maxScriptMismatch` still applies at `end()`,
where the whole response is in scope.

Even so, the worst healthy case above reads 0.66 against a bar of 0.9 — a margin
of 0.24. That is thinner than this package usually accepts, `end()` already
catches all of these with no such risk, and the rule here is that a false
positive is worse than a miss. Hence opt-in.

## The cost, which was the hard part

The obvious implementation is quadratic. Re-scanning the whole buffer on every
check took a 32,000-character stream from 9.06 ms to **65.48 ms** — precisely the
cost `window` exists to prevent, reintroduced by a second span that had no
window of its own.

Both detectors read only the first `maxSample` characters, so once the buffer
passes that the sample stops changing and the score is frozen; any further check
recomputes a number that cannot move. The span is therefore capped at the sample
size, checks stop once it saturates, and until then they run on a doubling
schedule rather than on every check:

| stream | off | on |
|---|---|---|
| 2 KB | 1.21 ms | 1.12 ms |
| 8 KB | 3.36 ms | 4.29 ms |
| 32 KB | 8.99 ms | 10.46 ms |
| 128 KB | 32.03 ms | 33.99 ms |

A stream of any length now gets about five of these checks. A test pins the
property rather than a timing, so the quadratic version cannot come back
unnoticed.

## Also

Passing document scores are merged into the mid-stream verdict, not only failing
ones, so `scores` carries them the way it does everywhere else in this package
and a caller feeding `push()` into their metrics sees the same shape.

Off by default and inert unless `expectScript` or `prompt` is also set, so
nothing changes for an existing caller.
