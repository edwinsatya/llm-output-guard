/**
 * What makes two agent turns the same turn.
 *
 * ## This module is INTERNAL. It is not public API, at 1.0 or after.
 *
 * What is public is the behaviour: which traces `AGENT_LOOP` reads as a cycle.
 *
 * ## The rule, and the trap it exists to avoid
 *
 * **A turn that carries tool calls is fingerprinted by the calls alone. Its
 * text is never read.** This follows the rule `tool-calls.ts` already
 * established for a single response -- the presence of tool calls means the
 * text is a preamble rather than the answer -- and here it is what separates
 * the two shapes that matter:
 *
 *     "Let me check the next file."  read_file { path: "src/a.ts" }
 *     "Let me check the next file."  read_file { path: "src/b.ts" }
 *     "Let me check the next file."  read_file { path: "src/c.ts" }
 *
 * Every word of prose is identical and the agent is working perfectly. A
 * fingerprint that included the preamble would call this a total collapse. The
 * arguments are where progress lives, so the arguments are what is measured.
 *
 * A turn with no tool calls has only its prose, so prose is what it gets.
 */
import type { AgentToolCall, AgentTurn } from '../agent-types.js';

/*
 * Field separators. Control characters rather than punctuation, because a tool
 * name or an argument value may legitimately contain any printable character --
 * and a separator that can appear inside a field is one that lets two different
 * turns fingerprint identically. `JSON.stringify` escapes both of these inside
 * any string value it emits, so neither can be forged from the argument side.
 */
const NAME_SEP = '\u0000';
const CALL_SEP = '\u0001';

/**
 * Arguments as a canonical string, so two calls differing only in key order
 * fingerprint identically.
 *
 * Providers do not promise key order and models do not produce it consistently:
 * the same intended call arrives as `{query, limit}` on one turn and
 * `{limit, query}` on the next. A raw `JSON.stringify` reads those as two
 * distinct calls, which is how a six-turn loop scores zero.
 *
 * A JSON **string** is parsed before canonicalising, because OpenAI sends
 * `function.arguments` that way while Anthropic sends an object -- the same
 * split `argumentsToText` handles. An unparseable string is used verbatim
 * rather than discarded: it is still a stable identity for the call, which is
 * all a fingerprint needs.
 */
export function canonicalArguments(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (trimmed === '') return '';
    try {
      return canonicalArguments(JSON.parse(trimmed) as unknown);
    } catch {
      return trimmed;
    }
  }
  try {
    return stringifySorted(args, new WeakSet());
  } catch {
    // A BigInt, or something else JSON cannot carry. Neither is a shape a
    // provider sends, and neither is evidence of a loop.
    return '';
  }
}

/**
 * `JSON.stringify` with object keys sorted at every depth.
 *
 * Array order is preserved -- it is meaningful in a way key order is not.
 * Cycles are cut rather than thrown on, so a caller who hands us a live object
 * graph gets a fingerprint instead of an exception.
 */
function stringifySorted(value: unknown, seen: WeakSet<object>): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stringifySorted(item, seen)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stringifySorted(v, seen)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Prose reduced to what a repeat survives.
 *
 * Case and whitespace drift between otherwise identical restatements -- a
 * trailing newline, a doubled space, a capital that did not come back. None of
 * those is progress, and requiring exact equality through them is how an
 * obvious text loop scores zero.
 */
export function normaliseText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

const callFingerprint = (call: AgentToolCall): string =>
  `${call.name ?? ''}${NAME_SEP}${canonicalArguments(call.arguments)}`;

/**
 * One turn as a single comparable token, or `null` when there is nothing to
 * compare.
 *
 * `null` is the abstain case and it is dropped from the sequence rather than
 * counted: a turn with no text and no calls says nothing about whether the
 * agent is advancing, and a run of them would otherwise read as a perfect
 * cycle. Same reasoning as `checkPreamble` returning `null` on the no-text
 * case.
 *
 * `ignoreTools` drops calls to named tools before fingerprinting. A turn whose
 * calls are all ignored has no fingerprint at all -- it does not fall through
 * to its preamble, which would reintroduce the identical-preamble trap on
 * exactly the traces a caller reached for this option to fix.
 */
export function fingerprintTurn(
  turn: AgentTurn,
  ignoreTools: ReadonlySet<string>,
): string | null {
  const issued = turn.toolCalls ?? [];

  if (issued.length > 0) {
    const kept = issued.filter((call) => !(call.name != null && ignoreTools.has(call.name)));
    if (kept.length === 0) return null;
    /*
     * Sorted, because calls issued together are issued in parallel and their
     * order carries no progress. A model that asks for the same two lookups in
     * the other order next turn has done the same turn twice, and comparing
     * them positionally would score that loop at zero.
     */
    return kept.map(callFingerprint).sort().join(CALL_SEP);
  }

  const text = normaliseText(turn.text ?? '');
  return text === '' ? null : `text${NAME_SEP}${text}`;
}
