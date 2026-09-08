import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { builtinModules } from 'node:module';

/**
 * Every package a build script imports must be declared.
 *
 * `esbuild` was not. Two scripts imported it directly -- `build-playground.mjs`
 * and `size.mjs` -- and it resolved only because `tsup` happens to depend on it
 * and npm happens to hoist it to the top level. It worked, and it worked by
 * accident:
 *
 * - a tsup release that moves its esbuild range moves ours silently;
 * - pnpm and Yarn PnP do not hoist, so a clone with either fails outright;
 * - both scripts sit on the release path -- `playground` runs inside
 *   `prepublishOnly`, and `size` is a CI job that gates a merge.
 *
 * This is the same shape as the `no-runtime-deps` job one level down: a
 * dependency you did not declare is a dependency you did not choose, and the
 * cheapest moment to notice is now rather than the first time someone installs
 * with a different package manager.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

const builtins = new Set(builtinModules);

/** The package a specifier names, or null when it is relative or a builtin. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return builtins.has(name) ? null : name;
}

const scripts = readdirSync(join(root, 'scripts')).filter(
  (f) => f.endsWith('.mjs') || f.endsWith('.ts'),
);

describe('build scripts declare what they import', () => {
  it('has scripts to check', () => {
    expect(scripts.length).toBeGreaterThan(4);
  });

  for (const file of scripts) {
    it(`${file} imports nothing undeclared`, () => {
      const raw = readFileSync(join(root, 'scripts', file), 'utf8');

      /*
       * Comments first, then template literals -- and both are load-bearing
       * rather than tidy.
       *
       * `check-peers.mjs` holds whole probe files as backtick strings: source
       * it *writes into* a temp consumer package, containing
       * `import ... from 'llm-output-guard'`. Reading those reports the package
       * as an undeclared dependency of its own build script.
       *
       * Comments matter for a subtler reason, found the same way. A JSDoc block
       * in that file contains an **escaped** backtick, which mis-pairs the
       * template stripping and leaves a later block exposed -- so a fenced
       * example inside a comment surfaced as an import. Stripping comments
       * first removes both the examples and the stray delimiter.
       *
       * This is regex, not a parser. It is naive on backticks nested inside
       * `${...}`, which none of these scripts use; if that changes it
       * over-strips, and the failure is a missing import rather than a phantom
       * one -- the safe direction for a check like this.
       */
      const source = raw
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ')
        .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``');

      /*
       * Static `import ... from '...'` and bare `import '...'`. Dynamic
       * `import()` and `require()` are not matched: none of these scripts use
       * them.
       */
      const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)]
        .map((m) => m[1]!)
        .map(packageOf)
        .filter((name): name is string => name !== null);

      const undeclared = [...new Set(specifiers)].filter((name) => !declared.has(name));

      expect(
        undeclared,
        `${file} imports ${undeclared.join(', ')} without declaring it — it may ` +
          'resolve today by hoisting and fail under pnpm, Yarn PnP, or a ' +
          'dependency bump',
      ).toEqual([]);
    });
  }
});
