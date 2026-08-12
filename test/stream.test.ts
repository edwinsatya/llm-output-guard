import { describe, it, expect, vi } from 'vitest';
import { createStreamGuard, guardStream, presets } from '../src/index.js';
import type { Verdict } from '../src/types.js';

/** Emit `text` in fixed-size pieces, the way a token stream arrives. */
async function* streamOf(text: string, size = 20): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

const HEALTHY =
  'Redis pub/sub is the right primitive here. Each server subscribes to the room ' +
  'channel and publishes moves to it, so fan-out no longer depends on which instance ' +
  'a given socket happens to land on. The tradeoff is that delivery is at-most-once, ' +
  'so a client that reconnects mid-game needs to refetch state rather than replay. ' +
  'For a board game that is fine, because the board is small and authoritative.';

const LOOPING =
  'Your strongest area is TypeScript, and the repos show it. ' +
  'You should add tests to this repo. '.repeat(60);

function collect(guard: ReturnType<typeof createStreamGuard>, text: string, size = 20) {
  const verdicts: Verdict[] = [];
  for (let i = 0; i < text.length; i += size) {
    const v = guard.push(text.slice(i, i + size));
    if (v) verdicts.push(v);
  }
  return verdicts;
}

describe('createStreamGuard', () => {
  it('abstains during warmup rather than judging a first sentence', () => {
    const guard = createStreamGuard(presets.chat);
    expect(guard.push('Short so far.')).toBeNull();
    expect(guard.checks).toBe(0);
  });

  /*
   * The whole reason mid-stream needs its own detector set. Every one of these
   * fires on healthy partial output if the full check is used unchanged.
   */
  it('never reports TOO_SHORT, TRUNCATED or INVALID_JSON mid-stream', () => {
    const guard = createStreamGuard({
      ...presets.strictJson,
      requiredKeys: ['score', 'notes'],
      maxTruncation: 0.5,
      minLength: 500,
      checkEvery: 50,
    });
    const partial = '{"score": 8, "notes": "the candidate walked through three approaches and ';
    const codes = collect(guard, partial, 20).flatMap((v) => v.reasons.map((r) => r.code));
    expect(codes).not.toContain('TOO_SHORT');
    expect(codes).not.toContain('TRUNCATED');
    expect(codes).not.toContain('INVALID_JSON');
  });

  it('passes a healthy stream all the way through', () => {
    const guard = createStreamGuard(presets.chat);
    const verdicts = collect(guard, HEALTHY);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((v) => v.ok)).toBe(true);
    expect(guard.end('stop').ok).toBe(true);
  });

  it('catches a loop long before the stream finishes', () => {
    const guard = createStreamGuard(presets.chat);
    let caughtAt = -1;
    for (let i = 0; i < LOOPING.length; i += 20) {
      const v = guard.push(LOOPING.slice(i, i + 20));
      if (v && !v.ok) {
        caughtAt = guard.text.length;
        break;
      }
    }
    expect(caughtAt).toBeGreaterThan(0);
    // The point of the feature: caught in the first fraction, not at the end.
    expect(caughtAt).toBeLessThan(LOOPING.length / 3);
  });

  it('applies the deferred detectors at end(), where they are meaningful', () => {
    const guard = createStreamGuard({ ...presets.strictJson, requiredKeys: ['score'] });
    guard.push('{"notes": "no score key here at all, just prose about the candidate"}');
    const final = guard.end('stop');
    expect(final.ok).toBe(false);
    expect(final.reasons.map((r) => r.code)).toContain('INVALID_JSON');
  });

  it('honours finishReason at end()', () => {
    const guard = createStreamGuard(presets.chat);
    guard.push(HEALTHY);
    expect(guard.end('stop').ok).toBe(true);
    const cut = createStreamGuard({ ...presets.chat, maxTruncation: 0.75 });
    cut.push(HEALTHY);
    expect(cut.end('length').reasons.map((r) => r.code)).toContain('TRUNCATED');
  });

  it('ignores empty chunks and keeps the text exact', () => {
    const guard = createStreamGuard(presets.chat);
    guard.push('one ');
    guard.push('');
    guard.push('two');
    expect(guard.text).toBe('one two');
  });

  it('batches checks instead of scanning per chunk', () => {
    const guard = createStreamGuard({ ...presets.chat, checkEvery: 400 });
    collect(guard, 'x'.repeat(4000), 10); // 400 chunks
    expect(guard.checks).toBeLessThanOrEqual(10);
  });

  /*
   * LOW_ENTROPY costs ~100x the other two detectors, which is affordable once
   * per response and ruinous per check. If it ever runs mid-stream again the
   * guard silently becomes too expensive to leave on, so pin it here.
   */
  it('does not run the expensive LOW_ENTROPY detector mid-stream', () => {
    const guard = createStreamGuard(presets.chat);
    const verdicts = collect(guard, HEALTHY);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((v) => v.scores.LOW_ENTROPY === undefined)).toBe(true);
    // ...but it is still applied to the finished text.
    expect(guard.end('stop').scores.LOW_ENTROPY).toBeTypeOf('number');
  });

  /*
   * The observable consequence of the trailing window, tested without a clock.
   *
   * Measured across the whole buffer, a loop arriving after several healthy
   * paragraphs is diluted below every threshold -- the longer the good prefix,
   * the more thoroughly it hides the bad suffix. A windowed check sees only
   * recent text, so the prefix cannot vote.
   */
  it('still catches a loop that starts after a long healthy prefix', () => {
    const text = HEALTHY.repeat(6) + ' ' + 'You should add tests to this repo. '.repeat(40);
    const guard = createStreamGuard(presets.chat);
    const failed = collect(guard, text, 16).filter((v) => !v.ok);
    expect(failed.length).toBeGreaterThan(0);
  });

  /*
   * Without the window each check re-scans the whole buffer, so a stream costs
   * quadratic work in its own length: the pre-window implementation took 94ms
   * on 5.5k characters, which extrapolates past six seconds here. The budget
   * is deliberately loose -- this catches a return to quadratic, not a
   * regression of a few milliseconds, so it does not flake on a loaded runner.
   */
  it('does not degrade to quadratic work on a long stream', () => {
    const text = HEALTHY.repeat(80); // ~30k characters
    const guard = createStreamGuard(presets.chat);
    const started = performance.now();
    collect(guard, text, 16);
    expect(guard.checks).toBeGreaterThan(20);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('guardStream', () => {
  it('yields a healthy stream unchanged and reports the final verdict', async () => {
    const onEnd = vi.fn();
    let out = '';
    for await (const chunk of guardStream(streamOf(HEALTHY), { ...presets.chat, onEnd })) {
      out += chunk;
    }
    expect(out).toBe(HEALTHY);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd.mock.calls[0][0].ok).toBe(true);
  });

  it('stops early and fires onDegenerate exactly once', async () => {
    const onDegenerate = vi.fn();
    let out = '';
    for await (const chunk of guardStream(streamOf(LOOPING), { ...presets.chat, onDegenerate })) {
      out += chunk;
    }
    expect(onDegenerate).toHaveBeenCalledOnce();
    expect(out.length).toBeLessThan(LOOPING.length / 2);
  });

  it('does not call onEnd when it cut the stream short', async () => {
    const onEnd = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of guardStream(streamOf(LOOPING), { ...presets.chat, onEnd })) {
      /* drain */
    }
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('keeps passing chunks through when stopOnDegenerate is false', async () => {
    const onDegenerate = vi.fn();
    let out = '';
    for await (const chunk of guardStream(streamOf(LOOPING), {
      ...presets.chat,
      stopOnDegenerate: false,
      onDegenerate,
    })) {
      out += chunk;
    }
    expect(onDegenerate).toHaveBeenCalledOnce();
    expect(out).toBe(LOOPING);
  });
});
