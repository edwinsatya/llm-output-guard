/**
 * A value as an array, or empty when it is anything else.
 *
 * ## This module is INTERNAL. It is not public API, at 1.0 or after.
 *
 * The turn mappers each walk a field the provider documents as a list --
 * `choices`, `content`, `parts`, `toolCalls`. `?? []` covers the field being
 * absent and nothing else, so a field that is *present and not a list* reaches
 * `.filter` and throws a `TypeError`.
 *
 * That is not hypothetical. Anthropic spells a request message's `content`
 * either as a string or as a list of blocks, so handing a mapper a message
 * instead of a response -- an easy mistake, and one nothing else catches --
 * crashed it. A mapper sits between a provider and a guard, which is the worst
 * place in the stack to throw: the caller has the response in hand and is one
 * line away from checking it.
 */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
