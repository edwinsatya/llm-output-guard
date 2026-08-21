# llm-output-guard

## 1.7.0

### Minor Changes

- 8a2e214: `expectLang: 'es'` now separates Spanish from Portuguese, Italian and French.

  It did not before. The profile held the twenty commonest Spanish function words
  — `de`, `que`, `por`, `para`, `no`, `se`, `como` — and most of those are shared
  with the other Romance languages. Since the score is `(best - target) / best`
  across every profile, a shared word raises `target` as much as `best` and the
  score collapses. A Portuguese answer scored **0.36** against `expectLang: 'es'`
  and passed a check that existed to catch exactly that.

  Rebuilt the way every other profile is: from where the languages differ rather
  than from what is commonest. `y`/`e`, `es`/`é`/`è`, `no`/`não`/`non`,
  `muy`/`muito`/`molto`, `pero`/`mas`/`ma`, `cuando`/`quando`, `donde`/`onde`/`dove`,
  `sin`/`sem`/`senza`, `hasta`/`até`/`fino`.

  Measured over two unrelated sample sets, a response in another language scored
  against `'es'`:

  ```
         before          after
  pt     0.36 / 0.50     0.91 / 0.75
  it     0.83 / 0.33     1.00 / 1.00
  fr     0.30 / 0.33     1.00 / 1.00
  nl     0.69 / 0.73     1.00 / 1.00
  ```

  Every one of those crossed the 0.6 default. Nothing else moved.

  ## Why this is a minor and not a major

  Changing a threshold or a preset number is a major here, and swapping a word
  list looks like the same kind of change. It is not, because the semver table
  also covers "making an existing detector strictly more accurate on its own
  axis" — and the measurements say that is what this is:

  - **catches strictly more**: four languages cross the threshold that did not
  - **false-positives no more**: Spanish still scores 0.000 against itself on both
    sample sets, as does every other language against itself
  - **disturbs nothing else**: no other expectation's verdict changes, in either
    direction, on any pair

  The only responses whose verdict changes are ones that were being missed. Nobody
  can be relying on `expectLang: 'es'` passing a Portuguese answer.

  The limitation was documented in the README, in `docs/detectors.md` and in
  `src/detectors/language.ts`, and pinned by a test asserting the weakness. All
  four now say the opposite, and the test asserts the fix.

## 1.6.0

### Minor Changes

- 4ecf094: `PROMPT_ECHO` now works from the adapters, via `checkPromptEcho: true`.

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
  is a model replaying its _input_. Including its own earlier answers would create
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

- 0a05645: New CLI command: `llm-output-guard check`, which scores responses you already
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

- c4e8a22: New opt-in stream option: `earlyDocumentChecks`, which lets `SCRIPT_MISMATCH`
  and `PROMPT_ECHO` judge a stream before it finishes.

  ```ts
  const guarded = guardStream(model.textStream, {
    ...presets.chat,
    expectScript: "latin",
    earlyDocumentChecks: true,
    onDegenerate: () => controller.abort(),
  });
  ```

  Both detectors were deferred to `end()` because they measure a property of the
  whole response and a mid-stream check reads a trailing _window_ — so what a
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

  | stream | off      | on       |
  | ------ | -------- | -------- |
  | 2 KB   | 1.21 ms  | 1.12 ms  |
  | 8 KB   | 3.36 ms  | 4.29 ms  |
  | 32 KB  | 8.99 ms  | 10.46 ms |
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

- bafe251: `expectLang` grows from three languages to eight: `pt`, `it`, `fr`, `de` and
  `nl` join `id`, `en` and `es`.

  `SCRIPT_MISMATCH` covers every cross-alphabet case, which left the same-alphabet
  half — the one that has to tell French from Portuguese — knowing three
  languages, none of which are the ones most often confused with each other.

  ## A profile is not a frequency list

  The score is `(best - target) / best` across every profile, so a word that two
  languages both own raises `target` as much as `best` and pushes the score toward
  zero. Building a profile from a language's _commonest_ function words therefore
  builds the worst possible profile: those are exactly the words its neighbours
  share.

  The new profiles are built from where neighbouring languages differ instead —
  `não`/`no`, `com`/`con`, `em`/`en`, `uma`/`una`, `do`/`del` for Portuguese
  against Spanish; `il`/`el`, `di`/`de`, `che`/`que`, `gli`, `più` for Italian;
  `les`, `des`, `du`, `dans`, `avec`, `cette` for French.

  Measured over two unrelated sample sets per language: every language scores
  **0.000** against itself, and every expectation other than `es` scores **0.70 or
  better** against every other language.

  ## `expectLang: 'es'` is the weak expectation, and it stays that way

  The `es` profile predates that rule and is built from precisely the generic
  Romance words it warns against — `de`, `que`, `por`, `para`, `no`, `se`, `como`
  — which hit Portuguese, Italian and French text nearly as hard as they hit
  Spanish. Across the two sample sets:

  ```
  pt 0.36 / 0.50     it 0.83 / 0.33     fr 0.30 / 0.33
  ```

  Those sit under the 0.6 default, so **`expectLang: 'es'` does not reliably catch
  Portuguese, Italian or French**, and `expectScript` cannot help because all four
  share the Latin alphabet. It still catches English, Indonesian, German and Dutch
  comfortably.

  Re-choosing the `es` profile would fix it and is a behaviour change, so it waits
  for a major. The limitation is documented in the README, in `docs/detectors.md`,
  and asserted in tests so it cannot be mistaken for a bug later or quietly get
  worse.

  ## The regression that did not happen

  Adding a profile adds a candidate for `best`, so a new language that out-scored
  `en` on English text would have started failing healthy English responses. All
  three original languages still score 0.000 on their own text across both sample
  sets, and there is a test that says so.

  `supportedLanguages` now reads `['id', 'en', 'es', 'pt', 'it', 'fr', 'de', 'nl']`.
  Still opt-in, still absent from every preset.

## 1.5.0

### Minor Changes

- cb8fb96: New opt-in: `checkToolArguments`, for a model that loops inside the arguments it
  passes to a tool.

  ```ts
  const client = withOutputGuard(new OpenAI(), {
    ...presets.chat,
    checkToolArguments: true,
  });
  ```

  Available on all three adapters — `./openai` (both `chat.completions` and
  `responses`), `./anthropic`, and `./ai-sdk`.

  ## The hole

  1.0.1 established that a tool-calling turn is judged by its **preamble**, because
  the text beside a tool call is not the answer. That was right, and it left the
  answer itself unmeasured. The README said so and pointed at the provider's schema
  validation as the thing covering it.

  Schema validation covers _types_. A model that loops does not produce the wrong
  type — it produces a valid string with nothing in it:

  ```json
  {
    "query": "site reliability engineering site reliability engineering …",
    "limit": 10
  }
  ```

  That is a schema-valid `string`. The provider hands it to your tool without
  complaint, and you have issued a garbage search — or, if the tool writes,
  persisted the loop. For anyone running agents this was invisible, on the traffic
  shape agents produce most.

  ## What it measures

  Redundancy only, per string value, under the thresholds your guard already uses.
  Reason codes are unchanged, so existing handling keeps working; the `message`
  says the loop was found in an argument. `message` is outside this package's
  semver promise, which is what makes it the right place to put that.

  Everything else is deliberately off. `LOW_ENTROPY` because JSON is legitimately
  repetitive at the character level — the same reason `presets.strictJson` turns it
  off. `TRUNCATED`, `TOO_SHORT` and `INVALID_JSON` because the provider already
  guarantees the arguments parse and match the schema. `SCRIPT_MISMATCH` and
  `LANG_MISMATCH` because an argument is not prose addressed to a user, and a query
  in another language is ordinary rather than degenerate.

  Values are measured individually, never as a serialised document — two calls
  against one schema are legitimately near-identical documents, which is the rule
  `redundancyScope: 'jsonValues'` already follows.

  ## The false positive it would otherwise have shipped

  A tool that takes no parameters is called with `{}`, and `{}` is one of the
  shapes `emptinessScore` exists to catch — so the obvious implementation scores
  `EMPTY: 1` and fails every call to a no-argument tool. That is the 1.0.1
  tool-call bug again in a new place, and it was caught by a test rather than by
  review.

  Arguments carrying no strings at all (`{"lat":-6.2,"zoom":11}`) are skipped for
  the same reason: no content to judge, so no verdict is manufactured. A call with
  nothing measurable and no preamble reports nothing, following `checkPreamble`'s
  existing `null` rule so a calibration run is not poisoned with `EMPTY` spikes
  that describe an agent's tool use.

  ## Limits

  **Non-streaming responses only.** Arguments arrive as JSON fragments that do not
  parse until the call is complete, so there is nothing meaningful to measure
  mid-stream.

  Off by default and absent from every preset, so nothing changes for an existing
  caller. Switching it on can only make a response fail that previously passed.

- b6cd92b: New opt-in detector: `PROMPT_ECHO`, for a model that returns your prompt instead
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
  vocabulary heavily and its _sequences_ not at all, so the detector matches runs
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

### Patch Changes

- cb8fb96: Add `npm run bench`, and publish what `checkOutput` actually costs.

  Documentation and tooling only. No behaviour changed, no threshold moved, no
  export added.

  The README has called this package "safe on a hot path" since 0.1, which is a
  latency claim, and there was no latency figure anywhere near it. The only
  numbers that existed were in a comment in `stream.ts`, cited to justify
  deferring `LOW_ENTROPY` off the mid-stream path.

  ```
  checkOutput(presets.chat)      p50        p99
    500 B                     0.383ms    0.480ms
    2 KB                      0.457ms    0.553ms
    8 KB                      0.677ms    0.858ms
    32 KB                     1.014ms    1.235ms
  ```

  The breakdown is the useful part. At 2 KB, `LOW_ENTROPY` is **0.376 ms** and the
  other six detectors together are **0.081 ms** — the LZ77 pass is roughly 80% of
  the cost of a full check. So there is exactly one latency lever in this package,
  and `presets.strictJson` already pulls it: it sets `maxCompressibility: null`
  because JSON is legitimately repetitive, and measures 0.082 ms against `chat`'s
  0.457 ms as a side effect.

  `npm run bench` prints the table; `npm run bench -- --json` emits it for tracking
  over time. The script documents why its own absolute numbers should not be
  quoted as a promise: they are wall-clock timings on one machine with a warm JIT,
  and the ratios between detectors are the part that travels.

- 14e8ce1: Cut the README back down, add four badges, and give performance a page of its own.

  Documentation only. No behaviour changed, no threshold moved, no export added.

  1.3.1 restructured this README from 37 KB to 13 KB on the argument that a
  reliability library gets about thirty seconds to explain itself. Four releases
  of features since then took it back to **16.9 KB and 2,499 words**, mostly by
  adding good material to the wrong file.

  It is now **12.2 KB and 1,685 words**, a third shorter, and the rule is the one
  1.3.1 set: **nothing was deleted, only moved.**

  - **Structured output** — 55 lines of `requiredKeys`, Standard Schema, the
    synchronous-validation rule — moved to `docs/detectors.md`. The README keeps a
    six-line example and a link.
  - **The benchmark tables** moved to a new `docs/performance.md`, along with the
    measurement caveats and the `maxCompressibility` lever. Design notes keep the
    headline: sub-millisecond, one detector accounting for most of it.
  - **`SCRIPT_MISMATCH` and `PROMPT_ECHO`** each had a section explaining their
    reasoning; both now sit in a shared **Common setups** section at a few lines
    apiece, pointing at the reference for the numbers.
  - **Script coverage** folded into a Design notes bullet, which is where a reader
    deciding whether to install actually needs it.

  The **Stability** section stays in the README, tightened but not relocated, for
  the reason 1.3.1 gave: it is what tells a reader what a version number means
  here, and it should not require a second click.

  Every internal link, anchors included, is verified to resolve.

  ## Badges

  Four added, and the row split in two: what you are installing (npm, downloads,
  min+gzip, dependencies, types, node) above whether it is looked after (CI, last
  commit, commit activity, licence).

  **Every GitHub-backed badge carries an explicit `cacheSeconds`,** because the
  defaults are dangerous here. `last-commit` and `commit-activity` ship
  `max-age=120`, which has camo refetch them **720 times a day** — 720 daily
  chances to catch GitHub's API rate limited and pin the error badge for its whole
  TTL. That is the failure 1.4.1 fixed on the downloads badge, and these two were
  36× more exposed to it. They are now 6 hours and 24 hours respectively.

  Five candidates were measured and rejected rather than added: `repo-size`
  reports 832 KiB for a package that ships 5 KB, `contributors` reads 1,
  `stars` renders no value at all, `issues` reads "0 open" which says nothing
  either way, and `v/tag` duplicates the npm version badge.

## 1.4.1

### Patch Changes

- Cache the downloads badge for a day, so the npm listing stops showing
  `rate limited by upstream service` where a number belongs.

  Documentation only. `dist/` is byte-identical to 1.4.0 — no behaviour changed,
  no threshold moved, no export added.

  The badge was rendering that text on both the repo page and the npm listing
  while the endpoint itself was healthy, which took some measuring to explain.
  GitHub proxies README images through camo, camo honours the image's own
  `cache-control`, and shields.io returns its error badge with `max-age=7200`. So
  one moment when shields was rate limited against `api.npmjs.org` got pinned to
  the page for two hours, long after the underlying service recovered.

  The default TTL made that likely rather than unlucky: at 7200s camo refetched
  **twelve times a day**, i.e. twelve daily chances to catch shields mid-failure
  and cache the result. `cacheSeconds=86400` cuts that to one.

  Nothing is lost by slowing it down. `api.npmjs.org` recomputes download counts
  once a day, so the two-hour refresh was churning against a number that had not
  moved. Changing the URL also drops camo's stale entry, which is what unstuck the
  repo page immediately.

  Published rather than left in the repo because a package page renders the README
  baked into its tarball, so the npm listing can only pick this up through a
  release — the same reason 1.0.1 exists.

## 1.4.0

### Minor Changes

- 89e00a4: New opt-in detector: `SCRIPT_MISMATCH`, for a model that answered in the wrong
  alphabet.

  ```ts
  checkOutput(raw, { ...presets.chat, expectScript: "latin" });
  ```

  A model that ignores "answer in English" does not return broken English, it
  returns fluent Chinese — with a `200 OK`. `LANG_MISMATCH` was the only thing
  here that looked at language, and it is the weakest detector in the package by
  its own admission: three languages, a function-word list, and unreliable under
  25 words. It cannot see this failure at all for Chinese, Japanese, Korean,
  Russian, Arabic, Hindi, Greek, Hebrew or Thai, because it does not know those
  languages.

  Counting characters answers the easier question — _is this even the right
  alphabet_ — and answers it with no word list and no minimum a two-sentence reply
  cannot meet. Measured on this repo's corpus:

  ```
  full answer in the wrong script, against expectScript: 'latin'
    zh 1.000   ja 1.000   ko 1.000   ru 1.000   ar 1.000
    hi 1.000   el 1.000   he 1.000   th 1.000

  healthy response against the script it is written in
    0.000 – 0.028      (0.028 is Korean prose quoting Latin API names)
  ```

  The default `maxScriptMismatch` is **0.5**, sitting between those with room on
  both sides. The worst healthy case anyone constructed — an English answer that
  quotes a long Chinese passage — scores 0.184, and is now a corpus fixture.

  **Code fences, inline code and URLs are stripped before measuring.** Every
  identifier in a TypeScript block is Latin because TypeScript is, and counting
  them is how a correct Chinese answer gets discarded: the new
  `prose-zh-with-code-fence` fixture scores 0.000 as shipped and 0.632 with
  `ignoreCode` disabled. A response that is _only_ a code block abstains entirely.

  **Pass every script the answer may legitimately contain** — `['han', 'latin']`
  for Chinese, `['han', 'kana', 'latin']` for Japanese. Kana alone scores 0.314 on
  healthy Japanese prose, because Japanese uses both.

  **It is a separate code from `LANG_MISMATCH`, not a replacement for it.** Spanish
  against English scores 0 here and is exactly what the function-word profile is
  for. The two compose, report separate scores, and are calibrated separately — a
  share of letters and a relative share of function-word hits are different
  distributions, and one histogram holding both describes neither. `calibrate`
  learned `maxScriptMismatch` accordingly.

  **It does not run mid-stream, deliberately.** Which language a model answered in
  is a property of the whole response, and a mid-stream check reads a trailing
  window. On the English-quoting-Chinese shape: 0.114 across the document, 0.206
  over the last 1000 characters, 0.500 over the last 400 — the document is healthy
  and the window says it is half wrong. The early signal is one line for anyone who
  wants it, and `stream.ts` documents it:

  ```ts
  const verdict = checkOutput(guard.text, { expectScript: "latin" });
  ```

  Off in every preset, so nothing changes for an existing caller who does not ask
  for it. New exports: `scriptMismatchScore`, `scriptProfile`, `supportedScripts`,
  and the types `ScriptName` and `ScriptOptions`.

  One thing to know before upgrading: `ReasonCode` gained a member. That is a
  minor under this package's own rule for an opt-in detector, and it is still a
  compile error for a consumer who switches exhaustively over `ReasonCode` with a
  `never` fallback.

### Patch Changes

- ff83a0d: Give the README a logo and a downloads badge, and correct the size claim.

  The mark is the pitch as a picture: five blocks that vary in height and hue,
  then four that are identical in all three, then the guard. It is
  `assets/logo.svg`, 2.9 KB, and it is solid shapes rather than drawn lines for
  one reason: an earlier stroked version was fine at 560px and turned to mush at
  the 220px the README actually displays.

  Two constraints shaped it, both worth writing down because the obvious version
  of each is wrong:

  - **It is referenced by absolute `raw.githubusercontent.com` URL, not a relative
    path.** GitHub resolves `./assets/logo.svg`; npmjs.com does not do so
    reliably, and the npm listing is the page most people see first.
  - **It carries one palette rather than a `prefers-color-scheme` swap.** An SVG
    loaded through an `img` tag cannot be styled by the host page, and npm strips
    `style` elements out of README SVGs, so a theme swap would work on GitHub and
    silently fail on npm. All seven colours clear 3:1 against white _and_ against
    `#0d1117` on their own, worst case 3.06.

  That last point is why the mark does not use the playground's palette: `--accent`
  `#10617a` measures 2.68 on a dark ground, and the dark `--fail` `#e08074`
  measures 2.80 on white. Each is correct in a page that knows its own theme, and
  this file never does.

  Nothing in the mark carries an opacity, and that is a fix rather than a
  preference: the blocks do not overlap, so the `0.9` it shipped with mid-draft
  bought no blending while compositing the two lightest teals down to 2.55 and
  2.88 on white, under the bar for no visible gain.

  `assets/` stays outside the `files` allowlist, so the published tarball carries
  the README and not the image it links to.

  Two smaller fixes rode along:

  - **`~3 KB gzipped` was wrong, and had been for a while.** Measured against
    `680ca66`, the whole entry was already 4,784 B min+gzip before this release,
    and `SCRIPT_MISMATCH` adds 523 B on top, so it now reads `~5 KB`. The number
    sits three lines above a badge that displays the real one, in a README whose
    credibility rests on claims being measured.
  - **The size badge moved from bundlephobia to bundlejs.** Bundlephobia's API has
    been answering `429 rate limited by upstream service`, which renders as that
    text in place of a number. bundlejs reports the same figure and is up.

## 1.3.1

### Patch Changes

- 4a408af: Restructure the README as a landing page, and add badges.

  It was 37 KB and roughly 5,000 words — thorough, and the wrong shape for the
  thirty seconds someone spends deciding whether to install a reliability library.
  `## Usage` alone ran 421 lines before the detector table appeared.

  The README now leads with the problem, the install, a nine-line example, and the
  detector table, and it is 13 KB. Badges for version, min+gzip size, the
  zero-dependency claim, CI and licence sit above the fold, because "3 KB and no
  dependencies" is the pitch and it was previously buried in Design notes.

  **Nothing was deleted, only moved.** The long-form material is now five files
  under `docs/`, each linked from the section that summarises it:

  - `docs/detectors.md` — the full reference, every exported scorer, and the
    repeated-records case
  - `docs/adapters.md` — OpenAI, Anthropic and the Vercel AI SDK in full, plus
    tool-call handling
  - `docs/streaming.md` — mid-stream detection and the measured latencies
  - `docs/calibration.md` — the CLI, the programmatic form, and how thresholds are
    set
  - `docs/script-coverage.md` — what works on Chinese, Japanese and Thai, and the
    measurements behind what does not

  The **Stability** section stays in the README, including the 0.4.2 incident. It
  is a trust asset, not an appendix — it is the part that tells a reader what a
  version number means here, and it should not require a second click.

  `docs/` remains outside the `files` allowlist, so the published tarball is
  unaffected apart from the smaller README. A `.nojekyll` file keeps GitHub Pages
  serving the playground as written now that Markdown sits beside it.

- 4a408af: `requiredKeys` no longer accepts a name inherited from `Object.prototype`.

  The check was `k in record`, which walks the prototype chain — so seven names
  were reported as present on a payload that never contained them:

  ```ts
  jsonScore('{"score":8}', { requiredKeys: ["constructor"] }); // score 0, "present"
  ```

  `toString`, `valueOf`, `constructor`, `hasOwnProperty`, `isPrototypeOf`,
  `propertyIsEnumerable` and `toLocaleString` all passed. `constructor` is the one
  plausible in a real contract — a payload describing a builder or a class — and it
  silently disabled that key's check.

  Now `Object.hasOwn`. The contract is "keys the payload must contain", and an
  inherited name is not one the model wrote. A payload that genuinely declares
  `"constructor"` still satisfies it.

  No other behaviour changes: verified byte-identical to the published 1.2.1 across
  all 228 fixture × preset combinations.

- 4a408af: Two detectors were reading characters they should not have been.

  **`TRUNCATED` counted brackets and fences inside string literals.** A JSON
  payload carrying a code snippet — an extremely ordinary thing for a model to
  return — put those characters inside a value, and complete, valid JSON scored as
  cut off:

  ````ts
  truncationScore('{"note":"the opening brace { is literal","done":true}'); // 0.8
  truncationScore('{"snippet":"```js","done":true}'); // 0.9
  ````

  A document that parses is complete by definition, which is stronger evidence
  than the heuristics were reaching for, so a parseable payload now scores 0. The
  provider's own stop reason still wins: a response can be both parseable and cut
  short at the token ceiling. Genuinely truncated text is unaffected — an unclosed
  fence still scores 0.9, an unclosed object 0.8, a severed sentence 0.55.

  Gated on the first character, so prose costs one comparison rather than a parse
  attempt.

  **`LANG_MISMATCH` returned `NaN` for any language name on `Object.prototype`.**
  The guard was `expected in PROFILES`, which walks the prototype chain, so
  `expectLang: 'constructor'` passed it, then read a function as the target share
  and produced `NaN` — a score neither above nor below any threshold, silently
  disabling the detector and poisoning any histogram built from it. Now
  `Object.hasOwn`, and an unmodelled language abstains at 0 as documented.

  Same root cause as the `requiredKeys` fix in this release. Verified byte-identical
  to the published 1.2.1 across all 228 fixture × preset combinations: the corpus
  contains no payload with a brace inside a string, which is exactly why neither
  bug was caught.

## 1.3.0

### Minor Changes

- 39ab363: Add `redundancyScope`, which stops a JSON array of repeated records being read as
  a loop.

  A model asked for the status of twenty services and returning twenty identical
  rows has done exactly what it was told. Measured across the document that is a
  perfect loop, and 1.2.1 scores it `TAIL_LOOP: 1.000` and fails it under **every
  preset — `lenient` and `strictJson` included**. Three identical records is enough
  to trip it, and an array that is only 75% repetitive fails on `REPETITION`.
  `strictJson` is the preset most likely to be pointed at exactly that payload.

  The scores were never wrong: twenty identical records _are_ exactly periodic. The
  detectors were being asked about the wrong span.

  ```ts
  checkOutput(raw, { ...presets.strictJson, redundancyScope: "jsonValues" });
  ```

  Under `'jsonValues'`, `REPETITION` and `TAIL_LOOP` read each string value of a
  parsed payload on its own, on the rule that repetition **across records** is the
  shape that was requested and repetition **inside a value** is the signal.

  **It is more sensitive, not less.** A loop confined to one element of an array is
  averaged away across a document — 1.2.1 misses a 30× repeated Chinese clause
  sitting in one of five array items entirely — and reads 1.000 when that element
  is measured alone. So this removes a false positive and closes a false negative
  in the same change.

  Text that does not parse is measured as a document regardless, so prose, a
  truncated payload and every mid-stream check behave exactly as before. Only the
  two redundancy detectors are scoped; `LOW_ENTROPY`, `TRUNCATED`, `INVALID_JSON`,
  `EMPTY`, `TOO_SHORT` and `LANG_MISMATCH` read the whole response as they always
  have.

  The default stays `'document'`, and that default is asserted byte-identical to
  the published 1.2.1 tarball across all 228 fixture × preset combinations —
  compared against the release, not against itself. No preset or threshold changed.

  Left opt-in rather than made the default deliberately. Switching it on by default
  would change which production responses get discarded, which this package's
  stability table calls a major, and 1.0.0 shipped four days ago.

## 1.2.1

### Patch Changes

- 4edc66b: Add a browser playground at `docs/`, published to GitHub Pages.

  Every detector, running on this repo's own fixtures or on your own pasted
  output. No API key and no request: the library is bundled into the page rather
  than fetched, so the numbers on screen are what `checkOutput` actually returns
  rather than a reimplementation that can drift. That this is possible at all is a
  consequence of the package being zero-dependency, pure and synchronous.

  Each detector is drawn as a meter — a track filled to the score, with a tick at
  the threshold — which is the one component that explains the whole model: scores
  rather than booleans, every detector running even after one fails, and a greyed
  track for a detector the current preset disables.

  The specimens are the fixtures themselves, read from `test/fixtures` at build
  time rather than copied, so a fixture edited there is a specimen changed here.
  They include the traps as prominently as the failures: a markdown table, repeated
  list prefixes, a rhetorical refrain, a Chinese poem refrain. False positives cost
  more than misses, and that is easier to show than to assert.

  Each specimen is pinned to the preset it is written for, and the page says so
  when you switch away — `presets.chat` leaves truncation and JSON off entirely, so
  a truncated specimen judged by it is not being missed, it is not being asked
  about. Without that, two labelled-degenerate fixtures pass under the default
  preset and the demo reads as broken rather than as a lesson about presets being
  contracts for a task. The build refuses to emit a specimen whose label does not
  hold under some preset.

  The page is bundled from `src/` with esbuild rather than assembled from
  `dist/index.js`, which is code-split — its first line is
  `export { checkOutput, ... } from './chunk-XHP4LSIH.js'`. Inlining that produced
  a page that asked the browser for a chunk nobody had copied, failed to load the
  module, and rendered an empty shell. It failed _silently_: the file parsed, held
  no placeholder, made no external request, and passed a theme audit. Every check
  short of running it said the page was fine.

  So `test/playground.test.ts` executes the real module against a real DOM and
  asserts the page populated — specimens, presets, all eight meters, a computed
  verdict, and a verdict that flips when a trap is selected. Those tests fail
  against the broken build and pass against this one. A staleness check on the
  stamped version catches the other half, since CI reads the committed page.

  `npm run playground` regenerates it, and `prepublishOnly` now runs it, so a
  release cannot ship a demo that lags the library. `docs/` is outside the `files`
  allowlist and adds nothing to the published tarball.

## 1.2.0

### Minor Changes

- 4a3241d: Add a `./anthropic` adapter for the Messages API.

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

- 4a3241d: Add a `schema` option, accepting any Standard Schema validator.

  `requiredKeys` only ever asked whether a name was present. A model returning
  `{ "score": "very good" }` where you wanted a number satisfied it completely and
  still broke everything downstream that did arithmetic — the check passed, the
  response was useless, and nothing said so.

  ```ts
  const verdict = checkOutput(raw, { ...presets.strictJson, schema: Review });
  ```

  Zod 4, Valibot and ArkType all implement [Standard Schema](https://standardschema.dev),
  and so does anything else that wants to. **This adds no dependency:** the spec is
  types-only, so the interface is vendored in `src/standard-schema.ts` and the
  validator is one you already have. The package still installs with nothing behind
  it, and the main entry point still has no peers.

  On success `Verdict.json` is the schema's _output_ rather than the raw parse, so
  defaults, coercions and transforms are applied and the value matches the type you
  declared. On failure the reason is `INVALID_JSON` with the failing path in the
  message — `score: Expected number, received string`. The same code as a missing
  key or an unparseable payload, because it wants the same handling: retry, or fall
  through to another provider. Giving it a code of its own would have widened a
  frozen union and split existing handling for nothing.

  `requiredKeys` and `schema` compose, and keys are checked first, so a missing key
  is still reported as a missing key rather than as whatever the schema calls it.

  **A schema must validate synchronously**, and one that does not throws a
  `TypeError` saying so. `checkOutput` being synchronous is a load-bearing promise
  rather than an implementation detail — it is what makes the guard safe on a hot
  path and trivial to test. The alternative to throwing was to silently pass, which
  would disable the check the caller asked for, or to silently fail, which would
  blame the model for the caller's wiring. In practice this is reached only by a
  schema carrying an async refinement. It remains true that nothing throws about a
  _response_.

  Tested against all three libraries rather than one, because the spec is types-only
  and they disagree at runtime about issue paths — Valibot and ArkType return
  segment objects where Zod returns bare keys.

- 2b06dcb: Guard `responses.create` on the `openai` adapter.

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

### Patch Changes

- 4a3241d: Fix type resolution for CommonJS TypeScript consumers.

  The `exports` map declared `types` once per subpath, pointing at the ESM `.d.ts`.
  From a CommonJS project using `moduleResolution: node16`, TypeScript resolved
  that ES-module declaration and then refused it — `TS1479: the referenced file is
an ECMAScript module and cannot be imported with 'require'` — on every entry
  point, including the root.

  Nothing was wrong at runtime: `require('llm-output-guard')` always returned the
  real `.cjs`. It broke the _build_ of any CJS TypeScript consumer, which is a
  worse place to find out and an easy one to mistake for a problem in your own
  tsconfig.

  Each subpath now declares types per condition, so `import` resolves `.d.ts` and
  `require` resolves `.d.cts`. Both declaration flavours were already being built
  and shipped in the tarball; the map simply never pointed at the second one.

  Verified across six combinations — CommonJS and ESM consumers, each under
  `node16`, `nodenext` and `bundler` — and asserted in `test/surface.test.ts`,
  because the single-`types` form looks equivalent and is not.

  Found while adding `./anthropic`, which would otherwise have shipped as a fourth
  entry point with the same defect.

- 2b06dcb: Stop failing every tool call as `EMPTY`.

  A model that answers by calling a tool returns no assistant text: OpenAI sends
  `content: null` beside `tool_calls`, and the AI SDK sends a `content` array with
  no `text` part. Both adapters concatenated text parts and handed the result to
  `checkOutput`, which scored the empty string `EMPTY: 1` and threw — correctly for
  the question it was asked, and uselessly, because it was asked the wrong one.

  The effect was that `withOutputGuard(new OpenAI())` and `outputGuard()` threw
  `DegenerateOutputError` on every tool-calling turn of every agent. It went
  unnoticed because the whole fixture corpus is prose, and no fixture made of prose
  can contain a tool call.

  Both adapters now treat the presence of tool calls as meaning the text, if any,
  is a preamble rather than the answer. A text-free tool call is not judged at all
  and reports nothing to `onVerdict` — an `EMPTY` there would put a spike of
  `EMPTY: 1` samples into every `calibrate` run, describing an agent's tool use
  rather than any degeneration. Text beside a call is still measured for redundancy,
  because a model looping in its preamble is still a model that is looping;
  `TOO_SHORT`, `TRUNCATED` and `INVALID_JSON` are switched off for it, each of
  which failed healthy tool calls under `presets.longForm` or `presets.strictJson`.

  `EMPTY` is not disarmed: a response with neither text nor tool calls still fails,
  which is the case this package exists for. Both halves are covered by
  `test/tool-calls.test.ts`.

  A patch rather than a minor: no name, option or threshold changed, and the only
  responses whose verdict moves are ones that were being failed wrongly.

## 1.0.1

### Patch Changes

- Document every public export by name. No code changes.

  The detectors table listed reason codes and promised that "every detector is
  exported on its own", but never gave the function names — nothing told a reader
  that `REPETITION` is reached through `repetitionScore`. Fourteen of the
  twenty-three exports were unnamed anywhere in the README. At 1.0 those names are
  the most stable thing in the package, so being the least discoverable part of it
  was the wrong way round.

  The table now carries an `Exported as` column, followed by the four signatures
  that do not follow `(text, options?) -> number`: `shortnessScore` takes its
  minimum positionally, `stripFence` returns a string, `jsonScore` and
  `tailLoopDetail` return detail objects, and `supportedLanguages` is a value
  rather than a function.

  `calibrate` and `summarise` were documented only as a CLI. The programmatic form
  is now written down — the `Summary` fields, how logging `modes` segments the
  result into one summary per code and tokenizer, and the note that `caveats` is
  worth reading before `suggested`, since a suggested threshold carries no warning
  of its own.

  Published so the npm page matches the repo: a package page renders the README
  baked into its tarball, so documentation only reaches npm through a release.

## 1.0.0

> **Upgrading from 0.5.0: the only break is two removed exports.** If you do not
> import `percentile` or `findGap` from `llm-output-guard`, this release is a
> no-op for your code — no threshold moved, no preset changed, and every detector
> scores exactly what it scored in 0.5.0. `calibrate` and `summarise` are
> untouched, and the useful half of `findGap` is already public as `Summary.gap`.
> If you do import them, they were generic statistics over a **pre-sorted
> ascending** array; copy them into your own code rather than sorting at the call
> site and hoping.
>
> **What 1.0.0 is** is the point where **Stability** in the README stops being an
> intent and starts binding. The rule to read before you pin: _threshold and
> preset value changes ship in a major here_, because they do not break your
> build — they change which of your production responses get discarded and
> retried, which is invisible until your traffic hits it. So `^1.0.0` will not
> quietly start rejecting traffic it used to pass.

### Major Changes

- 15e1e38: Freeze the public API for 1.0, and remove two exports rather than support them.

  `percentile` and `findGap` are no longer exported from the root. Both shipped in
  0.4.0, were mentioned only in that release's changeset, and were never documented
  anywhere a user would look. Both also take a **pre-sorted ascending** array and
  return confidently wrong numbers when given anything else — a precondition that
  is fine for the internal callers they were written for, and a poor thing to
  promise for a year. The useful half of `findGap` is already public as
  `Summary.gap`, and `percentile` is generic statistics with nothing to do with
  what this package is about. `calibrate` and `summarise` are unaffected.

  Nothing else changes. The rest of the surface was audited export by export and
  kept deliberately:

  - **Core** — `checkOutput`, `assertOutput`, `DegenerateOutputError`, `presets`.
  - **Streaming** — `createStreamGuard`, `guardStream`.
  - **Detectors, individually** — `emptinessScore`, `shortnessScore`,
    `repetitionScore`, `tailLoopScore`, `tailLoopDetail`, `compressibilityScore`,
    `compressionRatio`, `truncationScore`, `jsonScore`, `stripFence`,
    `languageMismatchScore`, `languageProfile`, `supportedLanguages`. The README
    has always promised these individually and they are cheap to keep stable.
    `tailLoopDetail` sits alongside `tailLoopScore` rather than replacing it: the
    `...Score` naming matches the other seven detectors, and the detail form is
    what you need when the tokenization mode matters.
  - **Calibration** — `calibrate`, `summarise`.
  - **Types** — `CheckOptions`, `Verdict`, `Reason`, `ReasonCode`, `TokenMode`, the
    per-detector options types, and the calibration result types.

  The two adapter subpaths export `outputGuard` / `withOutputGuard`,
  `OutputGuardOptions` and `DegenerateAction` and nothing else.

  **`AdapterGuardOptions` is internal and stays internal**, at 1.0 and after. It is
  exported from no subpath and reachable by no import path a user has. Each
  adapter's `OutputGuardOptions` is its own public contract; they share a base
  today and are free to diverge tomorrow. That is what keeps a future
  provider-specific option cheap — it goes on that subpath's interface, and no
  shared type has to be widened or split after a freeze. `DegenerateAction` _is_
  public through both subpaths, so its members are covered by semver on each.

  The **Stability** section shipped with the README in 0.5.0; 1.0.0 is where it
  starts binding. Its load-bearing rule is the one the usual semver wording leaves
  ambiguous: **threshold and preset value changes are behaviour changes and ship in
  a major**, because they do not break a build — they change which of your
  production responses get discarded and retried, which is invisible until your
  traffic hits it.

## 0.5.0

> **Upgrading from 0.4.x: this release narrows the `ai` peer range and is
> breaking for `ai@4` users.** The old range claimed `>=4`, which never worked —
> on `ai@4` the adapter read every response as the empty string, flagged it
> `EMPTY`, and threw on every healthy call under the default `onDegenerate`. The
> range is now `^5.0.0 || ^6.0.0 || ^7.0.0`, so installing on `ai@4` fails with
> `ERESOLVE` instead of silently rejecting your traffic.
>
> If you are pinned to `ai@4`: stay on `llm-output-guard@0.4.1`, or upgrade `ai`.
> Do not force the peer — the guard does not work on v4, and forcing it will look
> like a bug in this package.
>
> **This release also changes what gets flagged.** `TAIL_LOOP` now runs a
> character mode on Chinese, Japanese and Thai, so output those scripts that
> `0.4.x` passed may now be flagged. That is the point of the change — those
> loops were being missed — but it is a behaviour change, so roll out behind
> `onDegenerate: 'ignore'` and watch `onVerdict` before letting it fail requests.
>
> <sub>0.5.0 replaces 0.4.2, which carried this same work under a patch number
> and was withdrawn from npm within the unpublish window. See **Stability** in the
> README.</sub>

### Minor Changes

- 6c1a4db: Correct the `ai` peer range to the one that works: `^5.0.0 || ^6.0.0 || ^7.0.0`.

  The declared range was `>=4`, and `ai@4` never worked. Its middleware hands
  `wrapGenerate` a result carrying `text`, not the `content` array the adapter
  reads, and streams `{ type: 'text-delta', textDelta }` rather than `delta`. The
  adapter saw the empty string either way, so **every healthy response came back
  `EMPTY`** and, on the default `onDegenerate: 'throw'`, failed the call. A guard
  that fails everything is worse than no guard.

  Nothing caught this because the adapter is structurally typed — every field it
  reads is optional, so an `ai@4` result satisfies the types while meaning nothing.
  `ai@4` compiles against this package today. Types were never going to be the
  thing that noticed.

  The same audit found the range broken at the other end too: `ai@6` did not
  compile. Its `LanguageModelV3Middleware` requires a `specificationVersion` tag
  that v2 (`ai@5`) has no field for and v4 (`ai@7`) relaxed to any string. The
  middleware now carries `specificationVersion: 'v3'`, the one literal all three
  majors accept. `wrapLanguageModel` destructures the hooks and never reads it, in
  any version, so this is a type-level tag with no runtime effect.

  Adds `scripts/check-peers.mjs` and two CI jobs that run it. It installs the
  **packed tarball**, so the subpath resolves through the published `exports` map
  and emitted `.d.ts` exactly as a user gets it, then typechecks the documented
  usage _and_ drives the adapter with that major's real result and stream-part
  shapes — because typechecking alone is precisely what missed this.

  `peer-ranges` gates merges and pins every version, so it fails only when this
  repo changed. `peer-ranges-latest` floats to the newest release of each supported
  major for the early warning that upstream moved; it runs daily and cannot block
  a PR, because a check that reddens on someone else's release is a check people
  learn to ignore.

  `ai@4` users now get an `ERESOLVE` at install instead of a guard that rejects
  their traffic. Supporting v4 properly would mean a shim over two unrelated
  middleware shapes; it is not in this change.

- 6c1a4db: Detect loops in Chinese, Japanese and Thai, which the guard silently missed.

  `TAIL_LOOP` now measures characters instead of words when a span is written in a
  script that does not space its words, under its own threshold
  (`maxCharTailLoop`, default 0.7). `Verdict.modes` reports which tokenizer
  produced each score.

  **What was broken.** The tokenizer splits on runs of letters and digits, so a
  punctuation-delimited Chinese clause is one token and a loop with no punctuation
  is one token for the whole response. 640 characters of pure Chinese loop scored
  `REPETITION 0.000` and `TAIL_LOOP 0.000`. `LOW_ENTROPY` caught the long ones, so
  this looked survivable — but it is deferred mid-stream, which meant **streaming
  CJK had no detection at all** and a looping model ran to `max_tokens` on your
  budget. Shorter loops were missed outright: 128 characters of pure loop scored
  `LOW_ENTROPY 0.585` against a 0.75 threshold and passed every detector on a
  complete response.

  The dividing line is spacing, not script. Korean is non-Latin and was never
  affected. Thai _appeared_ to work because its vowel and tone marks are `\p{M}`
  and fragment the `\p{L}` runs — shredding, not tokenizing, and not something to
  rely on.

  **Dispatch is per detector span, not per response.** A reply that answers in
  English and then loops in Chinese measures 0.47 non-spaced overall and 1.00
  across its tail. Deciding once for the whole response puts the tail detector in
  word mode over text with no words in it and scores an obvious loop at 0.000;
  deciding from the tail scores it at ceiling. `LOW_ENTROPY` reads ~0 on that shape
  too — the healthy English dominates the sample — so nothing else covered it.

  **`REPETITION` gets no character mode, deliberately.** One was built and
  rejected, because it would add no coverage and cost a false-positive surface.
  `TAIL_LOOP`'s character mode already catches every degenerate non-Latin fixture
  in the corpus at a margin of 0.538, so there is nothing left for it to find.
  Meanwhile healthy _structured_ CJK output scores high under it: repeated key
  scaffolding around short CJK values is genuinely redundant character-by-character,
  and `json-zh-keys-valid` measures 0.543 over twenty distinct items, plateauing
  near 0.6. Against the weakest pure loop at 0.872 that is a margin of ~0.19 —
  under the 0.2 bar this package holds itself to, and rising with the number of
  keys a payload carries. `TAIL_LOOP` is immune because it needs _exact_
  periodicity, which scaffolding never produces. The README states this gap plainly
  rather than implying coverage that does not exist.

  Also in this change:

  - All four presets set `maxCharTailLoop`, `strictJson` included. It nulls
    `maxCompressibility` because JSON is legitimately compressible; nulling the
    char threshold too would have rebuilt the same blind spot on the preset most
    likely to be pointed at non-English payloads.
  - `calibrate` segments by **detector-mode pair** and suggests the matching option,
    so `TAIL_LOOP [word]` and `TAIL_LOOP [char]` get separate thresholds. Pooled,
    one number fits neither. Logs without `modes` still calibrate unsegmented.
  - `npm run calibrate` reports per mode, and scores each detector only against
    fixtures labelled for it — previously any above-noise degenerate fixture
    counted toward every detector's margin.
  - 14 labelled fixtures: six degenerate, eight healthy traps (CJK numbered lists,
    identical trailing clauses, markdown tables, a Chinese JSON array, a legitimate
    refrain, a Thai prefix list, Korean prose).
  - The mid-stream `LOW_ENTROPY` deferral is unchanged but its comment now records
    the condition it depends on and what would invalidate it. Character-mode
    `TAIL_LOOP` scores 0.854-1.000 on every degenerate CJK fixture at the
    240-character warmup, where `LOW_ENTROPY` reads 0.453-0.805 — below its own
    threshold on most. Deferring is still correct, and now for a stated reason.
  - Fixed the dispatch ratio for scripts with combining marks. `\p{Script=Thai}`
    matches marks that `\p{L}` does not, so the numerator and denominator counted
    different sets and Thai returned 1.28.

  Mid-stream detection on non-Latin degeneration lands at **0-85%** of each
  fixture's characters, against the 48-92% measured on Latin, and the README now
  states both. Both are in-process measurements over fixture strings — detection
  latency, with no provider or connection involved — and the README now says that
  rather than calling them savings. A response that loops from the start is caught
  as early as a Latin one; one that answers properly and then loops is caught late,
  because there is nothing to detect until the loop starts. That still stops a
  broken response being cached or served, but it is not a token saving.

- 6c1a4db: Add `llm-output-guard/openai`: `withOutputGuard()`, a guard for the OpenAI SDK.

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
  generated over a mock transport**, with the unguarded baseline asserted at the
  full 135 so the comparison means something.

  That 88% is chunks a mock server was never asked to produce after the connection
  closed — **not a billing figure**. A real provider adds buffering, its own
  chunking, and server-side generation that may already have run ahead of what it
  has sent. The number is evidence that cancellation reaches the transport
  promptly; it is not a number to put in a budget without measuring your own
  provider.

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

## 0.4.1

### Patch Changes

- Fix `npx llm-output-guard` printing nothing.

  The 0.4.0 binary did nothing at all and exited 0. The entry point decided
  whether it was being run or imported by matching `process.argv[1]` against
  `dist/cli` or a `.js` suffix — and npm invokes a bin through a symlink at
  `node_modules/.bin/llm-output-guard`, which has neither. The check concluded it
  had been imported, `main` never ran, and there was no error to notice.

  `node dist/cli.js` worked, which is how it passed every check before release.
  The executable is now `dist/bin.js`, a file whose only content is a call to
  `main` — a module that is only ever an entry point does not need to ask whether
  it is one, so there is no condition left to get wrong.

  Adds subprocess tests that spawn the CLI the way a user runs it, including
  through stdin. In-process tests of `main` cannot catch this class of bug, and
  did not.

  Also brings `*.config.ts` into `tsconfig.json`'s `include`. The build config
  sat outside it, so `tsc --noEmit` never read the file that decides what gets
  built — a `format` typing error in `tsup.config.ts` was visible in an editor
  and invisible to CI.

## 0.4.0

### Minor Changes

- Add `npx llm-output-guard calibrate` — thresholds derived from your own logs.

  The README has always said to log your scores for a week and then set your own
  thresholds, without shipping anything that does the second half. This closes
  that: point it at JSONL of logged verdicts and it reports each detector's
  distribution and a suggested threshold. Parsing is deliberately forgiving —
  a bare scores object, a whole `Verdict`, or either buried in a wider log
  record — because a calibration step you must reshape your logs for is one
  nobody runs. `--json` emits the analysis as data, and the same functions are
  exported (`calibrate`, `summarise`, `percentile`, `findGap`) for building your
  own reporting on top.

  Most of the design is about not overstating what unlabelled logs can support:

  - Suggestions bound **false positives**, not misses, and the report says so.
    A detector that never fires has a perfect false-positive rate.
  - When the tail is genuinely bimodal, the gap between the healthy bulk and the
    outlier cluster is preferred over a percentile, because it is separation
    observed in your data rather than an assumption about rarity — and if that
    gap rests on fewer than five samples, it is labelled a lead to confirm.
  - Asking for a rate the sample cannot support is reported rather than answered:
    a 0.1% threshold needs ~10,000 verdicts before its tail means anything.
  - `EMPTY` and `TOO_SHORT` are reported as incidence rates instead of
    thresholds, since one is not configurable and the other is set in characters
    — a 0..1 suggestion there would be a confidently wrong number in the
    right-looking place.

  `Distribution` gains a `nonZero` count. Still zero runtime dependencies.

## 0.3.0

### Minor Changes

- Add `llm-output-guard/ai-sdk`: `outputGuard()`, middleware for the Vercel AI SDK.

  One `wrapLanguageModel` call guards both `generateText` and `streamText`. On a
  stream it cancels the provider mid-generation — driven through the real SDK
  against a looping model, the provider was asked for 17 of 137 parts before the
  guard cut it off, and the rest was never generated or billed. On `generateText`
  the tokens are already spent, so it throws `DegenerateOutputError` instead.

  `onDegenerate` takes `'throw'` (default; also cancels the stream), `'abort'`
  (stop cleanly, keep what arrived) or `'ignore'`, and `onVerdict` reports every
  verdict either way, so a logging-only rollout is the default posture rather than
  an afterthought.

  `ai` is an optional peer dependency and the adapter is structurally typed rather
  than importing from it, so the package still has zero runtime dependencies and
  the main entry point still has no peers. `finishReason` is accepted as both the
  v2 string and the v4 `{ unified, raw }` object, so one adapter covers both specs.

  Also adds the `./package.json` export, which some tooling reads.

## 0.2.0

### Minor Changes

- Add streaming detection: `guardStream` and `createStreamGuard`.

  Checking a finished response only tells you that you already paid for it. A
  model that starts looping keeps going until `max_tokens`, billing you for every
  token and making you wait. These watch the response as it arrives and report
  degeneration early enough to abort the generation — 48-92% of the tokens on the
  degenerate fixtures, with none of the healthy ones tripping.

  Two things make it safe to leave on:

  - **Only the redundancy detectors run mid-stream.** Partial output really is
    short, really is cut off, and really is invalid JSON, so `TOO_SHORT`,
    `TRUNCATED`, `INVALID_JSON` and `LANG_MISMATCH` would fire on every healthy
    generation. They are deferred to `end()`, which runs the full check.
  - **Each check reads a trailing window, not the whole buffer**, so cost is
    ~0.05ms per check and flat as the stream grows rather than quadratic in its
    length. `LOW_ENTROPY` is deferred as well — at ~100x the cost of the other
    detectors it is affordable once per response and ruinous per check, and
    everything it catches early is caught by `REPETITION` regardless.

  The guard never aborts anything itself: it holds no `AbortController` and knows
  nothing about your transport. It tells you, and you decide.

## 0.1.1

### Patch Changes

- Stop `calibrate` from suggesting a threshold it cannot support, and correct the
  compressibility docs.

  Where every healthy fixture is pinned to the same floored score — `TAIL_LOOP`
  and `LOW_ENTROPY` both are — the healthy distribution carries no information
  about how close healthy output actually came, so half the margin was a number
  with nothing behind it. Those detectors now print `n/a` with the reason, and
  `LOW_ENTROPY` additionally reports the pre-clamp compression ratio spread,
  where the real separation is visible: healthy 0.670+, degenerate 0.203 and
  below, a true gap of 0.468.

  The `compressionRatio` doc claimed healthy prose lands at 0.30-0.55. Measured
  against the corpus it lands at 0.67-0.97, which would have misled anyone tuning
  `pivot`. No thresholds or scores changed.

- Treat a non-string response as an `EMPTY` verdict instead of throwing.

  `checkOutput(undefined)` previously threw a raw `TypeError` from the first
  detector. That broke the package's own documented use: a retry policy keyed on
  `err instanceof DegenerateOutputError` does not catch a `TypeError`, so a
  provider that "succeeded" while returning no text slipped through the guard
  entirely — the exact failure this package exists to catch.

  `checkOutput` and `assertOutput` now accept `string | null | undefined` and
  report the offending type in the reason message.

## 0.1.0

Initial release. Deterministic detection of degenerate LLM output that arrives
with a successful HTTP status.

Detectors for emptiness, shortness, n-gram repetition, tail loops, character-level
entropy collapse, truncation, JSON validity, and language mismatch. Ships
`checkOutput` (verdict) and `assertOutput` (throwing, for existing retry layers),
four calibrated presets, and a fixture corpus with deliberate false-positive traps.
