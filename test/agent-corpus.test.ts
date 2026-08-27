import { describe, it, expect } from 'vitest';
import { checkTrace } from '../src/agent.js';
import { agentLoopDetail } from '../src/detectors/agent-loop.js';
import { fingerprintTurn } from '../src/internal/turn-fingerprint.js';
import { badTraces, goodTraces, uncaughtTraces, type AgentFixture } from './fixtures/agent/load.js';

/**
 * The same contract the single-response corpus holds, one axis up.
 *
 * A missed loop costs tokens. A false positive kills a healthy agent run
 * mid-task, which is the worse outcome -- so the traps here are the shapes that
 * look most like loops and are not: twenty reads of twenty files, an identical
 * preamble on every turn, edit/test/edit/test, pagination, a retry.
 */
describe('agent corpus: circling runs are caught', () => {
  it('has a corpus worth trusting', () => {
    expect(badTraces.length).toBeGreaterThanOrEqual(6);
    expect(new Set(badTraces.map((f) => f.category)).size).toBeGreaterThanOrEqual(2);
  });

  for (const fx of badTraces) {
    it(`flags ${fx.id} (${fx.category})`, () => {
      const verdict = checkTrace(fx.turns, fx.options);
      expect(verdict.ok, `expected a failure. note: ${fx.note}`).toBe(false);
      expect(verdict.reasons.map((r) => r.code)).toContain('AGENT_LOOP');
    });
  }
});

describe('agent corpus: healthy runs pass untouched', () => {
  it('has enough healthy traces to be a real guard', () => {
    expect(goodTraces.length).toBeGreaterThanOrEqual(8);
  });

  for (const fx of goodTraces) {
    it(`passes ${fx.id}`, () => {
      const verdict = checkTrace(fx.turns, fx.options);
      const detail = verdict.reasons
        .map((r) => `${r.code}=${r.score.toFixed(3)}>${r.threshold}`)
        .join(', ');
      expect(verdict.ok, `false positive on a healthy run [${detail}] -- ${fx.note}`).toBe(true);
    });
  }
});

/**
 * A healthy trace must be healthy *by measurement*, not merely by passing.
 *
 * The bound is the one the prose corpus uses: below half the weakest degenerate
 * score. Every healthy trace here measures 0.000, so the bound has a great deal
 * of room -- and it is asserted anyway, because a fixture that drifts upward
 * into the margin is the failure this rule was written for.
 */
describe('agent corpus: healthy traces are healthy by measurement', () => {
  const scoreOf = (fx: AgentFixture) => agentLoopDetail(fx.turns, fx.options).score;

  it('no healthy trace scores into degenerate territory', () => {
    const cap = Math.min(...badTraces.map(scoreOf)) / 2;
    const offenders = goodTraces
      .map((fx) => ({ id: fx.id, score: scoreOf(fx) }))
      .filter((x) => x.score > cap);

    expect(
      offenders,
      `healthy traces scoring above ${cap.toFixed(3)} -- either the trace is not ` +
        'healthy, or it belongs in bad/',
    ).toEqual([]);
  });

  it('the two populations are separated by more than the 0.2 bar', () => {
    const weakestBad = Math.min(...badTraces.map(scoreOf));
    const strongestGood = Math.max(...goodTraces.map(scoreOf));
    expect(weakestBad - strongestGood).toBeGreaterThan(0.2);
  });

  it('the default threshold sits inside that gap', () => {
    const weakestBad = Math.min(...badTraces.map(scoreOf));
    const strongestGood = Math.max(...goodTraces.map(scoreOf));
    // Read off the shipped default rather than restated, so a change to one
    // without the other fails here.
    const threshold = checkTrace(
      badTraces.find((f) => scoreOf(f) === weakestBad)!.turns,
    ).reasons[0]!.threshold;
    expect(threshold).toBeGreaterThanOrEqual(strongestGood);
    expect(threshold).toBeLessThan(weakestBad);
  });
});

/**
 * Every number a fixture states about itself, recomputed.
 *
 * Fixtures carry their scores so a behaviour change shows up as a diff in the
 * corpus rather than as a threshold quietly moving underneath it.
 */
describe('agent corpus: fixtures measure what they claim', () => {
  for (const fx of [...badTraces, ...goodTraces]) {
    it(`${fx.id} still measures what it says`, () => {
      const m = fx.measured;
      if (!m) return;
      const d = agentLoopDetail(fx.turns, fx.options);

      if (m.turns !== undefined) expect(fx.turns.length).toBe(m.turns);
      if (m.measured !== undefined) expect(d.measured).toBe(m.measured);
      if (m.cycle) {
        expect(Number(d.score.toFixed(3))).toBe(m.cycle.score);
        expect(d.period).toBe(m.cycle.period);
        expect(d.repeats).toBe(m.cycle.repeats);
      }
    });
  }
});

/**
 * The gap, pinned.
 *
 * An agent that returns to one failing call between other work is degenerate
 * and is not detected: it has no exact cycle, and the one signal that reads it
 * -- turn redundancy -- cannot be separated from a healthy edit/test rhythm.
 * Both halves of that claim are asserted here, so the day either stops being
 * true is the day this test says so.
 */
describe('agent corpus: the documented gap stays documented', () => {
  const redundancy = (turns: AgentFixture['turns'], window = 12): number => {
    const fps = turns
      .map((t) => fingerprintTurn(t, new Set()))
      .filter((x): x is string => x !== null)
      .slice(-window);
    if (fps.length < 4) return 0;
    return 1 - new Set(fps).size / fps.length;
  };

  for (const fx of uncaughtTraces) {
    it(`${fx.id} is degenerate and still not caught`, () => {
      expect(checkTrace(fx.turns, fx.options).ok).toBe(true);
      expect(agentLoopDetail(fx.turns, fx.options).score).toBe(0);
    });
  }

  it('the rejected redundancy signal really cannot separate the two', () => {
    const thrash = uncaughtTraces.find((f) => f.id === 'thrash-return-to-same')!;
    const healthy = goodTraces.find((f) => f.id === 'alternating-with-progress')!;

    const degenerate = redundancy(thrash.turns);
    const legitimate = redundancy(healthy.turns);

    expect(degenerate).toBeGreaterThan(legitimate);
    expect(
      degenerate - legitimate,
      'if this margin ever clears 0.2, redundancy becomes shippable and ' +
        'docs/agent-loops.md needs rewriting',
    ).toBeLessThan(0.2);
  });
});
