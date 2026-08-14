---
'llm-output-guard': patch
---

Fix type resolution for CommonJS TypeScript consumers.

The `exports` map declared `types` once per subpath, pointing at the ESM `.d.ts`.
From a CommonJS project using `moduleResolution: node16`, TypeScript resolved
that ES-module declaration and then refused it — `TS1479: the referenced file is
an ECMAScript module and cannot be imported with 'require'` — on every entry
point, including the root.

Nothing was wrong at runtime: `require('llm-output-guard')` always returned the
real `.cjs`. It broke the *build* of any CJS TypeScript consumer, which is a
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
