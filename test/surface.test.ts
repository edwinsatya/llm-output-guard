import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as root from '../src/index.js';
import * as aiSdk from '../src/ai-sdk.js';
import * as openai from '../src/openai.js';

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
  'repetitionScore',
  'shortnessScore',
  'stripFence',
  'supportedLanguages',
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

  it('exports one function from each adapter subpath', () => {
    expect(names(aiSdk)).toEqual(['outputGuard']);
    expect(names(openai)).toEqual(['withOutputGuard']);
  });

  /**
   * What makes `AdapterGuardOptions` internal is not a missing export -- it is
   * that `src/internal/*` has no import path once the package is installed.
   * Each adapter's `OutputGuardOptions` is its own contract; they extend a
   * shared base today and are free to diverge without widening or splitting a
   * frozen type.
   */
  it('admits four entry points and no deep imports', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './ai-sdk', './openai', './package.json']);
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
} from '../src/index.js';

export type {
  OutputGuardOptions as AiSdkOutputGuardOptions,
  DegenerateAction as AiSdkDegenerateAction,
} from '../src/ai-sdk.js';

export type {
  OutputGuardOptions as OpenAIOutputGuardOptions,
  DegenerateAction as OpenAIDegenerateAction,
} from '../src/openai.js';
