export { checkOutput, assertOutput, DegenerateOutputError } from './check.js';
export { createStreamGuard, guardStream } from './stream.js';
export { calibrate, summarise, percentile, findGap } from './calibrate.js';
export { presets } from './presets.js';
export type { CheckOptions, Verdict, Reason, ReasonCode } from './types.js';
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
