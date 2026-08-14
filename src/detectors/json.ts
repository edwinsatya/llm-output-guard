import type { StandardSchemaV1 } from '../standard-schema.js';

export interface JsonOptions {
  /** Allow the payload to sit inside a ```json fence rather than being bare. */
  allowFence?: boolean;
  /** Top-level keys that must be present for the payload to count as valid. */
  requiredKeys?: string[];
  /**
   * A Standard Schema validator the payload must satisfy -- Zod 4, Valibot,
   * ArkType, or anything else implementing the spec.
   *
   * Strictly stronger than `requiredKeys`, which only asks whether a name is
   * present and says nothing about its type, and the two compose: keys are
   * checked first, so a missing one is still reported as a missing key rather
   * than as whatever the schema calls it.
   *
   * **Must validate synchronously.** See {@link JsonResult.reason}.
   */
  schema?: StandardSchemaV1;
}

export interface JsonResult {
  /** 0 when the payload parses and satisfies every contract, 1 otherwise. */
  score: number;
  /**
   * The payload, when parsing succeeded.
   *
   * When a `schema` validated it, this is the schema's *output* rather than the
   * raw parse -- so Zod defaults, coercions and transforms are applied, and the
   * value is the one your types describe. Without a schema it is `JSON.parse`'s
   * result unchanged.
   */
  value?: unknown;
  reason?: 'unparseable' | 'missing-keys' | 'schema';
  missingKeys?: string[];
  /** Messages from a failing `schema`, path-prefixed where the issue had one. */
  issues?: string[];
}

/** Pull a JSON payload out of a ```json fence, or return the text unchanged. */
export function stripFence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : text.trim();
}

/** `notes.0.body: Expected string` -- the path is what makes an issue actionable. */
function describe(issue: StandardSchemaV1.Issue): string {
  const path = (issue.path ?? [])
    .map((segment) =>
      typeof segment === 'object' && segment !== null && 'key' in segment
        ? String(segment.key)
        : String(segment),
    )
    .join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Structured-output check. Models that "succeed" while emitting prose around
 * the JSON, or an object missing half its keys, fail here.
 */
export function jsonScore(text: string, options: JsonOptions = {}): JsonResult {
  const { allowFence = true, requiredKeys = [], schema } = options;
  const candidate = allowFence ? stripFence(text) : text.trim();

  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return { score: 1, reason: 'unparseable' };
  }

  if (requiredKeys.length > 0) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { score: 1, value, reason: 'missing-keys', missingKeys: [...requiredKeys] };
    }
    const record = value as Record<string, unknown>;
    /*
     * `Object.hasOwn`, not `k in record`. `in` walks the prototype chain, so
     * `requiredKeys: ['constructor']` was satisfied by `Object.prototype` and
     * passed on a payload that did not contain the key at all -- along with
     * `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`,
     * `propertyIsEnumerable` and `toLocaleString`. The contract is "keys the
     * payload must contain", and an inherited name is not one the model wrote.
     */
    const missing = requiredKeys.filter((k) => !Object.hasOwn(record, k));
    if (missing.length > 0) {
      return { score: 1, value, reason: 'missing-keys', missingKeys: missing };
    }
  }

  if (schema) {
    const result = schema['~standard'].validate(value);

    /*
     * A thenable here is the caller's configuration, not the model's output,
     * and it is the one thing in this package that throws on purpose.
     *
     * `checkOutput` promises never to throw *about a response*, because a
     * TypeError raised on bad model output is not a `DegenerateOutputError` and
     * so slips straight through the retry predicate the README recommends. That
     * reasoning does not extend to a schema wired up wrong: no verdict about it
     * would be true, `{ ok: true }` would silently disable the check the caller
     * asked for, and `{ ok: false }` would blame the model for the caller's
     * bug. Throwing surfaces it on the first call, in development, with the fix
     * in the message -- which is where a misconfiguration should surface.
     *
     * In practice this is reached only by a schema carrying an async refinement.
     * Zod, Valibot and ArkType all validate synchronously otherwise.
     */
    if (typeof (result as PromiseLike<unknown>)?.then === 'function') {
      throw new TypeError(
        'llm-output-guard: `schema` must validate synchronously, and this one returned a promise. ' +
          'checkOutput is synchronous by design. Remove the async refinement, or validate ' +
          'the payload yourself after checkOutput returns.',
      );
    }

    const sync = result as StandardSchemaV1.Result<unknown>;
    if (sync.issues) {
      return { score: 1, value, reason: 'schema', issues: sync.issues.map(describe) };
    }
    // The schema's output, not the raw parse: defaults and transforms applied.
    return { score: 0, value: sync.value };
  }

  return { score: 0, value };
}
