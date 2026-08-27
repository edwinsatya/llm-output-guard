/**
 * Degeneration across turns, for agent runs.
 *
 * Everything else in this package judges one response. This judges a
 * **sequence** of them, because that is where an agent fails: each response is
 * healthy on its own and the run as a whole is going nowhere. `checkOutput`
 * scores every turn of a six-turn loop at 0.000 and is right to.
 *
 * ## What this does not do
 *
 * It does not check the turns themselves. A turn that loops *inside* itself is
 * `checkOutput`'s job and the adapters already do it, so running both here
 * would report the same failure twice under two codes. Use them together: the
 * adapter guards each response, this guards the run.
 *
 * ## Stateful, still deterministic
 *
 * `checkTrace` is pure -- hand it the turns, get a verdict. `createAgentGuard`
 * is the same function with the turns retained for you, which is what an agent
 * loop actually wants. Neither reads a clock, a network or a random source, and
 * the guard retains only what the window can reach, so a thousand-turn run
 * holds twelve turns.
 */
import type { Reason, ReasonCode, Verdict } from './types.js';
import type { AgentCheckOptions, AgentTurn } from './agent-types.js';
import { agentLoopDetail, AGENT_LOOP_DEFAULTS } from './detectors/agent-loop.js';
import { fingerprintTurn } from './internal/turn-fingerprint.js';
import { DegenerateOutputError } from './check.js';

export type { AgentCheckOptions, AgentToolCall, AgentTurn } from './agent-types.js';
export type { AgentLoopResult } from './detectors/agent-loop.js';
export { agentLoopDetail, agentLoopScore } from './detectors/agent-loop.js';
export { DegenerateOutputError } from './check.js';

/** Default cycle-coverage threshold. See `AgentCheckOptions.maxAgentLoop`. */
const MAX_AGENT_LOOP = 0.4;

/**
 * Whether an agent run has stopped advancing.
 *
 * Returns the same {@link Verdict} shape the rest of the package returns, so it
 * drops into the same handling, the same `onVerdict` sink and the same
 * calibration pipeline. `scores.AGENT_LOOP` is present whenever the detector
 * ran, including when it passed -- log it and you will know your real loop rate.
 *
 * Never throws. A trace that is not an array, or holds entries that are not
 * turns, produces a passing verdict rather than an exception: this sits in an
 * agent loop, and a guard that can crash the loop it guards is worse than the
 * failure it was added to catch.
 */
export function checkTrace(
  turns: readonly AgentTurn[],
  options: AgentCheckOptions = {},
): Verdict {
  const threshold = options.maxAgentLoop === undefined ? MAX_AGENT_LOOP : options.maxAgentLoop;
  const reasons: Reason[] = [];
  const scores: Partial<Record<ReasonCode, number>> = {};

  if (threshold == null) return { ok: true, reasons, scores };

  const detail = agentLoopDetail(turns, options);
  scores.AGENT_LOOP = detail.score;

  if (detail.score > threshold) {
    const block = detail.cycle.join(' -> ');
    reasons.push({
      code: 'AGENT_LOOP',
      score: detail.score,
      threshold,
      message:
        `Agent repeated the same ${detail.period}-turn cycle ${detail.repeats} times ` +
        `(${Math.round(detail.score * 100)}% of the last ${detail.measured} turns): ${block}.`,
    });
  }

  return { ok: reasons.length === 0, reasons, scores };
}

/**
 * Throwing wrapper, for an agent loop that already breaks on a thrown error.
 *
 * Throws the same {@link DegenerateOutputError} the single-response side
 * throws, carrying the trace verdict -- so one `catch` handles both a
 * degenerate response and a degenerate run.
 */
export function assertTrace(
  turns: readonly AgentTurn[],
  options: AgentCheckOptions = {},
): readonly AgentTurn[] {
  const verdict = checkTrace(turns, options);
  if (!verdict.ok) throw new DegenerateOutputError(verdict);
  return turns;
}

export interface AgentGuard {
  /**
   * Record a turn and judge the run so far.
   *
   * Call it once per model response, with whatever that response produced.
   * The returned verdict covers the **run**, not the turn.
   */
  observe(turn: AgentTurn): Verdict;
  /** Forget every turn recorded so far. For reusing a guard across runs. */
  reset(): void;
  /** How many turns are currently retained. Never exceeds `window`. */
  readonly size: number;
}

/**
 * A {@link checkTrace} that remembers the turns for you.
 *
 * ```ts
 * const guard = createAgentGuard();
 * while (!done) {
 *   const response = await model.step();
 *   const verdict = guard.observe(toTurn(response));
 *   if (!verdict.ok) break; // the run is circling; stop paying for it
 * }
 * ```
 *
 * Only turns the detector can compare are retained, and only as many as the
 * window can reach. That bound is deliberate rather than an optimisation:
 * retaining raw turns instead would let a run of empty ones push real turns out
 * of the window, shrinking the sample on exactly the traces that need it most.
 */
export function createAgentGuard(options: AgentCheckOptions = {}): AgentGuard {
  const window = Math.max(1, options.window ?? AGENT_LOOP_DEFAULTS.window);
  const ignore = new Set(options.ignoreTools ?? []);
  let retained: AgentTurn[] = [];

  return {
    observe(turn: AgentTurn): Verdict {
      if (turn != null && typeof turn === 'object' && fingerprintTurn(turn, ignore) !== null) {
        retained.push(turn);
        if (retained.length > window) retained = retained.slice(-window);
      }
      return checkTrace(retained, options);
    },
    reset() {
      retained = [];
    },
    get size() {
      return retained.length;
    },
  };
}
