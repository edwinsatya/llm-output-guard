import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentLoopDetail } from '../src/detectors/agent-loop.js';

for (const kind of ['bad', 'good']) {
  const dir = join('test/fixtures/agent', kind);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const p = join(dir, f);
    const fx = JSON.parse(readFileSync(p, 'utf8'));
    const d = agentLoopDetail(fx.turns, fx.options ?? {});
    fx.measured = {
      turns: fx.turns.length,
      measured: d.measured,
      cycle: { score: Number(d.score.toFixed(3)), period: d.period, repeats: d.repeats },
    };
    writeFileSync(p, JSON.stringify(fx, null, 2) + '\n');
  }
}
console.log('pinned');
