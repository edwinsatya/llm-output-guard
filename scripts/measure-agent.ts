/**
 * Reproduces every number in docs/agent-loops.md.
 *
 * Two signals over the same corpus: the cycle detector that shipped, and the
 * turn-redundancy signal that was built and rejected. Printing both is the
 * point -- the rejection is a measurement, and a measurement nobody can rerun
 * is a claim.
 *
 *     npm run measure:agent
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentLoopDetail } from '../src/detectors/agent-loop.js';
import { fingerprintTurn } from '../src/internal/turn-fingerprint.js';
import type { AgentCheckOptions, AgentTurn } from '../src/agent-types.js';

interface Fixture {
  id: string;
  turns: AgentTurn[];
  options?: AgentCheckOptions;
}

const ROOT = 'test/fixtures/agent';

const load = (kind: string): Fixture[] =>
  readdirSync(join(ROOT, kind))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(ROOT, kind, f), 'utf8')) as Fixture);

/**
 * The rejected signal: how much of the window is turns seen before.
 *
 * It is the obvious way to catch an agent that circles without repeating
 * exactly -- and it cannot be separated from a healthy edit/test rhythm. Kept
 * here rather than in `src/` because it does not ship.
 */
function turnRedundancy(turns: AgentTurn[], window = 12): number {
  const fps = turns
    .map((t) => fingerprintTurn(t, new Set()))
    .filter((x): x is string => x !== null)
    .slice(-window);
  if (fps.length < 4) return 0;
  return 1 - new Set(fps).size / fps.length;
}

const rows: Array<{ kind: string; id: string; cycle: number; redundancy: number }> = [];

for (const kind of ['bad', 'good', 'uncaught']) {
  console.log(`\n=== ${kind} ===`);
  for (const fx of load(kind)) {
    const d = agentLoopDetail(fx.turns, fx.options);
    const redundancy = turnRedundancy(fx.turns);
    rows.push({ kind, id: fx.id, cycle: d.score, redundancy });
    console.log(
      `${fx.id.padEnd(34)} turns=${String(fx.turns.length).padStart(2)} ` +
        `measured=${String(d.measured).padStart(2)}  ` +
        `cycle=${d.cycle.length > 0 ? d.score.toFixed(3) : '0.000'} ` +
        `(period ${d.period}, ${d.repeats}x)`.padEnd(20) +
        `redundancy=${redundancy.toFixed(3)}`,
    );
  }
}

const of = (kind: string, key: 'cycle' | 'redundancy') =>
  rows.filter((r) => r.kind === kind).map((r) => r[key]);

const margin = (key: 'cycle' | 'redundancy') =>
  Math.min(...of('bad', key)) - Math.max(...of('good', key));

console.log('\n=== margins ===');
console.log(
  `cycle       weakest degenerate ${Math.min(...of('bad', 'cycle')).toFixed(3)}  ` +
    `strongest healthy ${Math.max(...of('good', 'cycle')).toFixed(3)}  ` +
    `margin ${margin('cycle').toFixed(3)}  -> shipped`,
);

const thrash = rows.find((r) => r.kind === 'uncaught')!;
const alternating = rows.find((r) => r.id === 'alternating-with-progress')!;
console.log(
  `redundancy  ${thrash.id} ${thrash.redundancy.toFixed(3)}  ` +
    `${alternating.id} ${alternating.redundancy.toFixed(3)}  ` +
    `margin ${(thrash.redundancy - alternating.redundancy).toFixed(3)}  -> rejected, under 0.2`,
);
