// Moves that are played on purpose: the gambit book and moves the player marked as intended (port of
// opening_trainer/book.py).
//
// A gambit gives up material or eval deliberately, so the engine calls its key move an inaccuracy. The book
// is the final position of every Lichess opening line whose name contains "Gambit" (vendor/chess-openings@*/):
// the position that carries the gambit's name. Only final positions, because a line's earlier moves belong to
// other names ("Damiano Defense, Damiano Gambit" passes 2...f6, which is just the Damiano Defense). A player's
// move that reaches a book position within his first `bookMoves` moves is not judged; the scan goes on.
import { Chess } from '../vendor/chess.js@1.4.0/dist/esm/chess.js';
import { fenKey } from './fen.js';

export const BOOK_ID = 'chess-openings@a6189a3/gambits';
export const BOOK_FILES = ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv'];
export const DEFAULT_BOOK_MOVES = 5;
const BOOK_URL = new URL('../vendor/chess-openings@a6189a3/', import.meta.url);

/** @param {string} name */
export const isGambitLine = (name) => name.toLowerCase().includes('gambit');

/**
 * FEN key after the last move of a TSV `pgn` column ("1. e4 e5 2. f4"); null if a move does not parse.
 * @param {string} pgn @returns {string|null}
 */
export function lineKey(pgn) {
  const board = new Chess();
  let moves = 0;
  for (const token of pgn.split(/\s+/).filter(Boolean)) {
    if (/^\d+\.*$/.test(token)) continue;
    try {
      board.move(token);
    } catch {
      return null;
    }
    moves += 1;
  }
  return moves ? fenKey(board.fen()) : null;
}

/**
 * The gambit book from the TSV files' contents.
 * @param {string[]} texts @returns {Set<string>}
 */
export function parseBook(texts) {
  const keys = new Set();
  for (const text of texts) {
    for (const line of text.split(/\r?\n/).slice(1)) { // header: eco, name, pgn
      const cols = line.split('\t');
      if (cols.length >= 3 && isGambitLine(cols[1])) {
        const key = lineKey(cols[2]);
        if (key !== null) keys.add(key);
      }
    }
  }
  return keys;
}

/** @type {Promise<Set<string>>|null} */
let loading = null;

/**
 * The gambit book, fetched from the vendored files once per page.
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<Set<string>>}
 */
export function loadGambitBook(fetchFn = globalThis.fetch) {
  loading ??= Promise.all(BOOK_FILES.map(async (name) => {
    const res = await fetchFn(new URL(name, BOOK_URL));
    if (!res.ok) throw new Error(`opening book ${name}: HTTP ${res.status}`);
    return res.text();
  })).then(parseBook, (err) => {
    loading = null; // try again next time
    throw err;
  });
  return loading;
}

/**
 * How a move marked as intended is stored: FEN key of the position before it, then the UCI move.
 * @param {string} key @param {string} uci @returns {string}
 */
export const intendedId = (key, uci) => `${key}|${uci}`;

/**
 * @typedef {object} Skip
 * @property {Set<string>} book
 * @property {number} bookMoves
 * @property {Set<string>} intended  intendedId values
 */

/** @type {Skip} */
export const NO_SKIP = Object.freeze({ book: new Set(), bookMoves: DEFAULT_BOOK_MOVES, intended: new Set() });

/**
 * Whether the player's move from the position `key` (before it, at `fullmove`) to `fenAfter` is played on purpose.
 * @param {Skip} skip @param {string} key @param {string} uci @param {number} fullmove @param {string} fenAfter
 * @returns {boolean}
 */
export function skips(skip, key, uci, fullmove, fenAfter) {
  if (skip.intended.has(intendedId(key, uci))) return true;
  return skip.book.size > 0 && fullmove <= skip.bookMoves && skip.book.has(fenKey(fenAfter));
}
