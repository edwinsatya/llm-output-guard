import { describe, it, expect } from 'vitest';
import {
  repetitionScore, tailLoopScore, compressionRatio, compressibilityScore,
  emptinessScore, shortnessScore, truncationScore, jsonScore,
  languageMismatchScore, stripFence,
} from '../src/detectors/index.js';

const PROSE =
  'Circuit breakers work by tracking consecutive failures against a threshold. ' +
  'Once that threshold is crossed the breaker opens and later calls fail immediately, ' +
  'without touching the downstream service at all. After a cooldown window it allows ' +
  'a single trial request through to see whether the dependency has recovered.';

describe('repetitionScore', () => {
  it('stays near zero for healthy prose', () => {
    expect(repetitionScore(PROSE)).toBeLessThan(0.1);
  });
  it('approaches one for a collapsed loop', () => {
    expect(repetitionScore(Array(40).fill('the same clause again').join(' '))).toBeGreaterThan(0.8);
  });
  it('declines to judge text too short to be meaningful', () => {
    expect(repetitionScore('too short')).toBe(0);
  });
  it('is monotonic as repetition increases', () => {
    const mk = (n: number) => PROSE + ' ' + Array(n).fill('repeat this bit').join(' ');
    expect(repetitionScore(mk(20))).toBeGreaterThan(repetitionScore(mk(5)));
  });
});

describe('tailLoopScore', () => {
  it('catches a loop that only starts halfway through', () => {
    const text = PROSE + ' ' + Array(30).fill('and then it repeats forever').join(' ');
    expect(tailLoopScore(text)).toBeGreaterThan(0.5);
  });
  it('ignores healthy endings', () => {
    expect(tailLoopScore(PROSE)).toBeLessThan(0.2);
  });
});

describe('compressibility', () => {
  it('reports a healthy ratio for natural language', () => {
    expect(compressionRatio(PROSE)).toBeGreaterThan(0.25);
  });
  it('collapses toward zero for character spam', () => {
    expect(compressionRatio('x'.repeat(500))).toBeLessThan(0.05);
  });
  it('scores spam as suspicious and prose as clean', () => {
    expect(compressibilityScore('x'.repeat(500))).toBeGreaterThan(0.9);
    expect(compressibilityScore(PROSE)).toBeLessThan(0.6);
  });
  it('abstains on samples too small to measure', () => {
    expect(compressibilityScore('short')).toBe(0);
  });
});

describe('emptiness', () => {
  it.each([['', 1], ['   \n\t ', 1], ['...', 1], ['{}', 1], ['```json\n```', 1], ['Hi.', 0]])(
    'scores %j as %d', (input, want) => {
      expect(emptinessScore(input as string)).toBe(want);
    });
  it('scales shortness against the minimum', () => {
    expect(shortnessScore('abcde', 10)).toBeCloseTo(0.5);
    expect(shortnessScore('abcdefghij', 10)).toBe(0);
    expect(shortnessScore('anything', 0)).toBe(0);
  });
});

describe('truncationScore', () => {
  it('trusts the provider stop reason above all heuristics', () => {
    expect(truncationScore('A perfectly finished sentence.', { finishReason: 'length' })).toBe(1);
  });
  it('catches an unbalanced code fence', () => {
    expect(truncationScore('here:\n```ts\nconst a = 1;')).toBeGreaterThan(0.8);
  });
  it('treats a missing full stop as weak evidence only', () => {
    const s = truncationScore('this sentence just stops in the middle of');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(0.75);
  });
  it('accepts a closed fence as a legitimate ending', () => {
    expect(truncationScore('here:\n```ts\nconst a = 1;\n```')).toBe(0);
  });
});

describe('jsonScore', () => {
  it('accepts bare and fenced payloads alike', () => {
    expect(jsonScore('{"a":1}').score).toBe(0);
    expect(jsonScore('```json\n{"a":1}\n```').score).toBe(0);
  });
  it('rejects prose wrapped around a payload', () => {
    expect(jsonScore('Sure! {"a":1} hope that helps').reason).toBe('unparseable');
  });
  it('reports exactly which keys are missing', () => {
    const r = jsonScore('{"a":1}', { requiredKeys: ['a', 'b', 'c'] });
    expect(r.score).toBe(1);
    expect(r.missingKeys).toEqual(['b', 'c']);
  });
  it('rejects a top-level array when keys are required', () => {
    expect(jsonScore('[1,2]', { requiredKeys: ['a'] }).score).toBe(1);
  });
  it('strips fences without mangling bare text', () => {
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe('languageMismatchScore', () => {
  it('flags English served where Indonesian was expected', () => {
    expect(languageMismatchScore(PROSE, 'id')).toBeGreaterThan(0.6);
  });
  it('passes Indonesian served where Indonesian was expected', () => {
    const id =
      'Berdasarkan repositori yang ada, kandidat ini terlihat nyaman dengan TypeScript dan React. ' +
      'Ada beberapa proyek yang menunjukkan pemahaman soal arsitektur frontend, dan itu bisa jadi ' +
      'bahan untuk pertanyaan lanjutan di sesi wawancara nanti.';
    expect(languageMismatchScore(id, 'id')).toBeLessThan(0.3);
  });
  it('abstains on short samples rather than guessing', () => {
    expect(languageMismatchScore('Hello there friend', 'id')).toBe(0);
  });
  it('abstains on languages it does not model', () => {
    expect(languageMismatchScore(PROSE, 'jv')).toBe(0);
  });
});

/**
 * Three bugs found by asking "what shape of input has nobody tried?", which is
 * the question that found every real defect in this package so far. Two of them
 * share a root cause -- a lookup that walked the prototype chain -- and the
 * third is a heuristic reading characters it should not have been counting.
 */
describe('structural signals are not read inside string literals', () => {
  /*
   * The heuristics count brackets and fences across raw text. A JSON payload
   * carrying a code snippet -- an extremely ordinary thing for a model to
   * return -- put those characters inside a string, and complete valid JSON
   * scored 0.8 or 0.9 as truncated.
   */
  it.each([
    ['an opening brace in a value', '{"note":"the opening brace { is literal","done":true}'],
    ['a fence in a value', '{"snippet":"```js","done":true}'],
    ['unbalanced brackets in a value', '{"expr":"a[0] + b(1","done":true}'],
    ['an array payload', '[{"a":"{"},{"b":"["}]'],
  ])('scores complete JSON with %s as 0', (_label, payload) => {
    expect(JSON.parse(payload)).toBeDefined(); // it really is complete
    expect(truncationScore(payload)).toBe(0);
  });

  it.each([
    ['an unclosed fence', 'Here you go:\n```js\nconst a = 1;', 0.9],
    ['a sentence cut off', 'The tradeoff is that the client has to', 0.55],
    ['unclosed JSON', '{"a":1,"b":', 0.8],
  ])('still detects %s', (_label, text, expected) => {
    expect(truncationScore(text)).toBe(expected);
  });

  it('lets the provider stop reason win over a parseable payload', () => {
    // Parseable and cut short at the ceiling are not mutually exclusive.
    expect(truncationScore('{"a":1}', { finishReason: 'length' })).toBe(1);
  });
});

describe('language names are not taken from the prototype chain', () => {
  const LONG =
    'the quick brown fox jumps over the lazy dog and then some more words to pass ' +
    'the minimum word count threshold here and a few extra words for good measure indeed';

  /*
   * `expected in PROFILES` was true for every name on Object.prototype, so the
   * guard passed, the target share read a function instead of a number, and the
   * score came back NaN -- neither above nor below any threshold, which
   * silently disables the detector and poisons any histogram built from it.
   */
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'abstains on %s rather than returning NaN',
    (name) => {
      const score = languageMismatchScore(LONG, name);
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBe(0);
    },
  );

  it('still detects a real mismatch', () => {
    expect(languageMismatchScore(LONG, 'id')).toBeGreaterThan(0.5);
  });

  it('still passes matching text', () => {
    expect(languageMismatchScore(LONG, 'en')).toBe(0);
  });
});
