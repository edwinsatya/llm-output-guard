import { describe, it, expect } from 'vitest';
import { checkOutput } from '../src/index.js';
import { tailLoopDetail } from '../src/detectors/index.js';
import { presets } from '../src/presets.js';
import type { CheckOptions, ReasonCode, TokenMode } from '../src/types.js';
import { badFixtures, goodFixtures, type Fixture } from './fixtures/load.js';

/**
 * The contract this package lives or dies by.
 *
 * A miss is annoying. A false positive is fatal -- it means a healthy response
 * gets thrown away and retried against a slower provider for no reason, which
 * is a worse outcome than the bug this package exists to catch.
 */
describe('corpus: known-bad output is caught', () => {
  it('has a corpus worth trusting', () => {
    expect(badFixtures.length).toBeGreaterThanOrEqual(20);
    const categories = new Set(badFixtures.map((f) => f.category));
    expect(categories.size).toBeGreaterThanOrEqual(4);
  });

  for (const fx of badFixtures) {
    it(`flags ${fx.id} (${fx.category})`, () => {
      const verdict = checkOutput(fx.text, { ...presets.chat, ...fx.options });
      expect(verdict.ok, `expected a failure. note: ${fx.note}`).toBe(false);

      const codes = verdict.reasons.map((r) => r.code);
      expect(
        fx.expect!.some((c) => codes.includes(c)),
        `expected one of ${fx.expect!.join('|')}, got ${codes.join(',') || '(none)'}`,
      ).toBe(true);
    });
  }
});

describe('corpus: known-good output passes untouched', () => {
  it('has enough healthy samples to be a real guard', () => {
    expect(goodFixtures.length).toBeGreaterThanOrEqual(20);
  });

  for (const fx of goodFixtures) {
    it(`passes ${fx.id}`, () => {
      const verdict = checkOutput(fx.text, { ...presets.chat, ...fx.options });
      const detail = verdict.reasons
        .map((r) => `${r.code}=${r.score.toFixed(3)}>${r.threshold}`)
        .join(', ');
      expect(verdict.ok, `false positive on healthy output [${detail}] -- ${fx.note}`).toBe(true);
    });
  }
});

/**
 * A healthy fixture must be healthy *by measurement*, not only by passing.
 *
 * The failure this prevents actually happened: a control built by repeating one
 * paragraph scored `REPETITION 0.491` -- degenerate by this package's own
 * definition -- and was used as evidence that a detector behaved well. The score
 * was on screen the whole time in the margin report. What was missing was an
 * assertion, so a fixture only had to stay under a threshold to be believed.
 *
 * The rule comes from the corpus's own distribution rather than a chosen
 * multiplier: a healthy fixture must sit in the **lower half of the margin** for
 * its detector-mode pair, i.e. below half the weakest degenerate score for that
 * pair. Where the modes differ, so does the bound -- `TAIL_LOOP` allows 0.450 in
 * word mode and 0.415 in char mode, because their degenerate floors differ.
 *
 * Known residual: this catches a fixture built from a repeated block, and one
 * whose content cycles enough to score. It does *not* catch a generator whose
 * items are individually distinct but share a template, which produces mild
 * repetition below these bounds. That class still needs a human reading the
 * fixture.
 */
describe('corpus: healthy fixtures are healthy by measurement', () => {
  const PAIRS: Array<[ReasonCode, TokenMode | null]> = [
    ['REPETITION', null],
    ['TAIL_LOOP', 'word'],
    ['TAIL_LOOP', 'char'],
    ['LOW_ENTROPY', null],
  ];

  const scoreOf = (fx: Fixture, code: ReasonCode) =>
    checkOutput(fx.text, { ...presets.chat, ...fx.options }).scores[code] ?? 0;

  /** Same noise floor `npm run calibrate` uses: below this the detector abstained. */
  const NOISE = 0.05;

  for (const [code, mode] of PAIRS) {
    const label = `${code}${mode ? ` [${mode}]` : ''}`;
    const inSegment = (fx: Fixture) => (mode ? tailLoopDetail(fx.text).mode === mode : true);

    it(`no healthy fixture scores into degenerate territory for ${label}`, () => {
      const degenerate = badFixtures
        .filter((f) => f.expect?.includes(code))
        .filter(inSegment)
        .map((f) => scoreOf(f, code))
        .filter((v) => v > NOISE);

      // Nothing labelled for this pair means nothing to measure against.
      if (degenerate.length === 0) return;

      const cap = Math.min(...degenerate) / 2;
      const offenders = goodFixtures
        .filter(inSegment)
        .map((f) => ({ id: f.id, score: scoreOf(f, code) }))
        .filter((x) => x.score > cap);

      expect(
        offenders,
        `healthy fixtures scoring above ${cap.toFixed(3)} on ${label} — ` +
          'either the fixture is not healthy, or it belongs in bad/',
      ).toEqual([]);
    });
  }

  /*
   * Proof the bound has teeth, using the exact text that fooled us: one healthy
   * paragraph repeated. It never enters the corpus -- a guard is only worth
   * having if it fails on the thing it was built for, and asserting that here
   * costs nothing and cannot rot.
   */
  it('rejects the repeated-paragraph control that slipped through before', () => {
    const paragraph =
      'Redis pub/sub is the right primitive here. Each server subscribes to the room ' +
      'channel and publishes moves to it, so fan-out no longer depends on which instance ' +
      'a given socket happens to land on. The tradeoff is at-most-once delivery. ';
    const control = paragraph.repeat(2);

    const degenerate = badFixtures
      .filter((f) => f.expect?.includes('REPETITION'))
      .map((f) => scoreOf(f, 'REPETITION'))
      .filter((v) => v > NOISE);
    const cap = Math.min(...degenerate) / 2;

    const score = checkOutput(control, presets.chat).scores.REPETITION ?? 0;
    expect(score, 'the control really is repetitive').toBeGreaterThan(0.4);
    expect(score, 'and the bound rejects it').toBeGreaterThan(cap);
  });
});

describe('corpus: every preset holds the no-false-positive line', () => {
  const prosePresets = (Object.entries(presets) as Array<[string, CheckOptions]>)
    .filter(([, p]) => !p.expectJson);

  for (const [name, preset] of prosePresets) {
    it(`preset '${name}' passes all healthy prose fixtures`, () => {
      const offenders = goodFixtures
        .filter((f) => !f.options?.expectJson && f.text.trim().length >= 200)
        .filter((f) => !checkOutput(f.text, { ...preset, ...f.options }).ok)
        .map((f) => f.id);
      expect(offenders, `false positives under '${name}'`).toEqual([]);
    });
  }
});
