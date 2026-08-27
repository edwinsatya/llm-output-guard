import { describe, it, expect } from 'vitest';
import {
  assertTrace,
  checkTrace,
  createAgentGuard,
  agentLoopDetail,
  agentLoopScore,
  DegenerateOutputError,
  type AgentTurn,
} from '../src/agent.js';
import { canonicalArguments, fingerprintTurn } from '../src/internal/turn-fingerprint.js';

const call = (name: string, args: unknown, text?: string): AgentTurn => ({
  ...(text === undefined ? {} : { text }),
  toolCalls: [{ name, arguments: args }],
});
const repeat = (n: number, turn: AgentTurn): AgentTurn[] => Array.from({ length: n }, () => turn);
const fp = (turn: AgentTurn) => fingerprintTurn(turn, new Set());

describe('checkTrace', () => {
  it('reports a passing score, not just a failure', () => {
    const verdict = checkTrace([
      call('a', { x: 1 }), call('b', { x: 2 }), call('c', { x: 3 }), call('d', { x: 4 }),
    ]);
    expect(verdict.ok).toBe(true);
    expect(verdict.scores.AGENT_LOOP).toBe(0);
  });

  it('names the looping tool in the message', () => {
    const verdict = checkTrace(repeat(5, call('read_file', { path: 'a.ts' })));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons[0]!.message).toContain('read_file');
    expect(verdict.reasons[0]!.message).toContain('5 times');
  });

  it('names every tool in a multi-turn cycle, in order', () => {
    const trace = Array.from({ length: 3 }, () => [
      call('edit', { path: 'a.ts' }),
      call('test', {}),
    ]).flat();
    const verdict = checkTrace(trace);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons[0]!.message).toContain('edit -> test');
  });

  it('abstains below the turn floor', () => {
    expect(checkTrace(repeat(3, call('a', { x: 1 }))).ok).toBe(true);
    expect(checkTrace(repeat(4, call('a', { x: 1 }))).ok).toBe(false);
  });

  it('is disabled by a null threshold', () => {
    const verdict = checkTrace(repeat(20, call('a', { x: 1 })), { maxAgentLoop: null });
    expect(verdict.ok).toBe(true);
    expect(verdict.scores.AGENT_LOOP).toBeUndefined();
  });

  it('honours a threshold the caller sets', () => {
    const trace = [...Array.from({ length: 6 }, (_, i) => call('a', { i })), ...repeat(5, call('b', {}))];
    expect(checkTrace(trace).ok).toBe(false);            // 5/11 = 0.455 > 0.4
    expect(checkTrace(trace, { maxAgentLoop: 0.6 }).ok).toBe(true);
  });

  /*
   * This runs inside somebody's agent loop. Throwing here would break the loop
   * it was added to protect, which is a worse failure than the one it catches.
   */
  describe('never throws on input it was not promised', () => {
    const junk: unknown[] = [
      undefined, null, 'not a trace', 42, {}, [null], [undefined], ['a string'], [42],
      [{ toolCalls: null }], [{ toolCalls: [] }], [{ text: null }], [{}],
      [{ toolCalls: [{}] }], [{ toolCalls: [{ name: null, arguments: undefined }] }],
    ];
    for (const [i, input] of junk.entries()) {
      it(`survives junk input #${i}`, () => {
        expect(() => checkTrace(input as AgentTurn[])).not.toThrow();
        expect(checkTrace(input as AgentTurn[]).ok).toBe(true);
      });
    }
  });

  it('drops turns with nothing to compare rather than counting them as a cycle', () => {
    // Four empty turns are not four identical turns; they are no evidence.
    expect(checkTrace(repeat(6, { text: '' })).ok).toBe(true);
    expect(checkTrace(repeat(6, {})).ok).toBe(true);
  });

  it('does not let empty turns push real ones out of the window', () => {
    const trace = [...repeat(5, call('stuck', { x: 1 })), ...repeat(30, {})];
    expect(checkTrace(trace).ok).toBe(false);
  });
});

describe('what counts as the same turn', () => {
  it('ignores argument key order, at every depth', () => {
    expect(fp(call('t', { a: 1, b: { c: 2, d: 3 } })))
      .toBe(fp(call('t', { b: { d: 3, c: 2 }, a: 1 })));
  });

  it('does not ignore array order, which is meaningful', () => {
    expect(fp(call('t', { xs: [1, 2] }))).not.toBe(fp(call('t', { xs: [2, 1] })));
  });

  it('reads a JSON string and a parsed object as the same call', () => {
    expect(fp(call('t', '{"b":2,"a":1}'))).toBe(fp(call('t', { a: 1, b: 2 })));
  });

  it('keeps an unparseable argument string as its own identity', () => {
    expect(canonicalArguments('not json')).toBe('not json');
    expect(fp(call('t', 'not json'))).toBe(fp(call('t', 'not json')));
    expect(fp(call('t', 'not json'))).not.toBe(fp(call('t', 'other')));
  });

  it('separates a different tool with identical arguments', () => {
    expect(fp(call('read', { p: 1 }))).not.toBe(fp(call('write', { p: 1 })));
  });

  it('ignores the preamble on a turn that called a tool', () => {
    expect(fp(call('t', { p: 1 }, 'Checking.'))).toBe(fp(call('t', { p: 1 }, 'Something else.')));
  });

  it('separates turns that differ only in arguments, whatever the preamble says', () => {
    expect(fp(call('t', { p: 1 }, 'Same words.'))).not.toBe(fp(call('t', { p: 2 }, 'Same words.')));
  });

  it('treats parallel calls as unordered', () => {
    const a: AgentTurn = { toolCalls: [{ name: 'r', arguments: { p: 1 } }, { name: 'r', arguments: { p: 2 } }] };
    const b: AgentTurn = { toolCalls: [{ name: 'r', arguments: { p: 2 } }, { name: 'r', arguments: { p: 1 } }] };
    expect(fp(a)).toBe(fp(b));
  });

  it('normalises case and whitespace drift in prose turns', () => {
    expect(fp({ text: 'Let me check.' })).toBe(fp({ text: '  let me  CHECK.\n' }));
  });

  it('does not confuse a prose turn with a tool call carrying the same text', () => {
    expect(fp({ text: 'read_file' })).not.toBe(fp(call('read_file', {})));
  });

  it('survives a circular argument object', () => {
    const args: Record<string, unknown> = { a: 1 };
    args.self = args;
    expect(() => canonicalArguments(args)).not.toThrow();
    expect(canonicalArguments(args)).toContain('circular');
  });

  it('survives arguments JSON cannot carry', () => {
    expect(() => canonicalArguments({ big: 1n })).not.toThrow();
    expect(canonicalArguments({ big: 1n })).toBe('');
  });

  it('ignores an undefined property rather than emitting it', () => {
    expect(canonicalArguments({ a: 1, b: undefined })).toBe(canonicalArguments({ a: 1 }));
  });
});

describe('ignoreTools', () => {
  const polling = repeat(10, call('get_job_status', { id: 'job_1' }, 'Still running.'));

  it('a long poll fires without it', () => {
    expect(checkTrace(polling).ok).toBe(false);
  });

  it('and passes with it', () => {
    expect(checkTrace(polling, { ignoreTools: ['get_job_status'] }).ok).toBe(true);
  });

  it('drops an ignored turn instead of falling back to its preamble', () => {
    // Every preamble is identical; if the turn fell through to text it would loop.
    expect(fp(call('get_job_status', { id: 1 }, 'Still running.'))).not.toBeNull();
    expect(fingerprintTurn(call('get_job_status', { id: 1 }, 'Still running.'),
      new Set(['get_job_status']))).toBeNull();
  });

  it('still sees a loop in the tools it was not told to ignore', () => {
    const trace = [
      call('get_job_status', { id: 1 }), call('stuck', { x: 1 }),
      call('get_job_status', { id: 1 }), call('stuck', { x: 1 }),
      call('get_job_status', { id: 1 }), call('stuck', { x: 1 }),
      call('get_job_status', { id: 1 }), call('stuck', { x: 1 }),
    ];
    expect(checkTrace(trace, { ignoreTools: ['get_job_status'] }).ok).toBe(false);
  });

  it('keeps a turn whose other calls are not ignored', () => {
    const turn: AgentTurn = {
      toolCalls: [{ name: 'get_job_status', arguments: {} }, { name: 'read', arguments: { p: 1 } }],
    };
    expect(fingerprintTurn(turn, new Set(['get_job_status']))).toBe(
      fingerprintTurn(call('read', { p: 1 }), new Set(['get_job_status'])),
    );
  });
});

describe('window and period options', () => {
  it('measures the window, so an old loop that recovered does not fire', () => {
    const trace = [
      ...repeat(6, call('stuck', { x: 1 })),
      ...Array.from({ length: 12 }, (_, i) => call('work', { i })),
    ];
    expect(checkTrace(trace).ok).toBe(true);
  });

  it('finds a longer cycle when the window is widened to hold it', () => {
    const cycle = [call('a', {}), call('b', {}), call('c', {}), call('d', {}), call('e', {})];
    const trace = [...cycle, ...cycle, ...cycle];
    expect(checkTrace(trace).ok).toBe(true);                              // period 5 > default cap
    expect(checkTrace(trace, { window: 15, maxPeriod: 5 }).ok).toBe(false);
  });

  it('reports how much of the window it actually measured', () => {
    const detail = agentLoopDetail(Array.from({ length: 30 }, (_, i) => call('t', { i })));
    expect(detail.measured).toBe(12);
  });

  it('treats a nonsensical window as the smallest usable one', () => {
    expect(() => checkTrace(repeat(5, call('a', {})), { window: 0 })).not.toThrow();
    expect(() => checkTrace(repeat(5, call('a', {})), { window: -3 })).not.toThrow();
  });

  it('agentLoopScore agrees with the detail it summarises', () => {
    const trace = repeat(5, call('a', { x: 1 }));
    expect(agentLoopScore(trace)).toBe(agentLoopDetail(trace).score);
  });
});

describe('assertTrace', () => {
  it('returns the trace when the run is advancing', () => {
    const trace = Array.from({ length: 6 }, (_, i) => call('t', { i }));
    expect(assertTrace(trace)).toBe(trace);
  });

  it('throws the same retryable error the response side throws', () => {
    try {
      assertTrace(repeat(6, call('a', { x: 1 })));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DegenerateOutputError);
      const err = error as DegenerateOutputError;
      expect(err.retryable).toBe(true);
      expect(err.verdict.reasons[0]!.code).toBe('AGENT_LOOP');
    }
  });
});

describe('createAgentGuard', () => {
  it('catches the loop as it happens, not after the fact', () => {
    const guard = createAgentGuard();
    const verdicts = repeat(5, call('a', { x: 1 })).map((t) => guard.observe(t));
    expect(verdicts.slice(0, 3).every((v) => v.ok)).toBe(true);
    expect(verdicts[3]!.ok).toBe(false);
  });

  it('stays bounded across a long run', () => {
    const guard = createAgentGuard();
    for (let i = 0; i < 500; i++) guard.observe(call('t', { i }));
    expect(guard.size).toBe(12);
  });

  it('honours a window it was given', () => {
    const guard = createAgentGuard({ window: 5 });
    for (let i = 0; i < 50; i++) guard.observe(call('t', { i }));
    expect(guard.size).toBe(5);
  });

  it('does not retain turns it cannot compare', () => {
    const guard = createAgentGuard();
    for (let i = 0; i < 10; i++) guard.observe({});
    expect(guard.size).toBe(0);
    expect(guard.observe(call('a', {})).ok).toBe(true);
    expect(guard.size).toBe(1);
  });

  it('forgets on reset', () => {
    const guard = createAgentGuard();
    repeat(6, call('a', { x: 1 })).forEach((t) => guard.observe(t));
    expect(guard.size).toBeGreaterThan(0);
    guard.reset();
    expect(guard.size).toBe(0);
    expect(guard.observe(call('a', { x: 1 })).ok).toBe(true);
  });

  it('agrees with checkTrace over the same turns', () => {
    const trace = [
      ...Array.from({ length: 4 }, (_, i) => call('work', { i })),
      ...repeat(6, call('stuck', { x: 1 })),
    ];
    const guard = createAgentGuard();
    let last;
    for (const turn of trace) last = guard.observe(turn);
    expect(last!.scores.AGENT_LOOP).toBe(checkTrace(trace).scores.AGENT_LOOP);
  });

  it('survives junk handed to observe', () => {
    const guard = createAgentGuard();
    expect(() => guard.observe(undefined as unknown as AgentTurn)).not.toThrow();
    expect(() => guard.observe('nope' as unknown as AgentTurn)).not.toThrow();
    expect(guard.size).toBe(0);
  });
});

/**
 * The sensitivity table in docs/agent-loops.md, asserted.
 *
 * Prose drifts; this repo has been bitten by a note describing a fixture that
 * no longer existed. A table of thresholds is exactly the kind of claim that
 * goes stale silently, so it is measured here instead of trusted.
 *
 * Each case is preceded by enough distinct work to fill the window, which is
 * the worst case for the score -- a short trace is measured whole and fires
 * sooner.
 */
describe('docs/agent-loops.md: the sensitivity table holds', () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => call('work', { i }));
  const cycleOf = (period: number) =>
    Array.from({ length: period }, (_, i) => call(`t${i}`, { i }));

  const trailing = (turns: AgentTurn[]) => checkTrace([...filler(20), ...turns]);

  it('one call repeated fires at 5 turns, not 4', () => {
    expect(trailing(repeat(4, call('stuck', {}))).ok).toBe(true);
    expect(trailing(repeat(5, call('stuck', {}))).ok).toBe(false);
  });

  it('a 2-turn cycle fires at 3 repeats', () => {
    const c = cycleOf(2);
    expect(trailing([...c, ...c]).ok).toBe(true);
    expect(trailing([...c, ...c, ...c]).ok).toBe(false);
  });

  it('a 3-turn cycle fires at 3 repeats', () => {
    const c = cycleOf(3);
    expect(trailing([...c, ...c]).ok).toBe(true);
    expect(trailing([...c, ...c, ...c]).ok).toBe(false);
  });

  it('a 4-turn cycle fires at 3 repeats, filling the window exactly', () => {
    const c = cycleOf(4);
    expect(trailing([...c, ...c]).ok).toBe(true);
    const verdict = trailing([...c, ...c, ...c]);
    expect(verdict.ok).toBe(false);
    expect(verdict.scores.AGENT_LOOP).toBe(1);
  });

  it('a 5-turn cycle is past the default cap and is not searched', () => {
    const c = cycleOf(5);
    expect(trailing([...c, ...c, ...c]).ok).toBe(true);
  });

  it('a trace under 4 turns never fires, however identical', () => {
    for (let n = 0; n < 4; n++) {
      expect(checkTrace(repeat(n, call('stuck', {}))).ok, `${n} turns`).toBe(true);
    }
  });

  it('a short trace is measured whole, so it fires sooner than the table floor', () => {
    // Five identical turns and nothing else: coverage 5/5, not 5/12.
    expect(checkTrace(repeat(5, call('stuck', {}))).scores.AGENT_LOOP).toBe(1);
  });

  it('the documented default threshold is the shipped one', () => {
    const verdict = checkTrace(repeat(5, call('stuck', {})));
    expect(verdict.reasons[0]!.threshold).toBe(0.4);
  });
});
