// Prints the "Why am I better?" explanations (verdict + likely reasons) for the positions written by
// tools/probe_explanations.py, to tune the thresholds of web/core/features.js (design slice 3).
//
//   node tools/explain_report.mjs [data/why-positions.json]
import { readFileSync } from 'node:fs';
import { verdict } from '../web/core/explain.js';
import { NO_REASON, reasons } from '../web/core/features.js';

const file = process.argv[2] ?? new URL('../data/why-positions.json', import.meta.url);
const { positions } = JSON.parse(readFileSync(file, 'utf8'));
const tally = {};
let none = 0;
for (const [i, p] of positions.entries()) {
  const v = verdict({ fen: p.fen, evalCp: p.evalCp, passCp: p.passCp, material: p.material, pv: p.pv });
  const rs = reasons({ fen: p.fen, pv: p.pv });
  if (!rs.length) none += 1;
  for (const r of rs) tally[r.id] = (tally[r.id] ?? 0) + 1;
  console.log(`\n#${i + 1} ${p.eco ?? ''} ${p.opening ?? ''}\n${p.fen}\n${v.text}`);
  for (const r of rs) console.log(`  - [${r.id} ${Math.round(r.strength)}${r.step ? ' after' : ''}] ${r.text}`);
  if (!rs.length) console.log(`  - ${NO_REASON}`);
}
console.log(`\n${positions.length} positions, no reason: ${none}; reasons by concept:`, tally);
