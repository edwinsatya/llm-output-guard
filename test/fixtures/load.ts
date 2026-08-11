import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckOptions, ReasonCode } from '../../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface Fixture {
  id: string;
  note: string;
  text: string;
  category?: string;
  /** For bad fixtures: at least one of these codes must fire. */
  expect?: ReasonCode[];
  /** Extra options this fixture needs, merged over the preset. */
  options?: CheckOptions;
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
