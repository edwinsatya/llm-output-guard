import { describe, it, expect } from 'vitest';
import { checkOutput, createStreamGuard } from '../src/index.js';
import { tailLoopDetail, tailLoopScore, repetitionScore } from '../src/detectors/index.js';
import { nonSpacedRatio, tokenModeOf, words } from '../src/internal/tokenize.js';
import { presets } from '../src/presets.js';
import { calibrate } from '../src/calibrate.js';
import { extractScores } from '../src/cli.js';
import { badFixtures } from './fixtures/load.js';

const rep = (s: string, n: number) => Array(n).fill(s).join('');

const ZH_LOOP = rep('我需要更多的信息才能回答这个问题', 40);
const JA_LOOP = rep('この質問に答えるにはもっと情報が必要です', 40);
const ZH_HEALTHY =
  '分布式系统里最常见的误解，是把消息总线当成日志来用。总线关心的是把一条消息送到当下在线的' +
  '订阅者，它不为你保存历史；日志关心的是把事件按顺序持久化下来，谁什么时候来读都能读到同一份' +
  '序列。这两件事的运维成本差别很大。用总线时你要接受至多一次投递，客户端断线重连之后必须重新' +
  '拉取状态，而不是指望把错过的消息补上。';
const EN_HEALTHY =
  'Redis pub/sub is the right primitive here. Each server subscribes to the room channel ' +
  'and publishes moves to it, so fan-out no longer depends on which instance a given ' +
  'socket lands on. The tradeoff is at-most-once delivery, so a client reconnecting ' +
  'mid-game refetches state rather than replaying it.';
/**
 * Healthy English, then a Chinese loop: under the cutoff overall, at ceiling
 * across the tail. Taken from the reviewed corpus rather than rebuilt here --
 * the proportions are the point of the fixture, and an approximation of them
 * assembled in a test file is how the first version of this measurement went
 * wrong (a repeated "healthy" preamble is itself a loop).
 */
const DILUTED = badFixtures.find((f) => f.id === 'cjk-tail-loop-diluted')!.text;

describe('nonSpacedRatio', () => {
  it('is 0 for Latin and 1 for Han', () => {
    expect(nonSpacedRatio(EN_HEALTHY)).toBe(0);
    expect(nonSpacedRatio(ZH_HEALTHY)).toBe(1);
  });

  /*
   * The bug this guards: \p{Script=Thai} matches Thai vowel and tone marks,
   * which are \p{M}. A denominator of \p{L} alone counted a different set and
   * returned 1.28 here, which makes any cutoff meaningless for Thai.
   */
  it('never exceeds 1, including for scripts with combining marks', () => {
    for (const sample of ['ต้องการ', 'ฉันต้องการข้อมูลเพิ่มเติม', ZH_HEALTHY, JA_LOOP]) {
      expect(nonSpacedRatio(sample)).toBeLessThanOrEqual(1);
    }
    expect(nonSpacedRatio('ต้องการ')).toBe(1);
  });

  it('keys on spacing rather than on script, so Korean stays in word mode', () => {
    const ko = '이 경우에는 발행 구독이 적절한 기본 요소입니다. 각 서버가 방 채널을 구독합니다.';
    expect(nonSpacedRatio(ko)).toBe(0);
    expect(tokenModeOf(ko)).toBe('word');
  });
});

describe('the gap this exists for', () => {
  it('word tokenization sees a whole CJK loop as a single token', () => {
    expect(words(ZH_LOOP)).toHaveLength(1);
    expect(repetitionScore(ZH_LOOP)).toBe(0);
    expect(tailLoopScore(ZH_LOOP, { mode: 'word' })).toBe(0);
  });

  it('character mode scores the same loop at ceiling', () => {
    const { score, mode } = tailLoopDetail(ZH_LOOP);
    expect(mode).toBe('char');
    expect(score).toBeGreaterThan(0.9);
  });
});

describe('dispatch is per detector span, not per response', () => {
  /*
   * The decisive case. Judging the tail by the whole response's ratio puts the
   * tail detector in word mode over text that yields one token, and scores an
   * obvious loop at 0.000.
   */
  it('reads the tail, so a response that answers in English and loops in Chinese is caught', () => {
    expect(nonSpacedRatio(DILUTED)).toBeLessThan(0.5); // whole response says 'word'
    const { score, mode } = tailLoopDetail(DILUTED);
    expect(mode).toBe('char');
    expect(score).toBeGreaterThan(0.9);
    expect(checkOutput(DILUTED, presets.chat).ok).toBe(false);
  });

  it('leaves a healthy mixed-script response in whichever mode it lands, passing either way', () => {
    const mixed =
      '这个问题的关键在于 `useEffect` 的依赖数组。你写成了 `[props.userId]`，但是回调里还引用了 ' +
      '`props.onLoad`，所以 lint 规则 react-hooks/exhaustive-deps 会报警。正确的做法是把 ' +
      '`onLoad` 也放进依赖数组，同时在父组件里用 `useCallback` 把它包起来。';
    expect(checkOutput(mixed, presets.chat).ok).toBe(true);
  });
});

describe('the two modes carry separate thresholds', () => {
  it('reports which tokenizer produced the score', () => {
    expect(checkOutput(ZH_HEALTHY, presets.chat).modes?.TAIL_LOOP).toBe('char');
    expect(checkOutput(EN_HEALTHY, presets.chat).modes?.TAIL_LOOP).toBe('word');
  });

  it('puts the mode on the failing reason too', () => {
    const verdict = checkOutput(ZH_LOOP, presets.chat);
    const reason = verdict.reasons.find((r) => r.code === 'TAIL_LOOP');
    expect(reason?.mode).toBe('char');
  });

  it('applies maxCharTailLoop in char mode and maxTailLoop in word mode', () => {
    /*
     * Isolated to the tail detector: this loop also collapses LOW_ENTROPY, and
     * a verdict that stays false for a different reason would prove nothing
     * about which threshold governs char mode.
     */
    const only = { maxRepetition: null, maxCompressibility: null, minLength: 0 } as const;
    // Nulling the char threshold disables the detector for this text; nulling
    // the word one leaves it firing. Impossible if a single option governed both.
    expect(checkOutput(ZH_LOOP, { ...presets.chat, ...only, maxCharTailLoop: null }).ok).toBe(true);
    expect(checkOutput(ZH_LOOP, { ...presets.chat, ...only, maxTailLoop: null }).ok).toBe(false);
    // And the mirror image on Latin, so the mapping is not accidentally reversed.
    const enLoop = rep('the same clause again. ', 40);
    expect(checkOutput(enLoop, { ...presets.chat, ...only, maxTailLoop: null }).ok).toBe(true);
    expect(checkOutput(enLoop, { ...presets.chat, ...only, maxCharTailLoop: null }).ok).toBe(false);
  });

  it('abstains on samples too short for character mode to judge', () => {
    // Three short identical sentences: high coverage, far too little evidence.
    const short = '这个结论我反复确认过。真的没问题了。真的没问题了。真的没问题了。';
    expect(tailLoopDetail(short).score).toBe(0);
  });
});

describe('mid-stream detection, which is what the deferral rests on', () => {
  /*
   * LOW_ENTROPY is deferred to end(), on the premise that the redundancy
   * detectors reach a verdict earlier. For CJK that premise is character-mode
   * TAIL_LOOP firing at the warmup -- if this test fails, the deferral in
   * stream.ts is no longer safe.
   */
  for (const [name, text] of Object.entries({ ZH_LOOP, JA_LOOP })) {
    it(`catches ${name} on the first mid-stream check`, () => {
      const guard = createStreamGuard(presets.chat);
      let caught: number | null = null;
      for (let i = 0; i < text.length; i += 16) {
        const verdict = guard.push(text.slice(i, i + 16));
        if (verdict && !verdict.ok) {
          caught = guard.text.length;
          break;
        }
      }
      expect(caught).not.toBeNull();
      expect(caught!).toBeLessThanOrEqual(260);
    });
  }

  it('does not fire mid-stream on healthy CJK', () => {
    const guard = createStreamGuard(presets.chat);
    const long = ZH_HEALTHY.repeat(3);
    for (let i = 0; i < long.length; i += 16) {
      const verdict = guard.push(long.slice(i, i + 16));
      expect(verdict?.ok ?? true).toBe(true);
    }
  });
});

describe('calibrate segments by detector-mode pair', () => {
  it('keeps the two distributions apart', () => {
    const samples = [
      ...Array(30).fill({ TAIL_LOOP: 0.05, modes: { TAIL_LOOP: 'word' as const } }),
      ...Array(30).fill({ TAIL_LOOP: 0.55, modes: { TAIL_LOOP: 'char' as const } }),
    ];
    const result = calibrate(samples);
    const byMode = Object.fromEntries(result.summaries.map((s) => [s.mode, s.distribution.max]));
    expect(result.summaries).toHaveLength(2);
    expect(byMode.word).toBeCloseTo(0.05);
    expect(byMode.char).toBeCloseTo(0.55);
  });

  it('still summarises logs that carry no modes', () => {
    const result = calibrate(Array(30).fill({ TAIL_LOOP: 0.1 }));
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0].mode).toBeUndefined();
  });

  it('reads modes off a whole logged verdict, where they sit beside scores', () => {
    const sample = extractScores({
      msg: 'reply',
      verdict: { ok: true, scores: { TAIL_LOOP: 0.2 }, modes: { TAIL_LOOP: 'char' } },
    });
    expect(sample?.TAIL_LOOP).toBe(0.2);
    expect(sample?.modes?.TAIL_LOOP).toBe('char');
  });
});
