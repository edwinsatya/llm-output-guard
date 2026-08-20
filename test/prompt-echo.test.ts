import { describe, it, expect } from 'vitest';
import { checkOutput } from '../src/index.js';
import { promptEchoScore, promptEchoDetail } from '../src/detectors/index.js';
import { createStreamGuard } from '../src/stream.js';
import { presets } from '../src/presets.js';

/**
 * The failure no other detector in this package can see.
 *
 * A model that returns its own prompt produces output that is non-empty, long
 * enough, not repetitive, terminated properly, valid JSON if that is what the
 * prompt held, in the right script and the right language. Every detector here
 * reads it as healthy, correctly, because by every measure they take it is.
 */

const SYSTEM = `You are a senior backend engineer reviewing infrastructure decisions.
Answer concisely and prefer concrete tradeoffs over general advice. Never invent
benchmark numbers. If the question is ambiguous, state the assumption you are
making and answer under it. Format your reply as prose, not bullet points.`;

const USER = `We are running six worker processes per container and each one opens its own
connection pool of twenty connections. The database is configured with a maximum
of three hundred connections. Is that safe if we scale to four containers, and
what should I watch for as we grow?`;

const PROMPT = `${SYSTEM}\n\n${USER}`;

const ANSWER = `No. Twenty-four pools of twenty connections is four hundred and eighty
against a ceiling of three hundred, so you are oversubscribed before adding replicas.
Size for the deploy peak rather than the steady state, because rolling restarts briefly
double the process count, and alert on rejected connections rather than saturation.`;

describe('promptEchoScore: the shape it exists for', () => {
  it('scores a verbatim echo of the whole prompt at 1', () => {
    expect(promptEchoScore(PROMPT, PROMPT)).toBe(1);
  });

  it('scores an echoed system prompt near 1', () => {
    expect(promptEchoScore(`${SYSTEM}\n\n${SYSTEM}`, PROMPT)).toBeGreaterThan(0.9);
  });

  it('scores a real answer at 0', () => {
    expect(promptEchoScore(ANSWER, PROMPT)).toBe(0);
  });

  /**
   * The measurement that makes the whole thing work. A good answer to a
   * detailed question reuses the question's vocabulary heavily and its
   * *sequences* not at all, which is why runs are matched rather than words.
   */
  it('is not fooled by an answer that shares the question vocabulary', () => {
    const shares = `You asked whether it is safe if we scale to four containers, and the
      answer is no. Twenty-four pools of twenty connections each is four hundred and
      eighty, against a database ceiling of three hundred. The number to track is pools
      times pool size, and during a rolling deploy the process count briefly doubles.`;
    expect(promptEchoScore(shares, PROMPT)).toBeLessThan(0.2);
  });
});

/**
 * The middle of the range, which is where the default threshold is decided.
 * An output that leaks part of the prompt *and* answers is a milder failure
 * than one that only leaks, and the score says so because it is a share.
 */
describe('partial echoes dilute, and that is the design', () => {
  const cases: Array<[string, string]> = [
    ['half the system prompt, then an answer',
      SYSTEM.split('\n').slice(0, 3).join('\n') + '\n\n' + ANSWER],
    ['the question repeated, then an answer', `${USER}\n\n${ANSWER}`],
    ['the whole system prompt, then an answer', `${SYSTEM}\n\n${ANSWER}`],
  ];

  for (const [label, output] of cases) {
    it(`${label}: scores in the middle and passes the default`, () => {
      const score = promptEchoScore(output, PROMPT);
      expect(score, 'clearly above a clean answer').toBeGreaterThan(0.2);
      expect(score, 'and clearly below a true echo').toBeLessThan(0.5);
      expect(checkOutput(output, { ...presets.chat, prompt: PROMPT }).ok).toBe(true);
    });

    it(`${label}: is caught once the threshold is lowered`, () => {
      expect(checkOutput(output, {
        ...presets.chat, prompt: PROMPT, maxPromptEcho: 0.3,
      }).ok).toBe(false);
    });
  }

  it('a longer answer dilutes the same leak further', () => {
    const leak = SYSTEM + '\n\n';
    const short = promptEchoScore(leak + ANSWER, PROMPT);
    const long = promptEchoScore(leak + ANSWER.repeat(4), PROMPT);
    expect(long).toBeLessThan(short);
  });
});

describe('what it refuses to judge', () => {
  it('abstains with no prompt at all', () => {
    expect(promptEchoScore(PROMPT, undefined)).toBe(0);
    expect(promptEchoScore(PROMPT, null)).toBe(0);
    expect(promptEchoScore(PROMPT, '')).toBe(0);
  });

  it('abstains on an output too short to judge', () => {
    expect(promptEchoScore('Yes, that is safe.', PROMPT)).toBe(0);
  });

  /**
   * With fewer tokens than the run length there are no runs to compare. The
   * ratio would be NaN, which sits below every threshold and so disables the
   * detector silently instead of failing loudly.
   */
  it('never returns NaN when a side is shorter than the run length', () => {
    for (const [out, prompt] of [['a b', 'a b'], ['one two three', 'one'], ['', PROMPT]]) {
      const score = promptEchoScore(out, prompt);
      expect(Number.isNaN(score), `${JSON.stringify(out)}`).toBe(false);
      expect(score).toBe(0);
    }
  });

  it('is off unless a prompt is passed', () => {
    const verdict = checkOutput(PROMPT, presets.chat);
    expect(verdict.ok).toBe(true);
    expect(verdict.scores.PROMPT_ECHO).toBeUndefined();
  });

  it('is not enabled by any preset', () => {
    for (const [name, preset] of Object.entries(presets)) {
      expect((preset as { prompt?: unknown }).prompt, name).toBeUndefined();
    }
  });
});

describe('non-spaced scripts', () => {
  const ZH_PROMPT =
    '你是一位资深的后端工程师，正在审查基础设施决策。请简明扼要地回答，优先给出具体的权衡而不是泛泛的建议。' +
    '我们每个容器运行六个工作进程，每个进程各自打开二十个连接的连接池。数据库配置的最大连接数是三百个。';
  const ZH_ANSWER =
    '四个容器每个六个工作进程就是二十四个连接池，每个二十个连接，总共四百八十个，而上限是三百个。' +
    '你在增加任何副本之前就已经超额订阅了。需要关注的不是平均利用率，而是部署期间的峰值。';

  it('catches an echo in char mode', () => {
    const detail = promptEchoDetail(ZH_PROMPT, ZH_PROMPT);
    expect(detail.mode).toBe('char');
    expect(detail.score).toBe(1);
  });

  it('leaves a healthy Chinese answer alone', () => {
    expect(promptEchoScore(ZH_ANSWER, ZH_PROMPT)).toBeLessThan(0.2);
  });

  it('reports the mode in the verdict, as TAIL_LOOP does', () => {
    const verdict = checkOutput(ZH_PROMPT, { ...presets.chat, prompt: ZH_PROMPT });
    expect(verdict.modes?.PROMPT_ECHO).toBe('char');
  });
});

describe('PROMPT_ECHO in a verdict', () => {
  it('fails the check and carries its own score', () => {
    const verdict = checkOutput(PROMPT, { ...presets.chat, prompt: PROMPT });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.map((r) => r.code)).toContain('PROMPT_ECHO');
    expect(verdict.scores.PROMPT_ECHO).toBe(1);
  });

  it('says how much was copied', () => {
    const verdict = checkOutput(PROMPT, { ...presets.chat, prompt: PROMPT });
    const reason = verdict.reasons.find((r) => r.code === 'PROMPT_ECHO')!;
    expect(reason.message).toContain('100%');
  });

  /**
   * The documented false positive, asserted so it cannot be mistaken for a bug
   * later. On a rewrite task a correct answer copies its input, and nothing in
   * the text distinguishes that from a degenerate echo.
   */
  it('flags a correct rewrite, which is why it is opt-in', () => {
    const rewritePrompt = `Fix the grammar in the following text and return it. Do not
      change the meaning. Text: The connection pool are created once per worker process
      and is never shared between them, which mean the retry budget is per-worker not
      global, and that distinction matter a great deal when you are sizing the pool.`;
    const corrected = `Fix the grammar in the following text and return it. Do not
      change the meaning. Text: The connection pool is created once per worker process
      and is never shared between them, which means the retry budget is per-worker not
      global, and that distinction matters a great deal when you are sizing the pool.`;
    expect(promptEchoScore(corrected, rewritePrompt)).toBeGreaterThan(0.5);
  });
});

/**
 * Deferred off the mid-stream path, and the reason is sharper than it is for
 * SCRIPT_MISMATCH: the score is a share of the whole output, so a window
 * measures the share of that window.
 */
describe('streaming defers the echo check to the end', () => {
  it('never reports PROMPT_ECHO mid-stream', () => {
    const guard = createStreamGuard({ ...presets.chat, prompt: PROMPT, warmup: 60 });
    const verdicts = [];
    for (let i = 0; i < PROMPT.length; i += 50) {
      const v = guard.push(PROMPT.slice(i, i + 50));
      if (v) verdicts.push(v);
    }
    expect(verdicts.length).toBeGreaterThan(0);
    for (const v of verdicts) expect(v.scores.PROMPT_ECHO).toBeUndefined();
  });

  it('reports it at end(), where the whole response is in scope', () => {
    const guard = createStreamGuard({ ...presets.chat, prompt: PROMPT, warmup: 60 });
    guard.push(PROMPT);
    const final = guard.end();
    expect(final.ok).toBe(false);
    expect(final.reasons.map((r) => r.code)).toContain('PROMPT_ECHO');
  });

  /*
   * Why the deferral is not merely tidiness: measured over its opening window
   * a leak-then-answer response reads as a total echo, and over its closing
   * window as no echo at all. The finished response is the only span that
   * knows the real ratio.
   */
  it('a window would have reported a number that describes nothing', () => {
    const leakThenAnswer = `${SYSTEM}\n\n${ANSWER}`;
    const opening = promptEchoScore(leakThenAnswer.slice(0, 400), PROMPT);
    const whole = promptEchoScore(leakThenAnswer, PROMPT);
    // The claim is the disagreement, not either number on its own.
    expect(opening).toBeGreaterThan(0.65);
    expect(whole).toBeLessThan(0.5);
    expect(opening - whole, 'the window and the document disagree sharply')
      .toBeGreaterThan(0.2);
  });
});
