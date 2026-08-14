# llm-output-guard

## Unreleased

### Minor Changes

- Add `redundancyScope`, which stops a JSON array of repeated records being read
  as a loop.

  A model asked for the status of twenty services and returning twenty identical
  rows has done exactly what it was told. Measured across the document that is a
  perfect loop, and 1.2.1 scores it `TAIL_LOOP: 1.000` and fails it under **every
  preset — `lenient` and `strictJson` included**. Three identical records is
  enough to trip it, and an array that is only 75% repetitive fails on
  `REPETITION`. `strictJson` is the preset most likely to be pointed at exactly
  that payload.

  The scores were never wrong: twenty identical records *are* exactly periodic.
  The detectors were being asked about the wrong span.

  ```ts
  checkOutput(raw, { ...presets.strictJson, redundancyScope: 'jsonValues' });
  ```

  Under `'jsonValues'`, `REPETITION` and `TAIL_LOOP` read each string value of a
  parsed payload on its own, on the rule that repetition **across records** is the
  shape that was requested and repetition **inside a value** is the signal.

  **It is more sensitive, not less.** A loop confined to one element of an array
  is averaged away across a document — 1.2.1 misses
  `[{"q":"<30× repeated Chinese clause>"}, …four healthy items]` entirely — and
  reads 1.000 when that element is measured alone. So this removes a false
  positive and closes a false negative in the same change.

  Text that does not parse is measured as a document regardless, so prose, a
  truncated payload and every mid-stream check behave exactly as before. Only the
  two redundancy detectors are scoped; `LOW_ENTROPY`, `TRUNCATED`, `INVALID_JSON`,
  `EMPTY`, `TOO_SHORT` and `LANG_MISMATCH` read the whole response as they always
  have.

  Default is `'document'`, and that default is asserted byte-identical to 1.2.1
  across all 228 fixture × preset combinations in the corpus — compared against
  the published tarball, not against itself. No preset or threshold changed.

  Left opt-in rather than made the default deliberately. Switching it on by
  default would change which production responses get discarded, which this
  package's stability table calls a major, and 1.0.0 shipped four days ago.

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
