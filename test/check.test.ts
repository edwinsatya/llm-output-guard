import { describe, it, expect } from 'vitest';
import { checkOutput, assertOutput, DegenerateOutputError, presets } from '../src/index.js';

const HEALTHY =
  'Redis pub/sub is the right primitive here. Each server subscribes to the room ' +
  'channel and publishes moves to it, so fan-out no longer depends on which instance ' +
  'a given socket happens to land on.';

describe('checkOutput', () => {
  it('passes healthy output and reports scores anyway', () => {
    const v = checkOutput(HEALTHY, presets.chat);
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(Object.keys(v.scores).length).toBeGreaterThan(2);
  });

  it('collects every failing signal, not just the first', () => {
    const v = checkOutput(Array(60).fill('same thing').join(' '), presets.chat);
    expect(v.ok).toBe(false);
    expect(v.reasons.length).toBeGreaterThan(1);
  });

  it('short-circuits on empty output instead of reporting noise', () => {
    const v = checkOutput('   ', presets.chat);
    expect(v.ok).toBe(false);
    expect(v.reasons.map((r) => r.code)).toEqual(['EMPTY']);
  });

  it('returns the parsed payload when JSON is expected', () => {
    const v = checkOutput('{"score":8}', { expectJson: true });
    expect(v.ok).toBe(true);
    expect(v.json).toEqual({ score: 8 });
  });

  it('honours a disabled detector', () => {
    const loop = Array(60).fill('same thing').join(' ');
    const v = checkOutput(loop, { maxRepetition: null, maxTailLoop: null, maxCompressibility: null });
    expect(v.ok).toBe(true);
    expect(v.scores.REPETITION).toBeUndefined();
  });

  it('is deterministic', () => {
    const a = checkOutput(HEALTHY, presets.chat);
    const b = checkOutput(HEALTHY, presets.chat);
    expect(a).toEqual(b);
  });

  it('never throws on hostile input', () => {
    for (const input of ['', '\u0000', '\ud83d\ude80'.repeat(500), 'a'.repeat(50000)]) {
      expect(() => checkOutput(input, presets.chat)).not.toThrow();
    }
  });

  /*
   * The failure this package exists for includes the provider handing back no
   * text at all. A TypeError here would escape the caller's retry predicate,
   * which keys off DegenerateOutputError -- so a non-string must be a verdict.
   */
  it('treats a non-string response as EMPTY rather than throwing', () => {
    for (const input of [null, undefined, 123, {}, [], NaN]) {
      const v = checkOutput(input as unknown as string, presets.chat);
      expect(v.ok).toBe(false);
      expect(v.reasons.map((r) => r.code)).toEqual(['EMPTY']);
      expect(v.scores.EMPTY).toBe(1);
    }
  });

  it('names the offending type so the log says what arrived', () => {
    expect(checkOutput(null).reasons[0].message).toContain('null');
    expect(checkOutput(undefined).reasons[0].message).toContain('undefined');
  });
});

describe('assertOutput', () => {
  it('returns the text unchanged when healthy', () => {
    expect(assertOutput(HEALTHY, presets.chat)).toBe(HEALTHY);
  });

  it('throws a retryable error carrying the verdict', () => {
    try {
      assertOutput('', presets.chat);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DegenerateOutputError);
      const e = err as DegenerateOutputError;
      expect(e.retryable).toBe(true);
      expect(e.verdict.reasons[0].code).toBe('EMPTY');
      expect(e.message).toContain('EMPTY');
    }
  });
});

describe('presets', () => {
  it('strictJson rejects unparseable payloads', () => {
    expect(checkOutput('Sure! {"a":1}', presets.strictJson).ok).toBe(false);
  });
  it('lenient tolerates mild repetition that chat would reject', () => {
    const mild = HEALTHY + ' ' + Array(12).fill('and the same idea again').join(' ');
    expect(checkOutput(mild, presets.lenient).ok).toBe(true);
  });
});
