/**
 * The failure that every other detector in this package scores 0.000 on.
 *
 * An agent calls `read_file` on the same path six turns running, or edits one
 * file and runs one test set back and forth until the budget is gone. Each
 * individual response is fluent, correctly formed, the right length and calls a
 * tool that exists with arguments that match its schema. `checkOutput` is right
 * to pass every one of them: nothing is wrong with any *response*. What is
 * wrong is the sequence.
 *
 * So this reads one axis nothing else here reads -- across turns -- and it
 * reads it the same way `TAIL_LOOP` reads a response: by looking for exact
 * periodicity in a trailing window. The tokens are turn fingerprints instead of
 * words, and `internal/periodicity.ts` is literally the same search.
 *
 * ## Exact periodicity, and what it costs
 *
 * The block must repeat *exactly*. That is what makes the detector safe on the
 * shapes that dominate healthy agent traffic -- twenty reads of twenty
 * different files, an edit/test rhythm that edits a different file each time, a
 * preamble the model reuses word for word. None of those produce an exact
 * repeat of the whole block, and all of them would fool a similarity measure.
 *
 * It also means a genuinely stuck agent that varies is **not caught**. An agent
 * returning to one failing call between other work -- build, read, build, list,
 * build -- has no exact cycle, and the shape it does have is
 * indistinguishable from a healthy edit/test rhythm. That gap is measured
 * rather than assumed; see `docs/agent-loops.md`.
 */
import type { AgentCheckOptions, AgentTurn } from '../agent-types.js';
import { periodicDetail } from '../internal/periodicity.js';
import { fingerprintTurn } from '../internal/turn-fingerprint.js';

export interface AgentLoopResult {
  /** Share of the inspected window covered by the repeating block, 0..1. */
  score: number;
  /** Turns in the repeating block. 0 when nothing repeated. */
  period: number;
  /** How many times it repeated. 0 when nothing repeated. */
  repeats: number;
  /**
   * How many turns were actually measured -- the window, after turns with
   * nothing to compare were dropped. `score` is a share of this.
   */
  measured: number;
  /**
   * The repeating block, one readable label per turn: the tool names a turn
   * called, or `prose` for a turn that called none. Empty when nothing
   * repeated.
   *
   * For messages and logs only. It names what is looping, which is the first
   * thing anyone debugging a stuck agent wants and the one thing a score
   * cannot say.
   */
  cycle: readonly string[];
}

export const AGENT_LOOP_DEFAULTS: Required<
  Pick<AgentCheckOptions, 'window' | 'minTurns' | 'minRepeats' | 'maxPeriod'>
> = {
  window: 12,
  minTurns: 4,
  minRepeats: 3,
  maxPeriod: 4,
};

/**
 * Whether a trace ends in a cycle, and which one.
 *
 * Pure and synchronous like everything else here: the same turns always produce
 * the same result, and nothing is retained between calls.
 */
export function agentLoopDetail(
  turns: readonly AgentTurn[],
  options: AgentCheckOptions = {},
): AgentLoopResult {
  const { window, minTurns, minRepeats, maxPeriod } = { ...AGENT_LOOP_DEFAULTS, ...options };
  const ignore = new Set(options.ignoreTools ?? []);

  const none: AgentLoopResult = { score: 0, period: 0, repeats: 0, measured: 0, cycle: [] };
  if (!Array.isArray(turns)) return none;

  /*
   * Fingerprint first, then window. Doing it the other way round would let a
   * run of unmeasurable turns -- empty ones, or ones whose only calls are
   * ignored -- push real turns out of the window and shrink the sample on
   * exactly the traces that need it most.
   */
  const fingerprints: string[] = [];
  const labels: string[] = [];
  for (const turn of turns) {
    if (turn == null || typeof turn !== 'object') continue;
    const fp = fingerprintTurn(turn, ignore);
    if (fp === null) continue;
    fingerprints.push(fp);
    labels.push(labelTurn(turn, ignore));
  }

  const size = Math.max(1, window);
  const tail = fingerprints.slice(-size);
  if (tail.length < minTurns) return { ...none, measured: tail.length };

  const detail = periodicDetail(tail, { maxPeriod, minRepeats, minSample: minTurns });
  const cycle = detail.period > 0 ? labels.slice(-detail.period) : [];
  return { ...detail, measured: tail.length, cycle };
}

/** What to call this turn in a message. Never used for comparison. */
function labelTurn(turn: AgentTurn, ignore: ReadonlySet<string>): string {
  const kept = (turn.toolCalls ?? []).filter(
    (call) => !(call.name != null && ignore.has(call.name)),
  );
  if (kept.length === 0) return 'prose';
  return kept.map((call) => call.name ?? '(unnamed)').join('+');
}

/** {@link agentLoopDetail} without the block, for callers that only want the score. */
export function agentLoopScore(
  turns: readonly AgentTurn[],
  options: AgentCheckOptions = {},
): number {
  return agentLoopDetail(turns, options).score;
}
