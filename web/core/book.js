// The gambit book: moves played on purpose, which the engine would call inaccuracies (opening_trainer/book.py).
//
// The book is generated from the Lichess opening list by tools/make_fixture.py into book/gambits.json: the
// positions after named gambits (the last move of every line whose name contains "Gambit") and after
// sacrifices in any named line, called a gambit or not (Fried Liver 6.Nxf7, Halloween 4.Nxe5, Marshall 8...d5).
// book.py explains the rule. A player's move that reaches a book position within his first `bookMoves` moves
// is not judged; the scan goes on.
import { fenKey } from './fen.js';

export const BOOK_ID = 'chess-openings@a6189a3/gambits-2';
export const DEFAULT_BOOK_MOVES = 10;
const BOOK_URL = new URL('../book/gambits.json', import.meta.url);

/**
 * The book keys of a book/gambits.json document; throws if it is another book version.
 * @param {any} doc @returns {Set<string>}
 */
export function parseBook(doc) {
  if (doc?.book !== BOOK_ID || !Array.isArray(doc.keys)) throw new Error(`opening book: expected ${BOOK_ID}, got ${doc?.book}`);
  return new Set(doc.keys);
}

/** @type {Promise<Set<string>>|null} */
let loading = null;

/**
 * The gambit book, fetched once per page.
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<Set<string>>}
 */
export function loadGambitBook(fetchFn = globalThis.fetch) {
  loading ??= (async () => {
    const res = await fetchFn(BOOK_URL);
    if (!res.ok) throw new Error(`opening book: HTTP ${res.status}`);
    return parseBook(await res.json());
  })().catch((err) => {
    loading = null; // try again next time
    throw err;
  });
  return loading;
}

/**
 * @typedef {object} Skip
 * @property {Set<string>} book
 * @property {number} bookMoves
 */

/** @type {Skip} */
export const NO_SKIP = Object.freeze({ book: new Set(), bookMoves: DEFAULT_BOOK_MOVES });

/**
 * Whether the player's move (made at `fullmove`, leading to `fenAfter`) reaches a book position in time.
 * @param {Skip} skip @param {number} fullmove @param {string} fenAfter
 * @returns {boolean}
 */
export function skips(skip, fullmove, fenAfter) {
  return skip.book.size > 0 && fullmove <= skip.bookMoves && skip.book.has(fenKey(fenAfter));
}
