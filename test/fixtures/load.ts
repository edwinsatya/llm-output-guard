import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckOptions, ReasonCode, TokenMode } from '../../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Properties a fixture asserts about itself, recomputed by `metadata.test.ts`.
 *
 * A `note` is prose and drifts: twice during this corpus's life a note has
 * described a fixture that no longer existed -- once claiming a non-spaced
 * ratio of 0.45 on text that measured 0.77, once describing a "healthy"
 * preamble that was itself a repeated block. Both were caught by re-reading,
 * which is not a mechanism. Anything stated here is checked.
 */
export interface FixtureMeasurements {
  chars?: number;
  /** How many tokens `words()` produces. 1 is the CJK failure this corpus documents. */
  wordTokens?: number;
  nonSpacedRatio?: number;
  /** Over the final 400 characters -- the span TAIL_LOOP dispatches on. */
  tailNonSpacedRatio?: number;
  tailLoop?: { score: number; mode: TokenMode };
  /** Checked under the fixture's own options merged over `presets.chat`. */
  scores?: Partial<Record<ReasonCode, number>>;
}

export interface Fixture {
  id: string;
  note: string;
  text: string;
  category?: string;
  /** For bad fixtures: at least one of these codes must fire. */
  expect?: ReasonCode[];
  /** Extra options this fixture needs, merged over the preset. */
  options?: CheckOptions;
  /** Self-assertions, verified by the corpus tests. See {@link FixtureMeasurements}. */
  measured?: FixtureMeasurements;
}

function load(kind: 'bad' | 'good'): Fixture[] {
  const dir = join(here, kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture);
}

export const badFixtures = load('bad');
export const goodFixtures = load('good');
