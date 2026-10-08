// FEN keys, engine score mapping and Python-compatible rounding (port of engine.py helpers).
// Pure: no engine, no DOM, so it runs in the page, in workers and under vitest alike.

/** Centipawn value a forced mate maps to (Python: engine.MATE_CP). */
export const MATE_CP = 10_000;

/**
 * First four FEN fields: placement, side to move, castling, en passant.
 * chess.js 1.4.0 writes the en-passant square only when a legal ep capture exists, exactly like
 * python-chess `board.fen()`, so keys from both libraries match (pinned by spec/fixtures/en-passant-*.json).
 * @param {string} fen
 * @returns {string}
 */
export function fenKey(fen) {
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

/**
 * Centipawns for the side to move; mates map to +/-MATE_CP (Python: engine.score_to_cp).
 * `mate 0` (side to move is mated) counts as a loss, as in python-chess.
 * @param {{cp: number} | {mate: number}} score  as parsed from a UCI `score cp n` / `score mate n`
 * @returns {number}
 */
export function scoreToCp(score) {
  if ('mate' in score) return score.mate > 0 ? MATE_CP : -MATE_CP;
  return score.cp;
}

/**
 * Python's `round(x, 1)`: the exact binary value of `x` rounded to one decimal, ties to even.
 * `toFixed` rounds the exact value too, but sends exact ties away from zero. One-decimal ties are
 * exactly the doubles x = j/4 with j odd (.25 and .75), so those are handled separately.
 * @param {number} x
 * @returns {number}
 */
export function round1(x) {
  if (!Number.isFinite(x)) return x;
  const quarters = x * 4; // exact: scaling by a power of two
  if (Number.isInteger(quarters) && quarters % 2 !== 0) {
    const tenths = x * 10; // exact for j/4: j * 2.5 has at most one fractional bit
    const lo = Math.floor(tenths);
    return (lo % 2 === 0 ? lo : lo + 1) / 10;
  }
  return Number(x.toFixed(1));
}
