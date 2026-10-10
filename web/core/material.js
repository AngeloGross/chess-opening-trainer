// Settled material: the material balance once the captures on the board are played out (port of
// opening_trainer/book.py `settled_material`). Pure, chess.js only. spec/golden/settled-material.json
// keeps the two equal.
//
// The search uses chess.js's internal move generator (`_moves`, `_makeMove`, `_undoMove`, `_board`, `_turn`)
// of the vendored 1.4.0: the public `moves({verbose: true})` writes SAN for every move, which makes a
// capture search about 30 times slower. The golden test catches a chess.js update that changes them.
import { Chess } from '../vendor/chess.js@1.4.0/dist/esm/chess.js';

export const QUIESCENCE_PLIES = 8;
export const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Material of the side to move minus the other side's. */
function material(board) {
  const turn = board._turn;
  let sum = 0;
  for (const sq of board._board) if (sq) sum += VALUES[sq.type] * (sq.color === turn ? 1 : -1);
  return sum;
}

/** Capture-only alpha-beta from the side to move, like book.py `_quiescence`. */
function quiescence(board, alpha, beta, plies) {
  const stand = material(board);
  if (plies === 0 || stand >= beta) return stand;
  alpha = Math.max(alpha, stand);
  const captures = board._moves({ legal: true }).filter((m) => m.captured);
  // Most valuable victim first, then least valuable attacker: only the speed depends on the order.
  captures.sort((a, b) => VALUES[b.captured] - VALUES[a.captured] || VALUES[a.piece] - VALUES[b.piece]);
  for (const m of captures) {
    board._makeMove(m);
    const score = -quiescence(board, -beta, -alpha, plies - 1);
    board._undoMove();
    if (score >= beta) return score;
    alpha = Math.max(alpha, score);
  }
  return alpha;
}

/**
 * White's material minus Black's once the captures on the board are played out (pawn = 1, knight and bishop 3,
 * rook 5, queen 9).
 * @param {string} fen @returns {number}
 */
export function settledMaterial(fen) {
  const board = new Chess(fen);
  const score = quiescence(board, -100, 100, QUIESCENCE_PLIES);
  return board.turn() === 'w' ? score : 0 - score; // never -0
}
