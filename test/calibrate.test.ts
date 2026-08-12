import { describe, it, expect } from 'vitest';
import { calibrate, summarise, percentile, findGap } from '../src/calibrate.js';
import { extractScores, main } from '../src/cli.js';

/** Healthy-looking traffic: a tight cluster near zero. */
const healthy = (n: number, spread = 0.08) =>
  Array.from({ length: n }, (_, i) => Number(((i % 100) / 100) * spread));

describe('percentile', () => {
  it('interpolates between ranks', () => {
    expect(percentile([0, 1], 0.5)).toBe(0.5);
    expect(percentile([0, 10, 20], 0.5)).toBe(10);
  });

  it('handles degenerate inputs without throwing', () => {
    expect(percentile([], 0.5)).toBeNaN();
    expect(percentile([7], 0.99)).toBe(7);
  });
});

describe('findGap', () => {
  it('finds a clean separation between bulk and outliers', () => {
    const sorted = [...healthy(200), ...Array(8).fill(0.85)].sort((a, b) => a - b);
    const gap = findGap(sorted);
    expect(gap).not.toBeNull();
    expect(gap!.above).toBeCloseTo(0.85, 2);
    expect(gap!.count).toBe(8);
  });

  it('reports nothing when the distribution is one smooth cluster', () => {
    expect(findGap(healthy(200).sort((a, b) => a - b))).toBeNull();
  });

  it('abstains on samples too small to show a shape', () => {
    expect(findGap([0, 0.01, 0.9])).toBeNull();
  });
});

describe('summarise', () => {
  /*
   * The failure this whole module is built to avoid: a confident-looking
   * threshold derived from a tail that has almost no samples in it.
   */
  it('warns when the sample cannot support the requested rate', () => {
    const s = summarise('REPETITION', healthy(200), { falsePositiveRate: 0.001 });
    expect(s.caveats.join(' ')).toMatch(/~10,000 verdicts are needed/);
  });

  it('does not warn about sample size once there is enough tail', () => {
    const s = summarise('REPETITION', healthy(20_000), { falsePositiveRate: 0.001 });
    expect(s.caveats.join(' ')).not.toMatch(/too small/);
  });

  /*
   * The caveat must not mention this detector's own n, or two detectors with
   * slightly different sample counts produce near-identical sentences that
   * the reporter cannot collapse -- and the warning drowns the specific ones.
   */
  it('phrases the sample-size caveat identically across detectors', () => {
    const a = summarise('REPETITION', healthy(8000), { falsePositiveRate: 0.001 });
    const b = summarise('TAIL_LOOP', healthy(7993), { falsePositiveRate: 0.001 });
    const shared = a.caveats.filter((c) => b.caveats.includes(c));
    expect(shared.some((c) => c.includes('too small'))).toBe(true);
  });

  it('prefers a gap and says so by omitting the budget caveat', () => {
    const scores = [...healthy(500), ...Array(10).fill(0.9)];
    const s = summarise('TAIL_LOOP', scores, { falsePositiveRate: 0.02 });
    expect(s.gap).not.toBeNull();
    expect(s.suggested).toBeGreaterThan(0.1);
    expect(s.suggested).toBeLessThan(0.9);
    expect(s.caveats.join(' ')).not.toMatch(/false-positive budget/);
  });

  it('falls back to a percentile and labels it as a budget, not a detector', () => {
    const s = summarise('REPETITION', healthy(20_000), { falsePositiveRate: 0.01 });
    expect(s.gap).toBeNull();
    expect(s.caveats.join(' ')).toMatch(/false-positive budget rather than a detection threshold/);
  });

  it('calls out a detector that never moved', () => {
    const s = summarise('LOW_ENTROPY', Array(5000).fill(0));
    expect(s.caveats.join(' ')).toMatch(/never moved/);
  });
});

describe('calibrate', () => {
  it('summarises each detector over only the samples that carry it', () => {
    const samples = [
      ...Array(100).fill({ REPETITION: 0.02, TAIL_LOOP: 0 }),
      ...Array(50).fill({ REPETITION: 0.03 }),
    ];
    const result = calibrate(samples);
    const byCode = Object.fromEntries(result.summaries.map((s) => [s.code, s.distribution.n]));
    expect(result.n).toBe(150);
    expect(byCode.REPETITION).toBe(150);
    // A detector that was disabled must not be counted as a run of zeros.
    expect(byCode.TAIL_LOOP).toBe(100);
  });

  it('ignores non-numeric and non-finite scores', () => {
    const result = calibrate([
      { REPETITION: 0.1 },
      { REPETITION: NaN } as never,
      { REPETITION: 'high' } as never,
    ]);
    expect(result.summaries[0].distribution.n).toBe(1);
  });
});

describe('extractScores', () => {
  it('reads a bare scores object', () => {
    expect(extractScores({ REPETITION: 0.03, TAIL_LOOP: 0 })).toEqual({
      REPETITION: 0.03,
      TAIL_LOOP: 0,
    });
  });

  it('reads a whole verdict', () => {
    expect(extractScores({ ok: true, reasons: [], scores: { REPETITION: 0.03 } })).toEqual({
      REPETITION: 0.03,
    });
  });

  it('reads a verdict buried in a wider log record', () => {
    expect(
      extractScores({ level: 30, msg: 'reply', verdict: { scores: { TAIL_LOOP: 0.1 } } }),
    ).toEqual({ TAIL_LOOP: 0.1 });
  });

  it('returns null for records with nothing recognisable', () => {
    expect(extractScores({ level: 30, msg: 'hello' })).toBeNull();
    expect(extractScores('nope')).toBeNull();
    expect(extractScores(null)).toBeNull();
  });
});

describe('cli', () => {
  const capture = async (argv: string[]) => {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => (chunks.push(s), true)) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => (chunks.push(s), true)) as typeof process.stderr.write;
    try {
      const code = await main(['node', 'cli', ...argv]);
      return { code, out: chunks.join('') };
    } finally {
      process.stdout.write = write;
      process.stderr.write = errWrite;
    }
  };

  it('exits non-zero with usage when given nothing', async () => {
    const { code, out } = await capture([]);
    expect(code).toBe(1);
    expect(out).toContain('calibrate');
  });

  it('rejects a nonsensical --fpr', async () => {
    const { code, out } = await capture(['calibrate', '--fpr', '5', 'x.jsonl']);
    expect(code).toBe(1);
    expect(out).toContain('between 0 and 1');
  });

  it('reports a readable error for a missing file', async () => {
    const { code, out } = await capture(['calibrate', 'does-not-exist.jsonl']);
    expect(code).toBe(1);
    expect(out).toContain('Could not read');
  });
});
