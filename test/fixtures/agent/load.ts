import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCheckOptions, AgentTurn } from '../../../src/agent-types.js';
import type { ReasonCode } from '../../../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Properties an agent fixture asserts about itself, recomputed by the corpus
 * test.
 *
 * Same reasoning as the single-response corpus: a `note` is prose and drifts,
 * so anything a fixture claims numerically is checked rather than read.
 */
export interface AgentMeasurements {
  /** Turns in the trace as written. */
  turns?: number;
  /** Turns actually judged, after windowing and dropping unmeasurable ones. */
  measured?: number;
  cycle?: { score: number; period: number; repeats: number };
  /** Only on `uncaught/`: what the rejected redundancy signal scored. */
  rejectedRedundancy?: number;
}

export interface AgentFixture {
  id: string;
  note: string;
  turns: AgentTurn[];
  category?: string;
  /** For bad fixtures: at least one of these codes must fire. */
  expect?: ReasonCode[];
  /** Extra options this fixture needs. */
  options?: AgentCheckOptions;
  measured?: AgentMeasurements;
}

function load(kind: 'bad' | 'good' | 'uncaught'): AgentFixture[] {
  const dir = join(here, kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as AgentFixture);
}

export const badTraces = load('bad');
export const goodTraces = load('good');

/**
 * Traces that are degenerate and are **not** detected, each with the
 * measurement that rejected the signal which would have caught it.
 *
 * They are not in `bad/` because they do not fire, and not in `good/` because
 * they are not healthy. Keeping them as their own kind is what stops a known
 * gap from turning into either a failing test or a forgotten one.
 */
export const uncaughtTraces = load('uncaught');
