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
 * White's material minus Black's as it stands on the board.
 * @param {string} fen @returns {number}
 */
export function boardMaterial(fen) {
  const board = new Chess(fen);
  const m = material(board);
  return board.turn() === 'w' ? m : 0 - m;
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

/** "e4" for a chess.js internal 0x88 square index. */
const squareName = (i) => 'abcdefgh'[i & 15] + (8 - (i >> 4));

/**
 * The capture that wins the most for the side to move once the replies are played out (the first move of the
 * settled-material search), or null when no capture wins material.
 * @param {string} fen
 * @returns {{from: string, to: string, piece: string, captured: string, gain: number}|null}  gain in pawns
 */
export function bestCapture(fen) {
  const board = new Chess(fen);
  const stand = material(board);
  let best = null;
  for (const m of board._moves({ legal: true }).filter((x) => x.captured)) {
    board._makeMove(m);
    const gain = -quiescence(board, -100, 100, QUIESCENCE_PLIES - 1) - stand;
    board._undoMove();
    if (gain > 0 && (!best || gain > best.gain)) {
      best = { from: squareName(m.from), to: squareName(m.to), piece: m.piece, captured: m.captured, gain };
    }
  }
  return best;
}
