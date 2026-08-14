/**
 * Which spans of a response the redundancy detectors should read.
 *
 * ## The problem this exists for
 *
 * `REPETITION` and `TAIL_LOOP` measure a whole response at once, which is right
 * for prose and wrong for a JSON array. A model asked for the status of twenty
 * services and returning twenty identical rows has done exactly what it was
 * told; measured across the document that is a perfect loop, and 1.2.1 scores it
 * `TAIL_LOOP: 1.000` and fails it under every preset -- including `lenient`, and
 * including `strictJson`, which is the preset most likely to be pointed at that
 * payload. Three identical records is enough to trip it.
 *
 * The scores were not wrong. Twenty identical records *are* exactly periodic.
 * The detectors were being asked about the wrong span.
 *
 * ## The rule
 *
 * In a payload that parses as JSON, repetition **across records** is the shape
 * that was requested, and repetition **inside a value** is the signal. So under
 * `'jsonValues'` the redundancy detectors read each string value on its own
 * rather than the serialised document.
 *
 * This is strictly more sensitive, not less. A loop inside one element of an
 * array is diluted to nothing when averaged across the document -- 1.2.1 misses
 * `[{"q":"<30x repeated Chinese clause>"}, ...four healthy items]` entirely --
 * and reads 1.000 when that element is measured on its own.
 *
 * ## Why it falls back rather than failing closed
 *
 * A response that does not parse gets measured as a document, unchanged. That
 * covers prose, a truncated payload, and every mid-stream check (partial JSON
 * never parses). Returning "no spans" for unparseable text would silently
 * disable the redundancy detectors on exactly the responses most likely to be
 * degenerate.
 *
 * ## This module is INTERNAL. It is not public API, at 1.0 or after.
 *
 * What is public is the `redundancyScope` option and the behaviour it selects.
 */
import { stripFence } from '../detectors/json.js';

/** Collects every string leaf, in document order. */
function stringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringValues(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) stringValues(item, out);
  }
  return out;
}

/**
 * The spans to measure for redundancy.
 *
 * Always at least one span, so a caller can reduce over the result without
 * special-casing empty. Under `'document'`, or when the text does not parse,
 * that span is the text itself.
 */
export function redundancySpans(text: string, scope: 'document' | 'jsonValues'): string[] {
  if (scope !== 'jsonValues') return [text];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch {
    return [text];
  }

  const values = stringValues(parsed);
  /*
   * A payload of pure numbers and booleans has no prose to judge. Measuring the
   * serialised form instead would reintroduce the false positive this option
   * exists to remove -- `[{"a":1},{"a":1}]` is periodic and fine -- so an empty
   * result is reported as one empty span, which every detector scores 0.
   */
  return values.length > 0 ? values : [''];
}
