import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as root from '../src/index.js';
import * as aiSdk from '../src/ai-sdk.js';
import * as openai from '../src/openai.js';
import * as anthropic from '../src/anthropic.js';
import * as google from '../src/google.js';
import * as agent from '../src/agent.js';

/**
 * The public surface, frozen at 1.0.0.
 *
 * `src/index.ts` ends in `export * from './detectors/index.js'`, so a new
 * detector joins the public API by being written, with nothing at the entry
 * point to notice. Under a freeze that is the expensive direction of accident:
 * an export is a promise for the rest of the major, and this file is where
 * adding one becomes a deliberate act.
 *
 * See README **Stability** for what semver covers here, and note the rule that
 * makes this list narrower than it looks: threshold and preset values are
 * behaviour, so they are covered too even though no name changes.
 */
const ROOT = [
  // Core
  'assertOutput',
  'checkOutput',
  'DegenerateOutputError',
  'presets',
  // Streaming
  'createStreamGuard',
  'guardStream',
  // Detectors
  'compressibilityScore',
  'compressionRatio',
  'emptinessScore',
  'jsonScore',
  'languageMismatchScore',
  'languageProfile',
  'promptEchoDetail',
  'promptEchoScore',
  'repetitionScore',
  'scriptMismatchScore',
  'scriptProfile',
  'shortnessScore',
  'stripFence',
  'supportedLanguages',
  'supportedScripts',
  'tailLoopDetail',
  'tailLoopScore',
  'truncationScore',
  // Calibration
  'calibrate',
  'summarise',
].sort();

const names = (ns: object) => Object.keys(ns).sort();

describe('public surface', () => {
  it('exports exactly the frozen list from the root', () => {
    expect(names(root)).toEqual(ROOT);
  });

  /**
   * Both shipped in 0.4.0, were documented nowhere a user would look, and take
   * a **pre-sorted ascending** array -- returning confidently wrong numbers
   * when given anything else. They stay importable from `src/calibrate.js`,
   * which the `exports` map below puts out of a consumer's reach.
   */
  it('does not re-export the sorted-input statistics helpers', () => {
    expect(names(root)).not.toContain('percentile');
    expect(names(root)).not.toContain('findGap');
  });

  /**
   * Two each: the guard, and the turn mapper `./agent` needs.
   *
   * `toTurn` lives beside the surface it mirrors rather than in `./agent`,
   * because it is provider knowledge and `./agent` is deliberately provider
   * neutral. Same name from every subpath, exactly as `withOutputGuard` is.
   */
  it('exports the guard and the turn mapper from each adapter subpath', () => {
    expect(names(aiSdk)).toEqual(['outputGuard', 'toTurn']);
    expect(names(openai)).toEqual(['toTurn', 'withOutputGuard']);
    expect(names(anthropic)).toEqual(['toTurn', 'withOutputGuard']);
    expect(names(google)).toEqual(['toTurn', 'withOutputGuard']);
  });

  /**
   * `./agent` is the one subpath that is not an adapter, so it is the one with
   * a surface of its own to freeze. It deliberately re-exports
   * `DegenerateOutputError` rather than declaring a second error type: a
   * degenerate response and a degenerate run want the same `catch`.
   *
   * The detector is reachable here and **not** from the root, so the frozen
   * root list above stays exactly as it was.
   */
  it('exports exactly the frozen list from ./agent', () => {
    expect(names(agent)).toEqual([
      'DegenerateOutputError',
      'agentLoopDetail',
      'agentLoopScore',
      'assertTrace',
      'checkTrace',
      'createAgentGuard',
    ].sort());
  });

  it('keeps the cross-turn detector out of the root surface', () => {
    expect(names(root)).not.toContain('agentLoopScore');
    expect(names(root)).not.toContain('agentLoopDetail');
    expect(names(root)).not.toContain('checkTrace');
  });

  /**
   * What makes `AdapterGuardOptions` internal is not a missing export -- it is
   * that `src/internal/*` has no import path once the package is installed.
   * Each adapter's `OutputGuardOptions` is its own contract; they extend a
   * shared base today and are free to diverge without widening or splitting a
   * frozen type.
   */
  it('admits seven entry points and no deep imports', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(pkg.exports).sort()).toEqual([
      '.',
      './agent',
      './ai-sdk',
      './anthropic',
      './google',
      './openai',
      './package.json',
    ]);
  });

  /**
   * Every adapter subpath is an optional peer, and the main entry point has
   * none. This is the zero-dependency claim in assertable form: `dependencies`
   * must stay empty no matter how many providers get adapters, and a peer that
   * was not marked optional would make `npm i llm-output-guard` start pulling
   * an SDK nobody asked for.
   */
  it('has no runtime dependencies and only optional peers', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
    for (const name of Object.keys(pkg.peerDependencies)) {
      expect(pkg.peerDependenciesMeta?.[name]?.optional, `${name} is not optional`).toBe(true);
    }
  });

  /**
   * Types must be declared *per condition*, not once for both.
   *
   * A single top-level `types` pointing at the ESM `.d.ts` type-checks fine
   * from an ESM consumer and fails from a CommonJS one under
   * `moduleResolution: node16`, with TS1479: it resolves the ES-module
   * declaration and then objects that a `require` cannot load it. The runtime
   * was always correct -- `require` returned the real `.cjs` -- so this broke
   * nothing at execution time and broke the build of every CJS TypeScript
   * consumer, which is a worse place to find out.
   *
   * Asserted rather than remembered because the shape is easy to "tidy" back:
   * the short form looks equivalent and is not.
   */
  it('declares types per condition, so CJS consumers resolve .d.cts', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

    for (const [subpath, entry] of Object.entries<Record<string, Record<string, string>>>(
      pkg.exports,
    )) {
      if (subpath === './package.json') continue;

      expect(Object.keys(entry).sort(), `${subpath} conditions`).toEqual(['import', 'require']);
      expect(entry.import.types, `${subpath} import types`).toMatch(/\.d\.ts$/);
      expect(entry.require.types, `${subpath} require types`).toMatch(/\.d\.cts$/);
      expect(entry.import.default, `${subpath} import default`).toMatch(/\.js$/);
      expect(entry.require.default, `${subpath} require default`).toMatch(/\.cjs$/);
    }
  });
});

/**
 * The type half of the freeze. Types have no runtime presence to assert on, so
 * re-exporting each one is what makes `npm run typecheck` fail when it goes
 * missing. This catches removal but not addition -- removal is the direction
 * that breaks a consumer's build, and the runtime lists above cover the rest.
 */
export type {
  CheckOptions,
  StandardSchemaV1,
  Verdict,
  Reason,
  ReasonCode,
  TokenMode,
  StreamGuard,
  StreamGuardOptions,
  GuardStreamOptions,
  Calibration,
  CalibrationOptions,
  Distribution,
  Gap,
  ScoreSample,
  Summary,
  RepetitionOptions,
  TailLoopOptions,
  TailLoopResult,
  CompressibilityOptions,
  TruncationOptions,
  JsonOptions,
  JsonResult,
  LanguageOptions,
  ScriptName,
  ScriptOptions,
  PromptEchoOptions,
  PromptEchoResult,
} from '../src/index.js';

export type {
  OutputGuardOptions as AiSdkOutputGuardOptions,
  DegenerateAction as AiSdkDegenerateAction,
} from '../src/ai-sdk.js';

export type {
  OutputGuardOptions as OpenAIOutputGuardOptions,
  DegenerateAction as OpenAIDegenerateAction,
} from '../src/openai.js';

export type {
  OutputGuardOptions as AnthropicOutputGuardOptions,
  DegenerateAction as AnthropicDegenerateAction,
} from '../src/anthropic.js';

export type {
  OutputGuardOptions as GoogleOutputGuardOptions,
  DegenerateAction as GoogleDegenerateAction,
} from '../src/google.js';
