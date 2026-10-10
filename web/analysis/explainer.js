// On-demand engine searches for "Why am I better?" (design-position-explanation.md §5, slice 1).
//
// `evaluation(fen)`: one single-PV search of the quiz position, with its principal variation (the eval line
// under a solved or revealed position). `verdict(fen)`: that plus one search of the position with the
// opponent to move (core/explain.js passFen). Both are remembered for the page view; nothing is stored, so
// the eval cache, positions.json and backups stay as they are. The pool is injected (engine/pool.js
// EnginePool#analyse, which runs terminal positions without the engine).
import { passFen, playerMaterial, verdict } from '../core/explain.js';
import { fenKey } from '../core/fen.js';

/**
 * @typedef {{evalCp: number, pv: string[], material: number}} Evaluation  for the side to move in the FEN
 * @param {{analyse: (fen: string, depth: number, multipv?: number) => Promise<{lines: Array<[string|null, number]>, pvs?: string[][]}>,
 *   depth: number}} p
 */
export function createExplainer({ analyse, depth }) {
  /** @type {Map<string, Promise<any>>} */
  const memo = new Map();
  const once = (id, make) => {
    if (!memo.has(id)) memo.set(id, make().catch((err) => { memo.delete(id); throw err; })); // retry after a failure
    return memo.get(id);
  };

  async function search(fen) {
    const res = await analyse(fen, depth, 1);
    if (!res.lines?.length) throw new Error(`engine returned no move for ${fen}`);
    return { cp: res.lines[0][1], pv: res.pvs?.[0] ?? (res.lines[0][0] ? [res.lines[0][0]] : []) };
  }

  /** @param {string} fen @returns {Promise<Evaluation>} */
  function evaluation(fen) {
    return once(`eval|${fenKey(fen)}`, async () => {
      const { cp, pv } = await search(fen);
      return { evalCp: cp, pv, material: playerMaterial(fen) };
    });
  }

  /** @param {string} fen @returns {Promise<import('../core/explain.js').Verdict & {evaluation: Evaluation, passCp: number|null}>} */
  function verdictOf(fen) {
    return once(`verdict|${fenKey(fen)}`, async () => {
      const pass = passFen(fen);
      const [ev, passed] = await Promise.all([evaluation(fen), pass ? search(pass) : null]);
      const passCp = passed ? -passed.cp : null;
      return { ...verdict({ fen, evalCp: ev.evalCp, passCp, material: ev.material, pv: ev.pv }), evaluation: ev, passCp };
    });
  }

  return { depth, evaluation, verdict: verdictOf };
}
