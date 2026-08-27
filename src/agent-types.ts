/**
 * The shapes `./agent` reads.
 *
 * Structurally typed and provider-neutral, for the same reason the adapters
 * are: a trace is assembled by the caller from whatever their framework hands
 * back, and requiring a provider's own type here would make this subpath
 * depend on a provider.
 */

/** One tool call in a turn. */
export interface AgentToolCall {
  /**
   * The tool's name. OpenAI spells it `function.name`, Anthropic and the AI SDK
   * spell it `name`, and the caller maps whichever they have.
   *
   * Optional because a streamed call can arrive before its name does. A call
   * with no name still fingerprints -- by its arguments -- rather than being
   * dropped, since two nameless calls with identical arguments are still the
   * same call twice.
   */
  name?: string | null;
  /**
   * The arguments, in any shape a provider sends: a parsed object, or the raw
   * JSON string OpenAI uses. Both canonicalise to the same fingerprint, so a
   * trace assembled from mixed sources still compares.
   */
  arguments?: unknown;
}

/** One model response in an agent run. */
export interface AgentTurn {
  /** The prose the model produced, if any. */
  text?: string | null;
  /**
   * The tool calls the model issued, if any.
   *
   * **A turn carrying tool calls is judged by them alone**, and its `text` is
   * read as a preamble and ignored -- the same rule the single-response
   * adapters already apply. See `internal/turn-fingerprint.ts` for the trap
   * that rule exists to avoid.
   */
  toolCalls?: readonly AgentToolCall[] | null;
}

export interface AgentCheckOptions {
  /**
   * How many trailing turns to inspect. Default 12.
   *
   * The same idea as `TAIL_LOOP`'s tail: what matters is whether the agent is
   * stuck *now*, not whether it repeated itself twenty turns ago and recovered.
   * A trace shorter than the window is measured whole.
   *
   * It also bounds the longest cycle that can be found, at `window / minRepeats`
   * turns -- 4 at the defaults. Raise both to catch longer orbits, and expect
   * a loop at the very end of a long trace to score lower, because the score is
   * coverage of the window rather than a count.
   */
  window?: number;
  /**
   * Turns required before this will judge at all. Default 4.
   *
   * Below it the detector abstains, which is the rule everywhere else in this
   * package. Two identical turns is a retry, and three is a short poll; neither
   * is evidence that an agent has stopped advancing.
   */
  minTurns?: number;
  /** How many times a block must repeat to count as a cycle. Default 3. */
  minRepeats?: number;
  /**
   * Longest cycle to look for, in turns. Default 4.
   *
   * Capped by `window / minRepeats` regardless, since a block cannot repeat
   * three times inside a window that does not hold it three times.
   */
  maxPeriod?: number;
  /**
   * Cycle-coverage threshold. Set null to disable. Default 0.4.
   *
   * Measured on this repo's agent corpus: every healthy trace scores **0.000**,
   * including the traps built to look like loops, and the weakest degenerate
   * trace scores 0.455. The default sits in that gap, nearer the healthy side
   * because nothing healthy approaches it.
   */
  maxAgentLoop?: number | null;
  /**
   * Tools whose calls are dropped before fingerprinting. Empty by default.
   *
   * The escape hatch for a tool whose whole job is to be called repeatedly with
   * identical arguments -- polling a job, sleeping, reading a clock. By shape
   * those are indistinguishable from a loop, so naming them is the only honest
   * way to separate them, in the same way `PROMPT_ECHO` cannot be pointed at a
   * translate endpoint.
   *
   * A turn whose calls are *all* ignored drops out of the trace entirely rather
   * than falling back to its preamble text.
   */
  ignoreTools?: readonly string[];
}
