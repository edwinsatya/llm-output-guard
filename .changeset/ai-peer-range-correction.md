---
'llm-output-guard': minor
---

Correct the `ai` peer range to the one that works: `^5.0.0 || ^6.0.0 || ^7.0.0`.

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
usage *and* drives the adapter with that major's real result and stream-part
shapes — because typechecking alone is precisely what missed this.

`peer-ranges` gates merges and pins every version, so it fails only when this
repo changed. `peer-ranges-latest` floats to the newest release of each supported
major for the early warning that upstream moved; it runs daily and cannot block
a PR, because a check that reddens on someone else's release is a check people
learn to ignore.

`ai@4` users now get an `ERESOLVE` at install instead of a guard that rejects
their traffic. Supporting v4 properly would mean a shim over two unrelated
middleware shapes; it is not in this change.
