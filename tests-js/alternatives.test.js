// Lazy MultiPV on open (slice 7): unchecked entries, the on-demand window, and the stored document update.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyTopMoves, checkAlternatives, needsAlternatives } from '../web/analysis/alternatives.js';
import { Coordinator } from '../web/analysis/coordinator.js';
import { fenKey } from '../web/core/fen.js';
import { getPositions, openDb, putGames, putPositions, updatePositions } from '../web/store/db.js';

const DIR = new URL('../spec/fixtures/', import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, DIR), 'utf8'));

/** Fixture-driven engine double (as in coordinator.test.js), counting MultiPV searches. */
function fakePool(fx) {
  const pool = {
    workers: 2,
    multipvCalls: [],
    ready: async () => 'Fake Engine 1',
    async analyse(fen, depth, multipv) {
      const key = fenKey(fen);
      if (multipv !== 1) pool.multipvCalls.push(key);
      await new Promise((r) => setTimeout(r, 1));
      return { lines: multipv === 1 ? [fx.fakeEngine[key] ?? [null, 0]] : (fx.topMoves[key] ?? []), nodes: 1, timeMs: 1 };
    },
    stop() {},
  };
  return pool;
}

const options = (fx, extra = {}) => ({
  perfs: ['blitz'], since: null, maxGames: null, maxMoves: fx.settings.max_moves, threshold: fx.settings.threshold,
  depth: 12, multipv: 'eager', flushMs: 1, ...extra,
});

async function dbWith(fx) {
  const db = await openDb({ factory: new IDBFactory() });
  await putGames(db, fx.user, fx.games);
  return db;
}

describe('unchecked entries from a lazy run', () => {
  it('marks only positions without a MultiPV search; eager runs end with none', async () => {
    const fx = fixture('accept-window');
    const lazy = await new Coordinator({ db: await dbWith(fx), pool: fakePool(fx), user: fx.user,
      options: options(fx, { multipv: 'lazy', lazyTop: 2, checkpointGames: 1000, checkpointMs: 1e9 }) }).run();
    const flags = lazy.doc.positions.map(needsAlternatives);
    expect(flags).toEqual([false, false, true, true, true]);
    for (const p of lazy.doc.positions.filter(needsAlternatives)) expect(p.acceptable).toEqual([p.best]);

    const eager = await new Coordinator({ db: await dbWith(fx), pool: fakePool(fx), user: fx.user, options: options(fx) }).run();
    expect(eager.doc.positions.some(needsAlternatives)).toBe(false);
    expect(JSON.stringify(eager.doc.positions)).toBe(JSON.stringify(fx.expected.positions));
  });
});

describe('applyTopMoves', () => {
  const entry = {
    key: 'k', fen: 'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq - 0 1', best: 'e7e5', best_san: 'e5',
    acceptable: ['e7e5'], played: [{ uci: 'a7a6', san: 'a6', count: 1 }], unchecked: true, games: [],
  };

  it('is aggregate.js: window within the threshold, recorded moves excluded, marker gone, key order kept', () => {
    const out = applyTopMoves(entry, [['c7c5', 30], ['e7e5', 25], ['a7a6', 20], ['g8f6', 5]], 20);
    expect(out).toMatchObject({ best: 'c7c5', best_san: 'c5', acceptable: ['c7c5', 'e7e5'] });
    expect('unchecked' in out).toBe(false);
    expect(Object.keys(out)).toEqual(['key', 'fen', 'best', 'best_san', 'acceptable', 'played', 'games']);
  });

  it('falls back like aggregate.js when the top line is a recorded mistake or nothing came back', () => {
    expect(applyTopMoves(entry, [['a7a6', 30], ['g8f6', 0]], 20)).toMatchObject({ best: 'e7e5', acceptable: ['e7e5'] });
    expect(applyTopMoves(entry, [], 20)).toMatchObject({ best: 'e7e5', acceptable: ['e7e5'] });
  });
});

describe('checkAlternatives (on demand, with a fake coordinator)', () => {
  it('stores the window in the document, so it is never searched again, and matches an eager run', async () => {
    const fx = fixture('accept-window');
    const db = await dbWith(fx);
    const pool = fakePool(fx);
    const lazy = await new Coordinator({ db, pool, user: fx.user,
      options: options(fx, { multipv: 'lazy', lazyTop: 1, checkpointGames: 1000, checkpointMs: 1e9 }) }).run();
    const before = pool.multipvCalls.length;

    const asked = [];
    const fakeCoordinator = { topMoves: async (fen) => { asked.push(fenKey(fen)); return fx.topMoves[fenKey(fen)] ?? []; } };
    for (const entry of lazy.doc.positions.filter(needsAlternatives)) {
      const updated = await checkAlternatives({ db, user: fx.user, entry, threshold: fx.settings.threshold, topMoves: fakeCoordinator.topMoves });
      expect(needsAlternatives(updated)).toBe(false);
    }
    expect(asked).toHaveLength(4);
    expect(pool.multipvCalls.length).toBe(before); // the fake coordinator answered, not the run's pool

    const stored = await getPositions(db, fx.user);
    expect(stored.positions.some(needsAlternatives)).toBe(false);
    expect(JSON.stringify(stored.positions)).toBe(JSON.stringify(fx.expected.positions)); // same as eager
  });

  it('works through a real idle Coordinator after the run (a returning visit) and caches the search', async () => {
    const fx = fixture('accept-window');
    const db = await dbWith(fx);
    const lazy = await new Coordinator({ db, pool: fakePool(fx), user: fx.user,
      options: options(fx, { multipv: 'lazy', lazyTop: 0, checkpointGames: 1000, checkpointMs: 1e9 }) }).run();
    const entry = lazy.doc.positions.find(needsAlternatives);
    const pool = fakePool(fx);
    const idle = new Coordinator({ db, pool, user: fx.user, options: options(fx, { multipv: 'lazy' }) });
    const updated = await checkAlternatives({ db, user: fx.user, entry, threshold: 20, topMoves: (f) => idle.topMoves(f) });
    expect(updated).toEqual(fx.expected.positions.find((p) => p.key === entry.key));
    await new Promise((r) => setTimeout(r, 20)); // the idle coordinator's eval flush

    // A later run finds the MultiPV row in the cache: no new search, and that entry is not unchecked.
    const pool2 = fakePool(fx);
    const again = await new Coordinator({ db, pool: pool2, user: fx.user,
      options: options(fx, { multipv: 'lazy', lazyTop: 0, checkpointGames: 1000, checkpointMs: 1e9 }) }).run();
    expect(pool2.multipvCalls).toEqual([]);
    expect(again.doc.positions.find((p) => p.key === entry.key)).toEqual(updated);
  });

  it('leaves an entry that is already checked (or a newer document without it) alone', async () => {
    const db = await openDb({ factory: new IDBFactory() });
    const entry = { key: 'k', fen: 'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq - 0 1', best: 'e7e5', best_san: 'e5',
      acceptable: ['e7e5', 'c7c5'], played: [], games: [] };
    await putPositions(db, 'Someone', { user: 'Someone', positions: [entry] });
    await checkAlternatives({ db, user: 'Someone', entry: { ...entry, unchecked: true }, threshold: 20, topMoves: async () => [['g8f6', 0]] });
    expect((await getPositions(db, 'Someone')).positions[0]).toEqual(entry);
  });
});

describe('updatePositions', () => {
  it('reads and writes in one transaction; undefined keeps the document; a throw aborts', async () => {
    const db = await openDb({ factory: new IDBFactory() });
    await putPositions(db, 'A', { user: 'A', positions: [], n: 1 });
    expect(await updatePositions(db, 'a', (d) => ({ ...d, n: d.n + 1 }))).toMatchObject({ n: 2 });
    expect(await updatePositions(db, 'A', () => undefined)).toMatchObject({ n: 2 });
    await expect(updatePositions(db, 'A', () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await getPositions(db, 'A')).toMatchObject({ n: 2 });
    expect(await updatePositions(db, 'nobody', (d) => d)).toBeUndefined();
  });
});
