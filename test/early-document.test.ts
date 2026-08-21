import { describe, it, expect } from 'vitest';
import { createStreamGuard } from '../src/stream.js';
import { presets } from '../src/presets.js';
import type { Verdict } from '../src/types.js';

/**
 * `earlyDocumentChecks` and the reason it is off by default.
 *
 * `SCRIPT_MISMATCH` and `PROMPT_ECHO` measure the whole response, so a
 * mid-stream check reading a trailing window measures the wrong thing. Reading
 * the buffer instead is the right span -- and the buffer is a *prefix*, which
 * over-reports both, because a response that opens in another script or leaks
 * the prompt is at its worst when the least of it has arrived.
 *
 * These tests pin both halves: it catches the extreme case early, and it does
 * not touch the healthy responses that look extreme for their first few
 * hundred characters.
 */

/*
 * Varied prose, not a repeated sentence. Fixtures built with `.repeat()` score
 * REPETITION 0.9+ and TAIL_LOOP 0.97+ -- they are loops, whatever else they are
 * meant to demonstrate -- so a "healthy" trap built that way fails on the very
 * detectors this feature does not touch, and proves nothing about the ones it
 * does. The corpus tests enforce the same rule on the fixture files.
 */
const EN_SENTENCES = [
  'The connection pool is created once per worker process and is never shared across them. ',
  'That single fact drives most of the confusion teams have with the retry budget. ',
  'Health checks belong at the orchestrator level rather than inside the application. ',
  'Multiply your per-worker pool size by the worker count before comparing it to the limit. ',
  'At-most-once delivery is the tradeoff you accept when you reach for a message bus. ',
  'Rolling restarts briefly double the process count, so size for the deploy peak. ',
  'Alert on rejected connections rather than on pool saturation, which looks fine. ',
  'Storage and compaction are the price a log charges you for replayable history. ',
];

const ZH_SENTENCES = [
  '连接池不会在工作进程之间共享，每个进程都维护自己的连接池。',
  '重试预算是按工作进程计算的，而不是在整个服务范围内共享的。',
  '健康检查应该配置在编排层面，而不是写在应用程序内部。',
  '在部署时增加工作进程的数量，数据库看到的并发连接总数也会随之增加。',
  '滚动重启会短暂地使进程数量翻倍，因此要按照部署峰值来规划容量。',
  '应该对被拒绝的连接发出告警，而不是只看连接池的平均利用率。',
  '消息总线关心的是把消息送到当下在线的订阅者，它不为你保存历史。',
  '日志把事件按顺序持久化下来，谁什么时候来读都能读到同一份序列。',
];

/**
 * `n` characters of prose that varies, so no redundancy detector fires on it.
 *
 * The counter matters: cycling a fixed pool is still a repeated block once the
 * text is longer than the pool, and REPETITION reads 0.44 by 1,200 characters.
 * Numbering each sentence keeps every n-gram unique.
 */
const varied = (pool: string[], n: number): string => {
  let out = '';
  for (let i = 0; out.length < n; i++) out += `${i + 1}. ${pool[i % pool.length]}`;
  return out.slice(0, n);
};

const SYSTEM =
  'You are a senior backend engineer reviewing infrastructure decisions. Answer concisely ' +
  'and prefer concrete tradeoffs over general advice. Never invent benchmark numbers or ' +
  'cite sources you were not given.';
const USER =
  'We run six worker processes per container, each with a pool of twenty connections, and ' +
  'the database caps at three hundred. Is that safe at four containers?';
const PROMPT = `${SYSTEM}\n\n${USER}`;

const DOCUMENT_CODES = ['SCRIPT_MISMATCH', 'PROMPT_ECHO'];

/**
 * Feed `text` through a guard in chunks, returning every verdict it reported.
 *
 * `firedAt` counts only a **document** detector firing, not any detector. The
 * redundancy detectors have always run mid-stream and are not what this feature
 * changes; conflating them makes a test that passes or fails for reasons it does
 * not name.
 */
function stream(text: string, options: Parameters<typeof createStreamGuard>[0]) {
  const guard = createStreamGuard(options);
  const mid: Verdict[] = [];
  let firedAt: number | null = null;

  for (let i = 0; i < text.length; i += 100) {
    const verdict = guard.push(text.slice(i, i + 100));
    if (!verdict) continue;
    mid.push(verdict);
    const document = verdict.reasons.some((r) => DOCUMENT_CODES.includes(r.code));
    if (document && firedAt === null) firedAt = guard.text.length;
  }
  return { mid, firedAt, final: guard.end(), guard };
}

describe('off by default, so nothing changes for an existing caller', () => {
  it('does not judge the document detectors mid-stream', () => {
    const { mid, final } = stream(varied(ZH_SENTENCES, 1800), {
      ...presets.chat, expectScript: 'latin',
    });

    expect(mid.length, 'checks did run').toBeGreaterThan(0);
    for (const v of mid) expect(v.scores.SCRIPT_MISMATCH).toBeUndefined();
    expect(final.ok, 'and end() still catches it').toBe(false);
    expect(final.reasons.map((r) => r.code)).toContain('SCRIPT_MISMATCH');
  });

  it('stays off even when asked, if no document detector is configured', () => {
    const { mid } = stream(varied(EN_SENTENCES, 1800), { ...presets.chat, earlyDocumentChecks: true });
    for (const v of mid) {
      expect(v.scores.SCRIPT_MISMATCH).toBeUndefined();
      expect(v.scores.PROMPT_ECHO).toBeUndefined();
    }
  });
});

describe('what it catches early', () => {
  it('a response answered entirely in the wrong script', () => {
    const text = varied(ZH_SENTENCES, 1800);
    const off = stream(text, { ...presets.chat, expectScript: 'latin' });
    const on = stream(text, {
      ...presets.chat, expectScript: 'latin', earlyDocumentChecks: true,
    });

    expect(off.firedAt, 'nothing fires mid-stream by default').toBeNull();
    expect(on.firedAt, 'and something does when asked').not.toBeNull();
    // Never before the floor, and well before the end.
    expect(on.firedAt!).toBeGreaterThanOrEqual(600);
    expect(on.firedAt!).toBeLessThan(text.length);
  });

  it('a response that is nothing but the prompt', () => {
    const text = `${PROMPT}\n\n${PROMPT}`;
    const on = stream(text, { ...presets.chat, prompt: PROMPT, earlyDocumentChecks: true });

    expect(on.firedAt).not.toBeNull();
    expect(on.firedAt!).toBeGreaterThanOrEqual(600);
    expect(on.mid.at(-1)!.reasons.map((r) => r.code)).toContain('PROMPT_ECHO');
  });

  it('reports the score and mode alongside the window detectors', () => {
    const { mid } = stream(varied(ZH_SENTENCES, 1800), {
      ...presets.chat, expectScript: 'latin', earlyDocumentChecks: true,
    });
    const failing = mid.find((v) => !v.ok)!;
    expect(failing.scores.SCRIPT_MISMATCH).toBe(1);
    // The window detectors still ran on the same check.
    expect(failing.scores.REPETITION).toBeDefined();
  });
});

/**
 * The measured false positives. Every one of these is a healthy response that
 * reads as totally degenerate over its first few hundred characters, and every
 * one must survive the stream untouched.
 */
describe('what it must not catch', () => {
  const traps: Array<[string, string, Parameters<typeof createStreamGuard>[0]]> = [
    [
      'opens with a long Chinese quote, then answers in English',
      varied(ZH_SENTENCES, 500) + varied(EN_SENTENCES, 1200),
      { ...presets.chat, expectScript: 'latin', earlyDocumentChecks: true },
    ],
    [
      'a long English preamble, then answers in Chinese',
      varied(EN_SENTENCES, 500) + varied(ZH_SENTENCES, 1200),
      { ...presets.chat, expectScript: 'han', earlyDocumentChecks: true },
    ],
    [
      'leaks the whole prompt, then answers at length',
      `${PROMPT}\n\n${varied(EN_SENTENCES, 3000)}`,
      { ...presets.chat, prompt: PROMPT, earlyDocumentChecks: true },
    ],
  ];

  for (const [name, text, options] of traps) {
    it(`${name}: never fires mid-stream`, () => {
      const { mid, firedAt } = stream(text, options);
      const worst = Math.max(
        0,
        ...mid.map((v) =>
          Math.max(v.scores.SCRIPT_MISMATCH ?? 0, v.scores.PROMPT_ECHO ?? 0),
        ),
      );
      expect(firedAt, `fired mid-stream at a prefix score of ${worst.toFixed(3)}`).toBeNull();
    });

    /*
     * Scoped to the document detectors rather than to `final.ok`. Filler prose
     * long enough to exercise a stream is synthetic, and synthetic filler drifts
     * toward repetitive whatever you do to it -- so asserting `ok` would make
     * this test fail for a property of the fixture rather than of the feature.
     * What is being claimed is that these shapes are healthy *on the axis this
     * feature judges*, and that is what is checked.
     */
    it(`${name}: and is not condemned by a document detector at the end either`, () => {
      const { final } = stream(text, options);
      const document = final.reasons.filter((r) => DOCUMENT_CODES.includes(r.code));
      const detail = document.map((r) => `${r.code}=${r.score.toFixed(3)}`).join(', ');
      expect(document, `false positive on a healthy response [${detail}]`).toEqual([]);
    });
  }

  /**
   * The floor exists because of this: at 240 characters, which is the guard's
   * own warmup, two of the traps above score a flat 1.000. Nothing below 600
   * is judged at all.
   */
  it('judges nothing below the 600-character floor', () => {
    const text = varied(ZH_SENTENCES, 1800);
    const guard = createStreamGuard({
      ...presets.chat, expectScript: 'latin', earlyDocumentChecks: true,
      warmup: 240, checkEvery: 100,
    });

    let judgedBelowFloor = false;
    for (let i = 0; i < text.length; i += 50) {
      const verdict = guard.push(text.slice(i, i + 50));
      if (verdict && guard.text.length < 600 && verdict.scores.SCRIPT_MISMATCH !== undefined) {
        judgedBelowFloor = true;
      }
    }
    expect(judgedBelowFloor).toBe(false);
  });

  /**
   * The bar is 0.9 regardless of what the caller configured, because a prefix
   * is only allowed to prove the extreme case. A caller who set a sensitive
   * threshold gets it at `end()`, not on a prefix.
   */
  it('ignores a lowered threshold mid-stream, and honours it at the end', () => {
    const text = varied(EN_SENTENCES, 500) + varied(ZH_SENTENCES, 1200);
    const { firedAt, final } = stream(text, {
      ...presets.chat,
      expectScript: 'han',
      maxScriptMismatch: 0.2, // deliberately sensitive
      earlyDocumentChecks: true,
    });

    expect(firedAt, 'the prefix bar stays at 0.9').toBeNull();
    expect(final.ok, 'but the end check uses the configured 0.2').toBe(false);
  });
});

/**
 * The cost, pinned. The first version of this feature re-scanned the whole
 * buffer on every check, which is the quadratic behaviour `window` exists to
 * prevent: a 32,000-character stream went from 9.06ms to 65.48ms.
 *
 * Three things fixed it, and this asserts the property all three produce rather
 * than a timing, which would be flaky. Both detectors read the *first*
 * `maxSample` characters, so once the buffer passes that the score is frozen
 * and further checks cannot change it.
 */
describe('the second span is bounded', () => {
  it('stops checking once the sample has saturated', () => {
    const long = varied(ZH_SENTENCES, 24_000);
    const guard = createStreamGuard({
      ...presets.chat,
      expectScript: ['han', 'latin'], // healthy, so nothing fires and it runs to the end
      earlyDocumentChecks: true,
    });

    let documentChecks = 0;
    for (let i = 0; i < long.length; i += 100) {
      const verdict = guard.push(long.slice(i, i + 100));
      if (verdict && verdict.scores.SCRIPT_MISMATCH !== undefined) documentChecks += 1;
    }

    // 24,000 characters at the default `checkEvery` of 400 is ~60 window
    // checks. The document detectors must see a handful of those, on a
    // doubling schedule, and then stop.
    expect(guard.checks).toBeGreaterThan(50);
    expect(documentChecks).toBeGreaterThan(0);
    expect(documentChecks, 'doubling schedule, capped at the sample size')
      .toBeLessThan(10);
  });
});