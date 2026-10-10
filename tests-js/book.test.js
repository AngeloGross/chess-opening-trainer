// The gambit book: the JS build must give exactly the set python-chess builds (spec/golden/gambit-book.json).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Chess } from '../web/vendor/chess.js@1.4.0/dist/esm/chess.js';
import { BOOK_FILES, BOOK_ID, NO_SKIP, intendedId, lineKey, loadGambitBook, parseBook, skips } from '../web/core/book.js';
import { fenKey } from '../web/core/fen.js';

const VENDOR = new URL('../web/vendor/chess-openings@a6189a3/', import.meta.url);
const golden = JSON.parse(readFileSync(new URL('../spec/golden/gambit-book.json', import.meta.url), 'utf8'));
const book = parseBook(BOOK_FILES.map((f) => readFileSync(new URL(f, VENDOR), 'utf8')));

function keyAfter(moves) {
  const board = new Chess();
  for (const san of moves.split(' ').filter(Boolean)) board.move(san);
  return fenKey(board.fen());
}

describe('gambit book', () => {
  it('matches the Python build', () => {
    const keys = [...book].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(BOOK_ID).toBe(golden.book);
    expect(keys.length).toBe(golden.size);
    expect(createHash('sha256').update(keys.join('\n')).digest('hex')).toBe(golden.sha256);
  });

  it('has the gambit positions but not the prefixes named otherwise', () => {
    for (const m of ['d4 e5', 'e4 e5 f4', 'e4 e5 Nf3 Nf6 Nxe5 Nc6', 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4', 'd4 Nf6 c4 e5']) {
      expect(book.has(keyAfter(m)), m).toBe(true);
    }
    for (const m of ['e4 e5 Nf3 f6', 'e4 e5 Qh5', 'e4', 'e4 e5']) expect(book.has(keyAfter(m)), m).toBe(false);
  });

  it('parses only gambit lines and skips bad ones', () => {
    const tsv = 'eco\tname\tpgn\nA40\tEnglund Gambit\t1. d4 e5\r\nC40\tDamiano Defense\t1. e4 e5 2. Nf3 f6\nX\tbad gambit\t1. e9\n';
    expect([...parseBook([tsv])]).toEqual([keyAfter('d4 e5')]);
    expect(lineKey('')).toBe(null);
  });

  it('loads through fetch once and retries after a failure', async () => {
    let calls = 0;
    const failing = async () => { calls += 1; return { ok: false, status: 404 }; };
    await expect(loadGambitBook(failing)).rejects.toThrow(/HTTP 404/);
    const ok = async (url) => { calls += 1; return { ok: true, text: async () => readFileSync(url, 'utf8') }; };
    const loaded = await loadGambitBook(ok);
    expect(loaded.size).toBe(golden.size);
    const before = calls;
    expect(await loadGambitBook(ok)).toBe(loaded);
    expect(calls).toBe(before);
  });
});

describe('skips', () => {
  const key = keyAfter('d4');
  const after = (() => { const b = new Chess(); b.move('d4'); b.move('e5'); return b.fen(); })();
  const skip = { book: new Set([keyAfter('d4 e5')]), bookMoves: 1, intended: new Set() };

  it('book moves within bookMoves only', () => {
    expect(skips(skip, key, 'e7e5', 1, after)).toBe(true);
    expect(skips({ ...skip, bookMoves: 0 }, key, 'e7e5', 1, after)).toBe(false);
    expect(skips(NO_SKIP, key, 'e7e5', 1, after)).toBe(false);
  });

  it('intended moves at any move number', () => {
    expect(skips({ ...NO_SKIP, intended: new Set([intendedId(key, 'e7e5')]) }, key, 'e7e5', 30, after)).toBe(true);
  });
});
