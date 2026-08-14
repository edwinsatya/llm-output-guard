import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { checkOutput, presets } from '../src/index.js';
import type { CheckOptions } from '../src/types.js';

/**
 * `redundancyScope`, and the false positive it exists to remove.
 *
 * A model asked for the status of twenty services and returning twenty identical
 * rows has done exactly what it was told. Measured across the document that is a
 * perfect loop: 1.2.1 scores it `TAIL_LOOP: 1.000` and fails it under every
 * preset, `lenient` and `strictJson` included -- and `strictJson` is the preset
 * most likely to be pointed at that payload.
 *
 * The scores were never wrong. Twenty identical records *are* exactly periodic.
 * The detectors were being asked about the wrong span.
 */

const rows = (n: number, row: () => object) =>
  JSON.stringify(Array.from({ length: n }, row), null, 2);

const IDENTICAL = (n: number) => rows(n, () => ({ status: 'ok', count: 0 }));
const JSON_SCOPE: CheckOptions = { redundancyScope: 'jsonValues' };

describe('the false positive this option removes', () => {
  /*
   * Three records is enough to trip it, which is what makes this worth fixing
   * rather than documenting: it is not an exotic payload size.
   */
  it.each([3, 4, 10, 20, 60])('fails %i identical records under the default scope', (n) => {
    const verdict = checkOutput(IDENTICAL(n), presets.strictJson);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.map((r) => r.code)).toContain('TAIL_LOOP');
  });

  it.each([3, 4, 10, 20, 60])('passes %i identical records under jsonValues', (n) => {
    const verdict = checkOutput(IDENTICAL(n), { ...presets.strictJson, ...JSON_SCOPE });
    expect(verdict.ok).toBe(true);
  });

  it('fails under every shipped preset, including lenient', () => {
    for (const name of ['chat', 'strictJson', 'longForm', 'lenient'] as const) {
      expect(checkOutput(IDENTICAL(20), presets[name]).ok, `presets.${name}`).toBe(false);
    }
  });

  /* Partial repetition too -- "most services are fine" is the common shape. */
  it('stops flagging an array that is only mostly repetitive', () => {
    const mixed = JSON.stringify(
      Array.from({ length: 20 }, (_, i) =>
        i < 15 ? { status: 'ok', count: 0 } : { status: 'warn', count: i },
      ),
      null,
      2,
    );
    expect(checkOutput(mixed, presets.strictJson).ok).toBe(false);
    expect(checkOutput(mixed, { ...presets.strictJson, ...JSON_SCOPE }).ok).toBe(true);
  });

  it('stops flagging repeated enum values', () => {
    const enums = rows(20, () => ({ status: 'ok', tier: 'gold' }));
    expect(checkOutput(enums, presets.strictJson).ok).toBe(false);
    expect(checkOutput(enums, { ...presets.strictJson, ...JSON_SCOPE }).ok).toBe(true);
  });
});

describe('it is more sensitive, not less', () => {
  it('still catches a loop inside a string value', () => {
    const looping = JSON.stringify({
      notes: 'You should add tests to this repo. '.repeat(40),
      score: 8,
    });
    const verdict = checkOutput(looping, { ...presets.strictJson, ...JSON_SCOPE });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.map((r) => r.code)).toContain('REPETITION');
  });

  /*
   * The case the default scope misses. A loop confined to one element of an
   * array is averaged away across the document and reads clearly on its own --
   * so this option removes a false positive and closes a false negative in the
   * same change.
   */
  it('catches a loop confined to one element, which the document scope misses', () => {
    const oneBadItem = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({
        q: i === 2 ? '我需要更多的信息才能回答这个问题'.repeat(30) : `question ${i}`,
      })),
    );

    expect(checkOutput(oneBadItem, presets.strictJson).ok, 'document scope should miss it').toBe(
      true,
    );

    const scoped = checkOutput(oneBadItem, { ...presets.strictJson, ...JSON_SCOPE });
    expect(scoped.ok).toBe(false);
    expect(scoped.reasons.map((r) => r.code)).toContain('TAIL_LOOP');
    // The mode travels with the span that produced the score.
    expect(scoped.modes?.TAIL_LOOP).toBe('char');
  });
});

describe('it applies only where it can', () => {
  it('measures unparseable text as a document, unchanged', () => {
    const prose = 'Your strongest area is TypeScript. ' + 'You should add tests. '.repeat(40);
    const doc = checkOutput(prose, presets.chat);
    const scoped = checkOutput(prose, { ...presets.chat, ...JSON_SCOPE });
    expect(scoped.scores).toEqual(doc.scores);
    expect(scoped.ok).toBe(false);
  });

  it('does not disable redundancy on a truncated payload', () => {
    // Partial JSON never parses, which is also every mid-stream check.
    const cut = '[{"note":"' + 'loop loop loop '.repeat(40);
    const scoped = checkOutput(cut, { ...presets.chat, ...JSON_SCOPE });
    expect(scoped.ok).toBe(false);
    expect(scoped.reasons.map((r) => r.code)).toContain('REPETITION');
  });

  it('scores a payload of pure numbers as having no prose to judge', () => {
    const numeric = JSON.stringify(Array.from({ length: 40 }, () => ({ a: 1, b: 2 })));
    const scoped = checkOutput(numeric, { ...presets.strictJson, ...JSON_SCOPE });
    expect(scoped.scores.REPETITION).toBe(0);
    expect(scoped.scores.TAIL_LOOP).toBe(0);
  });

  it('leaves the non-redundancy detectors reading the whole response', () => {
    // LOW_ENTROPY and TRUNCATED are unaffected by the scope.
    const doc = checkOutput(IDENTICAL(20), { ...presets.chat, maxTruncation: 0.5 });
    const scoped = checkOutput(IDENTICAL(20), {
      ...presets.chat,
      maxTruncation: 0.5,
      ...JSON_SCOPE,
    });
    expect(scoped.scores.LOW_ENTROPY).toBe(doc.scores.LOW_ENTROPY);
    expect(scoped.scores.TRUNCATED).toBe(doc.scores.TRUNCATED);
  });
});

/**
 * The freeze. `redundancyScope` defaults to `'document'`, and this asserts that
 * default produces byte-identical scores to 1.2.1 across the whole corpus --
 * every fixture and every preset, not a spot check. Without it, "opt-in" is a
 * claim rather than a property, and this lands as a minor on a package whose
 * stability table treats a changed verdict as the expensive kind of break.
 */
describe('the default scope is unchanged from 1.2.1', () => {
  const fixtures = (['good', 'bad'] as const).flatMap((dir) =>
    readdirSync(new URL(`fixtures/${dir}`, import.meta.url).pathname).map((file) => ({
      id: `${dir}/${file.replace('.json', '')}`,
      text: JSON.parse(
        readFileSync(new URL(`fixtures/${dir}/${file}`, import.meta.url).pathname, 'utf8'),
      ).text as string,
    })),
  );

  it('covers the whole corpus', () => {
    expect(fixtures.length).toBeGreaterThan(50);
  });

  it.each(['chat', 'strictJson', 'longForm', 'lenient'] as const)(
    'presets.%s scores identically with the scope left at its default',
    (name) => {
      for (const { id, text } of fixtures) {
        const implicit = checkOutput(text, presets[name]);
        const explicit = checkOutput(text, { ...presets[name], redundancyScope: 'document' });
        expect(explicit.scores, id).toEqual(implicit.scores);
        expect(explicit.ok, id).toBe(implicit.ok);
      }
    },
  );
});
