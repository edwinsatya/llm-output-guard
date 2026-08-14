---
'llm-output-guard': minor
---

Add a `schema` option, accepting any Standard Schema validator.

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

On success `Verdict.json` is the schema's *output* rather than the raw parse, so
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
*response*.

Tested against all three libraries rather than one, because the spec is types-only
and they disagree at runtime about issue paths — Valibot and ArkType return
segment objects where Zod returns bare keys.
