/**
 * Threshold calibration from your own logged scores.
 *
 * The fixture corpus can compute a real margin because every sample is
 * labelled. Production logs are not labelled, and no amount of arithmetic
 * recovers a label that was never recorded -- so this deliberately answers a
 * smaller question than `scripts/calibrate.ts` does.
 *
 * What it can answer: *how much of your own traffic would a given threshold
 * flag?* That works because degeneration is rare, which puts healthy output in
 * the bulk of the distribution and makes a high percentile a decent stand-in
 * for "the most extreme thing my healthy traffic does". Set a threshold above
 * it and you know your false-positive cost.
 *
 * What it cannot answer: whether that threshold catches anything. A detector
 * that never fires has a perfect false-positive rate. Every number here bounds
 * false positives only, and `Summary.caveats` says so wherever it matters.
 */
import type { ReasonCode } from './types.js';

export interface CalibrationOptions {
  /**
   * Share of your traffic you are willing to have flagged. Default 0.001.
   *
   * This is the real knob: a threshold is only ever a trade between the
   * responses you discard wrongly and the ones you let through.
   */
  falsePositiveRate?: number;
}

export interface Distribution {
  n: number;
  /**
   * How many scores were above zero.
   *
   * For the detectors whose threshold is not a 0..1 score -- `EMPTY`, which is
   * not configurable, and `TOO_SHORT`, which is set in characters -- this is
   * the whole useful answer: how often the thing happened at all.
   */
  nonZero: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p99: number;
  p999: number;
}

export interface Gap {
  /** Highest score below the gap -- the top of the bulk. */
  below: number;
  /** Lowest score above it -- the bottom of the outlier cluster. */
  above: number;
  /** How many samples sit above the gap. */
  count: number;
  /** Their share of the sample. */
  share: number;
}

export interface Summary {
  code: ReasonCode;
  distribution: Distribution;
  /** Threshold that would flag `falsePositiveRate` of this sample. */
  suggested: number;
  /** A clean separation in the upper tail, when one exists. Stronger evidence. */
  gap: Gap | null;
  /** Everything that would make the number above untrustworthy. */
  caveats: string[];
}

/** Linear-interpolated percentile. `sorted` must be ascending. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/**
 * The widest empty stretch in the upper tail, if there is one.
 *
 * A genuinely bimodal detector -- healthy output clustered near zero, a
 * handful of failures far above it -- leaves a visible hole between the two.
 * That hole is worth far more than a percentile, because it is evidence about
 * *this* detector on *your* traffic rather than an assumption about rarity.
 * Searching only above the median keeps the ordinary spread of healthy scores
 * from being mistaken for a separation.
 */
export function findGap(sorted: number[], minWidth = 0.15): Gap | null {
  if (sorted.length < 20) return null;

  const start = Math.floor(sorted.length * 0.5);
  let best: Gap | null = null;

  for (let i = start; i < sorted.length - 1; i += 1) {
    const width = sorted[i + 1] - sorted[i];
    if (width < minWidth || (best && width <= best.above - best.below)) continue;
    const count = sorted.length - (i + 1);
    best = {
      below: sorted[i],
      above: sorted[i + 1],
      count,
      share: count / sorted.length,
    };
  }

  return best;
}

/**
 * Summarise one detector's scores.
 *
 * The suggestion prefers a gap when one exists and falls back to the
 * percentile otherwise, because the two are not equally good evidence and
 * pretending they are is how a calibrated-looking number gets trusted.
 */
export function summarise(
  code: ReasonCode,
  scores: number[],
  options: CalibrationOptions = {},
): Summary {
  const { falsePositiveRate = 0.001 } = options;
  const sorted = [...scores].sort((a, b) => a - b);
  const n = sorted.length;

  const distribution: Distribution = {
    n,
    nonZero: sorted.filter((s) => s > 0).length,
    min: sorted[0] ?? NaN,
    max: sorted[n - 1] ?? NaN,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    p999: percentile(sorted, 0.999),
  };

  const caveats: string[] = [];
  const gap = findGap(sorted);

  /*
   * A percentile cannot be estimated from samples that are not there. At a
   * false-positive rate of 0.1% the estimate rests on the top 0.1% of the
   * sample, so ten of them is the bare minimum before the number means
   * anything -- below that it is one unusual response wearing a decimal point.
   */
  const tailSamples = n * falsePositiveRate;
  if (tailSamples < 10) {
    /*
     * Phrased without this detector's own `n` so that the identical sentence
     * comes back for every detector sharing the shortfall, and the reporter
     * can hoist it to a single line. The sample size is already on the header.
     */
    caveats.push(
      `sample is too small for a ${(falsePositiveRate * 100).toFixed(2)}% rate: ` +
        `it rests on the top ~${tailSamples.toFixed(0)} scores, and ` +
        `~${Math.ceil(10 / falsePositiveRate).toLocaleString()} verdicts are needed before that tail means anything`,
    );
  }

  if (distribution.max === 0) {
    caveats.push('every score is 0 -- this detector never moved on your traffic, so there is nothing to calibrate');
  } else if (distribution.p50 === distribution.max) {
    caveats.push('the distribution is a single value; a threshold from it describes nothing');
  }

  let suggested: number;
  if (gap) {
    // Midpoint of the hole: as far from the healthy bulk as from the outliers.
    suggested = (gap.below + gap.above) / 2;

    /*
     * A hole with one or two things past it is an outlier, not a cluster, and
     * "clean separation" is too strong a word for it. The suggestion is still
     * the best available -- one real failure is exactly the signal you are
     * looking for when the failure is rare -- but it rests on that one sample,
     * and a reader deciding whether to trust it should be told so.
     */
    if (gap.count < 5) {
      caveats.push(
        `the separation rests on ${gap.count} sample${gap.count === 1 ? '' : 's'}; ` +
          'treat it as a lead to confirm, not a calibrated threshold',
      );
    }
  } else {
    suggested = percentile(sorted, 1 - falsePositiveRate);
    caveats.push(
      'no clean separation in the tail, so this is a false-positive budget rather than a detection threshold',
    );
  }

  return { code, distribution, suggested: Number(suggested.toFixed(3)), gap, caveats };
}

/** One logged verdict's worth of scores. */
export type ScoreSample = Partial<Record<ReasonCode, number>>;

export interface Calibration {
  /** How many samples were read. */
  n: number;
  summaries: Summary[];
}

/**
 * Summarise every detector present in the samples.
 *
 * Detectors are summarised independently and only over the samples that
 * actually carry them, because a disabled detector logs nothing and counting
 * that as a zero would drag every percentile down and quietly recommend a
 * threshold far tighter than the traffic supports.
 */
export function calibrate(samples: ScoreSample[], options: CalibrationOptions = {}): Calibration {
  const byCode = new Map<ReasonCode, number[]>();

  for (const sample of samples) {
    for (const [code, score] of Object.entries(sample) as [ReasonCode, unknown][]) {
      if (typeof score !== 'number' || !Number.isFinite(score)) continue;
      const list = byCode.get(code);
      if (list) list.push(score);
      else byCode.set(code, [score]);
    }
  }

  const summaries = [...byCode.entries()]
    .map(([code, scores]) => summarise(code, scores, options))
    .sort((a, b) => b.distribution.n - a.distribution.n);

  return { n: samples.length, summaries };
}
