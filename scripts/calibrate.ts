/**
 * Prints the score distribution across the fixture corpus.
 *
 * Run this before changing any threshold. The gap between the worst healthy
 * score and the best degenerate score is the safety margin -- if that gap is
 * thin or inverted, the threshold is guesswork and the detector needs work
 * rather than retuning.
 *
 *   npm run calibrate
 */
import { badFixtures, goodFixtures, type Fixture } from '../test/fixtures/load.js';
import {
  repetitionScore,
  tailLoopScore,
  tailLoopDetail,
  compressibilityScore,
  compressionRatio,
} from '../src/detectors/index.js';
import type { ReasonCode } from '../src/types.js';

interface Detector {
  score: (t: string) => number;
  /**
   * The code this detector is responsible for. A fixture's degenerate score
   * only counts toward this margin when the fixture is *labelled* for this
   * detector -- otherwise a tail loop that LOW_ENTROPY was never meant to
   * catch drags LOW_ENTROPY's margin negative and the report reads like a
   * regression in a detector nothing changed about.
   */
  code: ReasonCode;
  /**
   * Splits the corpus into separately-reported groups.
   *
   * `TAIL_LOOP` needs this: it measures words on spaced scripts and characters
   * on the rest, and those are two distributions with different base rates.
   * One pooled margin would describe neither, which is the same reason
   * `Verdict.modes` exists and `calibrate` segments on it.
   */
  segment?: (t: string) => string;
  /**
   * The pre-clamp signal, when the score is a clamped transform of one.
   * Without it a floored healthy distribution is unreadable: every fixture
   * prints 0.000 whether it sat one hair above the clamp or miles clear of it.
   */
  raw?: { label: string; of: (t: string) => number };
}

const DETECTORS: Record<string, Detector> = {
  REPETITION: { code: 'REPETITION', score: (t) => repetitionScore(t) },
  TAIL_LOOP: {
    code: 'TAIL_LOOP',
    score: (t) => tailLoopScore(t),
    segment: (t) => tailLoopDetail(t).mode,
  },
  LOW_ENTROPY: {
    code: 'LOW_ENTROPY',
    score: (t) => compressibilityScore(t),
    raw: { label: 'compression ratio', of: (t) => compressionRatio(t) },
  },
};

const pad = (s: string, n: number) => s.padEnd(n);
const fmt = (n: number) => n.toFixed(3).padStart(6);

/** Fixture groups this detector should be judged on, in report order. */
function groupsOf(detector: Detector): Array<{ label: string; good: Fixture[]; bad: Fixture[] }> {
  // Only fixtures labelled for this detector count as its degenerate set.
  const owned = badFixtures.filter((f) => f.expect?.includes(detector.code));
  if (!detector.segment) return [{ label: '', good: goodFixtures, bad: owned }];

  const labels = [...new Set(goodFixtures.map((f) => detector.segment!(f.text)))].sort();
  return labels.map((label) => ({
    label,
    good: goodFixtures.filter((f) => detector.segment!(f.text) === label),
    bad: owned.filter((f) => detector.segment!(f.text) === label),
  }));
}

for (const [name, detector] of Object.entries(DETECTORS)) {
 for (const group of groupsOf(detector)) {
  const good = group.good.map((f) => ({ id: f.id, score: detector.score(f.text) }));
  const bad = group.bad.map((f) => ({ id: f.id, score: detector.score(f.text) }));
  if (good.length === 0) continue;

  const worstGood = good.reduce((a, b) => (b.score > a.score ? b : a));
  const relevant = bad.filter((b) => b.score > 0.05);
  const weakestBad = relevant.length
    ? relevant.reduce((a, b) => (b.score < a.score ? b : a))
    : null;

  console.log(`\n=== ${name}${group.label ? ` [${group.label}]` : ''} ===`);
  console.log(`  healthy max : ${fmt(worstGood.score)}  (${worstGood.id})`);
  if (weakestBad) {
    console.log(`  degenerate min: ${fmt(weakestBad.score)}  (${weakestBad.id})`);
    const margin = weakestBad.score - worstGood.score;
    console.log(`  margin      : ${fmt(margin)}  ${margin > 0.2 ? 'OK' : 'THIN -- do not tune, improve the detector'}`);

    /*
     * A midpoint is only evidence when the healthy scores have spread. When
     * every one of them is pinned to the floor, the distribution carries no
     * information about how close healthy output actually came, and half the
     * margin is a number with nothing behind it -- the kind of suggestion
     * that gets adopted precisely because it looks calculated.
     */
    const floored = good.every((g) => g.score === worstGood.score);
    if (floored) {
      console.log(`  suggested   : n/a -- every healthy fixture scores ${fmt(worstGood.score).trim()}`);
      console.log('                the margin is a lower bound, not a measurement.');
      if (detector.raw) console.log(`                read the ${detector.raw.label} spread below instead.`);
    } else if (margin > 0) {
      console.log(`  suggested   : ${fmt(worstGood.score + margin / 2)}`);
    }
  } else {
    console.log('  degenerate min: none above noise floor for this detector');
  }

  console.log('  --- healthy, highest first ---');
  for (const g of good.sort((a, b) => b.score - a.score).slice(0, 5)) {
    console.log(`    ${fmt(g.score)}  ${pad(g.id, 34)}`);
  }

  if (detector.raw) {
    const { label, of } = detector.raw;
    const rawGood = group.good.map((f) => of(f.text));
    const rawBad = group.bad.map((f) => ({ id: f.id, v: of(f.text) }));
    // Degenerate on this axis means a *low* ratio; the rest are other failures.
    const collapsed = rawBad.filter((b) => b.v < Math.min(...rawGood)).sort((a, b) => b.v - a.v);
    console.log(`  --- ${label}: the signal before clamping ---`);
    console.log(`    healthy    : ${fmt(Math.min(...rawGood))} .. ${fmt(Math.max(...rawGood))}`);
    if (collapsed.length) {
      console.log(`    degenerate : ${fmt(collapsed[collapsed.length - 1].v)} .. ${fmt(collapsed[0].v)}  (worst: ${collapsed[0].id})`);
      console.log(`    true gap   : ${fmt(Math.min(...rawGood) - collapsed[0].v)}`);
    }
  }
 }
}
console.log('');
