---
'llm-output-guard': patch
---

Subpath types resolve under classic `moduleResolution: "node"`.

`node` resolution ignores the `exports` map entirely. It finds the root through
the top-level `types` field and finds **nothing** for a subpath, so every
adapter failed to typecheck:

```ts
import { withOutputGuard } from 'llm-output-guard/openai';
// TS2307: Cannot find module 'llm-output-guard/openai' or its
// corresponding type declarations.
```

Measured on the packed tarball: `./openai` and `./agent` both failed under
`node`, while `node16`, `nodenext` and `bundler` were all fine. `node` is still
the default whenever `module` is `commonjs`, so a consumer on an older tsconfig
could import the root and not one adapter — and the runtime was never affected,
which is what made it quiet: `require('llm-output-guard/openai')` worked, and
only the build complained.

Nothing here would have caught it. This repo typechecks under `bundler`, and so
does `check:peers`, so both halves of the existing type coverage sat on the side
of the fence where it works.

Fixed with `typesVersions`, which is a second list of the same subpaths and
therefore exactly the kind of list that drifts — so `test/surface.test.ts`
derives it from `exports` rather than trusting it, and a subpath added without
a mapping now fails there. All four resolutions verified against the packed
tarball, with the CJS `require` path re-checked alongside.
