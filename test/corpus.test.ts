import { describe, it, expect } from 'vitest';
import { checkOutput } from '../src/index.js';
import { presets } from '../src/presets.js';
import type { CheckOptions } from '../src/types.js';
import { badFixtures, goodFixtures } from './fixtures/load.js';

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
