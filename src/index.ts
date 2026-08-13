export { checkOutput, assertOutput, DegenerateOutputError } from './check.js';
export { createStreamGuard, guardStream } from './stream.js';
/*
 * `percentile` and `findGap` are still exported here, and are removed in 1.0.0
 * -- see .changeset/one-point-oh-surface.md. They stay for now so that 0.5.0 is
 * a pure renumbering of the withdrawn 0.4.2 and nothing else: a corrective
 * re-release that also carries a quiet breaking change is the mistake it exists
 * to correct.
 */
export { calibrate, summarise, percentile, findGap } from './calibrate.js';
export { presets } from './presets.js';
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
