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
import { badFixtures, goodFixtures } from '../test/fixtures/load.js';
import { repetitionScore, tailLoopScore, compressibilityScore } from '../src/detectors/index.js';

const DETECTORS = {
  REPETITION: (t: string) => repetitionScore(t),
  TAIL_LOOP: (t: string) => tailLoopScore(t),
  LOW_ENTROPY: (t: string) => compressibilityScore(t),
};

const pad = (s: string, n: number) => s.padEnd(n);
const fmt = (n: number) => n.toFixed(3).padStart(6);

for (const [name, fn] of Object.entries(DETECTORS)) {
  const good = goodFixtures.map((f) => ({ id: f.id, score: fn(f.text) }));
  const bad = badFixtures.map((f) => ({ id: f.id, score: fn(f.text) }));

  const worstGood = good.reduce((a, b) => (b.score > a.score ? b : a));
  const relevant = bad.filter((b) => b.score > 0.05);
  const weakestBad = relevant.length
    ? relevant.reduce((a, b) => (b.score < a.score ? b : a))
    : null;

  console.log(`\n=== ${name} ===`);
  console.log(`  healthy max : ${fmt(worstGood.score)}  (${worstGood.id})`);
  if (weakestBad) {
    console.log(`  degenerate min: ${fmt(weakestBad.score)}  (${weakestBad.id})`);
    const margin = weakestBad.score - worstGood.score;
    console.log(`  margin      : ${fmt(margin)}  ${margin > 0.2 ? 'OK' : 'THIN -- do not tune, improve the detector'}`);
    if (margin > 0) {
      console.log(`  suggested   : ${fmt(worstGood.score + margin / 2)}`);
    }
  } else {
    console.log('  degenerate min: none above noise floor for this detector');
  }

  console.log('  --- healthy, highest first ---');
  for (const g of good.sort((a, b) => b.score - a.score).slice(0, 5)) {
    console.log(`    ${fmt(g.score)}  ${pad(g.id, 34)}`);
  }
}
console.log('');
