import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import * as v from 'valibot';
import { type } from 'arktype';
import { checkOutput, jsonScore, presets } from '../src/index.js';
import type { StandardSchemaV1 } from '../src/standard-schema.js';

/**
 * `schema`, against the three libraries people actually use.
 *
 * Driving all three matters more here than it looks. Standard Schema is a
 * types-only spec, so nothing at build time proves a given library's runtime
 * `~standard.validate` returns what the types claim -- and the three disagree
 * about issue `path` (Valibot and ArkType return segment objects, Zod returns
 * bare keys), which is exactly the sort of difference a single-library test
 * would hide until someone else's schema hit it.
 *
 * None of them is a dependency of this package, at runtime or as a peer. The
 * spec ships no code, so `schema` costs an interface and nothing else -- which
 * is what lets the zero-dependency claim survive this feature.
 */

const GOOD = '{"score":8,"notes":"Solid answer","followUp":["Ask about indexes"]}';
/** Parses, has every required key, and is still wrong: `score` is a string. */
const WRONG_TYPE = '{"score":"very good","notes":"Solid answer","followUp":[]}';

const zodSchema = z.object({
  score: z.number(),
  notes: z.string(),
  followUp: z.array(z.string()),
});

const valibotSchema = v.object({
  score: v.number(),
  notes: v.string(),
  followUp: v.array(v.string()),
});

const arkSchema = type({
  score: 'number',
  notes: 'string',
  followUp: 'string[]',
});

const LIBRARIES: Array<[string, StandardSchemaV1]> = [
  ['zod', zodSchema as unknown as StandardSchemaV1],
  ['valibot', valibotSchema as unknown as StandardSchemaV1],
  ['arktype', arkSchema as unknown as StandardSchemaV1],
];

describe('schema, across Standard Schema implementations', () => {
  it.each(LIBRARIES)('%s: passes a payload that matches', (_name, schema) => {
    const verdict = checkOutput(GOOD, { ...presets.strictJson, schema });
    expect(verdict.ok).toBe(true);
    expect(verdict.json).toEqual({
      score: 8,
      notes: 'Solid answer',
      followUp: ['Ask about indexes'],
    });
  });

  /*
   * The case `requiredKeys` cannot see, and the reason this option exists. Every
   * key is present, so the old contract is satisfied; `score` is a string, so
   * the response is useless to anything downstream that does arithmetic on it.
   */
  it.each(LIBRARIES)('%s: fails a payload whose types are wrong', (_name, schema) => {
    const loose = checkOutput(WRONG_TYPE, {
      ...presets.strictJson,
      requiredKeys: ['score', 'notes', 'followUp'],
    });
    expect(loose.ok, 'requiredKeys alone should not catch this').toBe(true);

    const strict = checkOutput(WRONG_TYPE, { ...presets.strictJson, schema });
    expect(strict.ok).toBe(false);
    expect(strict.reasons.map((r) => r.code)).toContain('INVALID_JSON');
  });

  it.each(LIBRARIES)('%s: names the failing field in the message', (_name, schema) => {
    const verdict = checkOutput(WRONG_TYPE, { ...presets.strictJson, schema });
    const reason = verdict.reasons.find((r) => r.code === 'INVALID_JSON');
    expect(reason?.message).toMatch(/schema/i);
    // The path is what makes the message actionable, and the three libraries
    // spell it differently -- segment objects in two of them, bare keys in Zod.
    expect(reason?.message).toContain('score');
  });

  it.each(LIBRARIES)('%s: reports issues on the detector result', (_name, schema) => {
    const result = jsonScore(WRONG_TYPE, { schema });
    expect(result.score).toBe(1);
    expect(result.reason).toBe('schema');
    expect(result.issues?.length).toBeGreaterThan(0);
    expect(result.issues?.join(' ')).toContain('score');
  });

  it.each(LIBRARIES)('%s: still strips a fence first', (_name, schema) => {
    const verdict = checkOutput('```json\n' + GOOD + '\n```', {
      ...presets.strictJson,
      schema,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe('schema composes with the rest of the check', () => {
  it('reports a missing key as a missing key, not as a schema issue', () => {
    const verdict = checkOutput('{"notes":"x"}', {
      ...presets.strictJson,
      requiredKeys: ['score', 'notes'],
      schema: zodSchema as unknown as StandardSchemaV1,
    });
    // Keys are checked first: the more specific diagnosis wins.
    expect(verdict.reasons[0].message).toContain('missing required keys');
    expect(verdict.reasons[0].message).toContain('score');
  });

  it('never reaches the schema when the payload does not parse', () => {
    let called = false;
    const spy: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => {
          called = true;
          return { value };
        },
      },
    };

    const verdict = checkOutput('Here is your JSON: {oops', { ...presets.strictJson, schema: spy });
    expect(verdict.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('does nothing without expectJson', () => {
    // `schema` is a JSON contract, and `presets.chat` is not asking for JSON.
    const verdict = checkOutput('just prose, no payload here at all', {
      ...presets.chat,
      schema: zodSchema as unknown as StandardSchemaV1,
    });
    expect(verdict.ok).toBe(true);
  });

  /*
   * `Verdict.json` being the schema's *output* rather than the raw parse is the
   * part that makes this worth using over validating afterwards: defaults and
   * transforms are applied, so the value matches the type the caller declared.
   */
  it('returns the schema output, with defaults and transforms applied', () => {
    const withDefault = z.object({
      score: z.number(),
      tags: z.array(z.string()).default([]),
      notes: z.string().transform((s) => s.trim()),
    });

    const verdict = checkOutput('{"score":8,"notes":"  padded  "}', {
      ...presets.strictJson,
      schema: withDefault as unknown as StandardSchemaV1,
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.json).toEqual({ score: 8, tags: [], notes: 'padded' });
  });
});

describe('an async schema is a configuration error, not a verdict', () => {
  const asyncSchema: StandardSchemaV1 = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: async (value) => ({ value }),
    },
  };

  /*
   * The one thing in this package that throws on purpose. A verdict here would
   * either silently disable the check the caller asked for, or blame the model
   * for the caller's wiring -- so it surfaces on the first call instead.
   */
  it('throws a TypeError rather than passing or failing silently', () => {
    expect(() => checkOutput(GOOD, { ...presets.strictJson, schema: asyncSchema })).toThrow(
      TypeError,
    );
  });

  it('says what to do about it', () => {
    expect(() => jsonScore(GOOD, { schema: asyncSchema })).toThrow(/must validate synchronously/);
  });

  /*
   * Zod only goes async when a schema carries an async refinement, so this
   * pins the boundary: the ordinary schemas above are safe, and this is what
   * it takes to trip the throw with a real library rather than a stub.
   */
  it('is reachable with a real library, via an async refinement', () => {
    const refined = z.object({ score: z.number() }).refine(async () => true);
    expect(() =>
      checkOutput('{"score":8}', {
        ...presets.strictJson,
        schema: refined as unknown as StandardSchemaV1,
      }),
    ).toThrow(TypeError);
  });
});

/**
 * `requiredKeys` asks what the payload contains, not what its prototype does.
 *
 * `k in record` walks the prototype chain, so every name on `Object.prototype`
 * was accepted as present on a payload that never mentioned it. `constructor`
 * is the one plausible in a real schema -- a payload describing a builder or a
 * class -- and it passed on `{"score":8}`.
 */
describe('requiredKeys ignores inherited names', () => {
  const INHERITED = [
    'toString', 'valueOf', 'constructor', 'hasOwnProperty',
    'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
  ];

  it.each(INHERITED)('reports %s as missing rather than inherited', (key) => {
    const result = jsonScore('{"score":8}', { requiredKeys: [key] });
    expect(result.score).toBe(1);
    expect(result.reason).toBe('missing-keys');
    expect(result.missingKeys).toEqual([key]);
  });

  it('still accepts an inherited name the payload actually declares', () => {
    expect(jsonScore('{"constructor":"builder"}', { requiredKeys: ['constructor'] }).score).toBe(0);
  });

  it('surfaces through checkOutput as INVALID_JSON', () => {
    const verdict = checkOutput('{"score":8}', {
      ...presets.strictJson,
      requiredKeys: ['score', 'constructor'],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons[0].message).toContain('constructor');
  });
});
