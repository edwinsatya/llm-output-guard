---
'llm-output-guard': patch
---

`esbuild` is a declared devDependency, and undeclared imports now fail a test.

Two build scripts imported it directly — `build-playground.mjs` and the
`size.mjs` added last release — and it was declared nowhere. It resolved only
because `tsup` depends on it and npm hoists it to the top level:

```
devDependencies.esbuild → null
resolves via: tsup@8.5.1 → esbuild@0.27.7
```

It worked, and it worked by accident. A tsup release that moves its esbuild
range moves ours silently; pnpm and Yarn PnP do not hoist, so a clone with
either fails outright. Both scripts sit on the release path — `playground` runs
inside `prepublishOnly`, and `size` is a CI job that gates a merge.

Same shape as the `no-runtime-deps` job one level down: **a dependency you did
not declare is a dependency you did not choose.** So it is asserted rather than
noticed — `test/scripts-deps.test.ts` reads every import in `scripts/` and fails
on any package missing from `package.json`. Verified by removing the
declaration: both scripts fail, by name.

Writing that check found the second thing worth recording. It scans with a
regex, so it strips comments and template literals first, and both were
load-bearing. `check-peers.mjs` holds whole probe files as backtick strings —
source it *writes into* a temp consumer — which contain
`import ... from 'llm-output-guard'`, reported as the package depending on
itself. And a JSDoc block in that same file carries an **escaped** backtick,
which mis-pairs the template stripping and left a fenced example inside a
comment reading as an import. Both are in the test's own comments, because the
next person to touch that regex needs them.
