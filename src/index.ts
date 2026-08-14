export { checkOutput, assertOutput, DegenerateOutputError } from './check.js';
export { createStreamGuard, guardStream } from './stream.js';
/*
 * `percentile` and `findGap` were exported here in 0.4.x and 0.5.0, and are
 * removed as of 1.0.0. Both take a pre-sorted ascending array and return
 * confidently wrong numbers otherwise -- fine for the internal callers they
 * were written for, and a poor thing to promise under a freeze. They stay
 * exported from `./calibrate.js` for `summarise` and the tests, which is not a
 * path any consumer can import: the package `exports` map admits the three
 * entry points and `package.json`, and nothing else.
 */
export { calibrate, summarise } from './calibrate.js';
export { presets } from './presets.js';
export type { StandardSchemaV1 } from './standard-schema.js';
export type { CheckOptions, Verdict, Reason, ReasonCode, TokenMode } from './types.js';
export type { StreamGuard, StreamGuardOptions, GuardStreamOptions } from './stream.js';
export type {
  Calibration,
  CalibrationOptions,
  Distribution,
  Gap,
  ScoreSample,
  Summary,
} from './calibrate.js';
export * from './detectors/index.js';
