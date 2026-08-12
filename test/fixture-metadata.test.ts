import { describe, it, expect } from 'vitest';
import { checkOutput } from '../src/index.js';
import { tailLoopDetail } from '../src/detectors/index.js';
import { words, nonSpacedRatio } from '../src/internal/tokenize.js';
import { presets } from '../src/presets.js';
import { badFixtures, goodFixtures, type Fixture } from './fixtures/load.js';

/**
 * Keeps fixture metadata honest.
 *
 * A fixture is only worth what its label says it is, and a label nobody
 * recomputes rots. This corpus has produced that failure twice: a note claiming
 * a non-spaced ratio of 0.45 on text that measured 0.77, and a "healthy"
 * control built by repeating one paragraph, which made the control itself a
 * loop. Both were found by re-reading. That is luck, not process.
 *
 * What this file guarantees: every number a fixture *declares* in `measured`
 * matches what the shipped detectors compute for it today. What it does not
 * guarantee: that prose in `note` is true -- only that a fixture whose note
 * cites a score is forced to declare at least one machine-checked anchor
 * alongside it, so the note cannot be the only record.
 */
const ALL: Fixture[] = [...badFixtures, ...goodFixtures];

/** A score-like decimal: 0.45, 0.829. Years and counts are not scores. */
const CITES_A_SCORE = /\b0\.\d{2,3}\b/;

const TOLERANCE = 0.002;

describe('fixture metadata matches the fixture', () => {
  it('covers a corpus that actually declares things', () => {
    expect(ALL.filter((f) => f.measured).length).toBeGreaterThanOrEqual(10);
  });

  for (const fx of ALL.filter((f) => f.measured)) {
    it(`${fx.id} is what it says it is`, () => {
      const m = fx.measured!;
      const options = { ...presets.chat, ...fx.options };

      if (m.chars !== undefined) {
        expect(fx.text.length, 'chars').toBe(m.chars);
      }
      if (m.wordTokens !== undefined) {
        expect(words(fx.text).length, 'wordTokens').toBe(m.wordTokens);
      }
      if (m.nonSpacedRatio !== undefined) {
        expect(nonSpacedRatio(fx.text), 'nonSpacedRatio').toBeCloseTo(m.nonSpacedRatio, 2);
      }
      if (m.tailNonSpacedRatio !== undefined) {
        expect(nonSpacedRatio(fx.text.slice(-400)), 'tailNonSpacedRatio')
          .toBeCloseTo(m.tailNonSpacedRatio, 2);
      }
      if (m.tailLoop) {
        const detail = tailLoopDetail(fx.text);
        expect(detail.mode, 'tailLoop.mode').toBe(m.tailLoop.mode);
        expect(Math.abs(detail.score - m.tailLoop.score), `tailLoop.score was ${detail.score}`)
          .toBeLessThan(TOLERANCE);
      }
      if (m.scores) {
        const verdict = checkOutput(fx.text, options);
        for (const [code, declared] of Object.entries(m.scores)) {
          const actual = verdict.scores[code as keyof typeof verdict.scores];
          expect(actual, `scores.${code} missing`).toBeDefined();
          expect(Math.abs(actual! - declared), `scores.${code} was ${actual}`)
            .toBeLessThan(TOLERANCE);
        }
      }
    });
  }

  /*
   * The rule that stops the next drift: if a note quotes a score, the fixture
   * has to carry at least one recomputed anchor. It does not prove the quoted
   * number is right, but it means the fixture's real behaviour is written down
   * somewhere a test reads, next to the prose that describes it.
   */
  it('every fixture whose note quotes a score also declares measurements', () => {
    const undeclared = ALL
      .filter((f) => CITES_A_SCORE.test(f.note))
      .filter((f) => !f.measured || Object.keys(f.measured).length === 0)
      .map((f) => f.id);
    expect(undeclared, 'notes quoting scores without a measured block').toEqual([]);
  });

  /*
   * The other half of the same bug. A healthy fixture assembled by repeating
   * one block is degenerate by this package's own definition, and using it as a
   * control makes the control agree with whatever it was built to prove.
   */
  it('no healthy fixture is built from a repeated block', () => {
    const offenders = goodFixtures
      .filter((f) => f.text.length >= 200)
      .filter((f) => tailLoopDetail(f.text).score > 0.5 || checkOutput(f.text, {
        ...presets.chat, ...f.options,
      }).scores.REPETITION! > 0.5)
      .map((f) => f.id);
    expect(offenders, 'healthy fixtures that are themselves loops').toEqual([]);
  });
});
