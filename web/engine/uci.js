// UCI output parsing for one search (port of what python-chess `analyse(..., multipv=n)` gives engine.py).
// Pure: no engine, no DOM, so it runs in the page, in workers and under vitest alike.

import { scoreToCp } from '../core/fen.js';

/**
 * @typedef {{depth: number, multipv: number, score: {cp: number} | {mate: number}, bound: 'lower'|'upper'|null,
 *            nodes: number | null, pv: string[]}} InfoLine
 * @typedef {[string | null, number]} EvalLine  [move in UCI or null, cp for the side to move]
 */

/**
 * Parse one `info ...` line. Returns null for lines that carry no score (currmove, string, hashfull-only, …).
 * `multipv` defaults to 1 (Stockfish omits it for `info depth 0 score mate 0` in a mated position).
 * @param {string} line
 * @returns {InfoLine | null}
 */
export function parseInfo(line) {
  const tok = line.trim().split(/\s+/);
  if (tok[0] !== 'info' || tok[1] === 'string') return null;
  /** @type {InfoLine} */
  const info = { depth: NaN, multipv: 1, score: null, bound: null, nodes: null, pv: [] };
  for (let i = 1; i < tok.length; i++) {
    switch (tok[i]) {
      case 'depth': info.depth = Number(tok[++i]); break;
      case 'multipv': info.multipv = Number(tok[++i]); break;
      case 'nodes': info.nodes = Number(tok[++i]); break;
      case 'score': {
        const kind = tok[++i];
        const value = Number(tok[++i]);
        if ((kind === 'cp' || kind === 'mate') && Number.isInteger(value)) info.score = { [kind]: value };
        break;
      }
      case 'lowerbound': info.bound = 'lower'; break;
      case 'upperbound': info.bound = 'upper'; break;
      case 'pv': info.pv = tok.slice(i + 1); i = tok.length; break;
      default: break; // seldepth, nps, time, hashfull, tbhits, wdl… are not needed
    }
  }
  if (info.score === null || !Number.isInteger(info.depth) || !Number.isInteger(info.multipv)) return null;
  return info;
}

/**
 * Parse `bestmove <uci> [ponder <uci>]`. `bestmove (none)` (no legal move) gives `{move: null}`.
 * @param {string} line
 * @returns {{move: string | null} | null}  null if the line is not a bestmove line
 */
export function parseBestmove(line) {
  const tok = line.trim().split(/\s+/);
  if (tok[0] !== 'bestmove' || tok.length < 2) return null;
  return { move: tok[1] === '(none)' ? null : tok[1] };
}

/**
 * Collects the output of one `go depth N` and reduces it to engine.py's result shape.
 * Feed every line with `push`; it returns true once `bestmove` has arrived.
 */
export class SearchCollector {
  constructor() {
    /** @type {Map<number, InfoLine>} multipv index -> deepest exact info so far */
    this.best = new Map();
    /** @type {InfoLine | null} a score without pv (terminal position: `info depth 0 score mate 0`) */
    this.scoreOnly = null;
    this.nodes = 0;
    /** @type {{move: string | null} | null} */
    this.bestmove = null;
  }

  /** @param {string} line @returns {boolean} true when the search is finished */
  push(line) {
    const bm = parseBestmove(line);
    if (bm) {
      this.bestmove = bm;
      return true;
    }
    const info = parseInfo(line);
    if (!info) return false;
    if (info.nodes !== null) this.nodes = info.nodes;
    if (info.pv.length === 0) {
      this.scoreOnly = info;
      return false;
    }
    // Bound lines come from aspiration re-searches: their score is not final, skip them.
    if (info.bound) return false;
    const prev = this.best.get(info.multipv);
    // Deepest wins; at equal depth the later line wins (Stockfish repeats the final PV when it stops).
    if (!prev || info.depth >= prev.depth) this.best.set(info.multipv, info);
    return false;
  }

  /**
   * `[[uci|null, cp], ...]` sorted by multipv, cp from the side to move, mate = ±10000.
   * When the engine had no move (`bestmove (none)`), the result is `[[null, cp]]` from the score-only info.
   * An empty array means the engine gave no usable line; callers treat that as an error (engine.py does).
   * @returns {EvalLine[]}
   */
  lines() {
    const out = [...this.best.values()]
      .sort((a, b) => a.multipv - b.multipv)
      .map((info) => /** @type {EvalLine} */ ([info.pv[0], scoreToCp(info.score)]));
    if (out.length === 0 && this.bestmove && this.bestmove.move === null && this.scoreOnly) {
      return [[null, scoreToCp(this.scoreOnly.score)]];
    }
    return out;
  }
}

/**
 * Reduce a complete search transcript (all lines up to and including `bestmove`).
 * @param {Iterable<string>} lines
 * @returns {EvalLine[]}
 */
export function reduceSearch(lines) {
  const c = new SearchCollector();
  for (const line of lines) if (c.push(line)) break;
  return c.lines();
}
