import 'fake-indexeddb/auto'; // IDBKeyRange and friends as globals
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DB_VERSION, clearUser, countGames, gameSummary, getFetchState, getGames, getSetting, latestGames,
  openDb, putFetchState, putGames, requestPersistence, saveFetchBatch, setSetting, slimGame, userIdOf,
} from '../web/store/db.js';

const game = (id, ts, extra = {}) => ({
  id, createdAt: ts, perf: 'blitz', variant: 'standard', rated: true, status: 'mate', moves: 'e4 e5',
  players: { white: { user: { name: 'A' } } }, opening: { eco: 'C20', name: 'KP' }, ...extra,
});

let db;
beforeEach(async () => {
  db = await openDb({ factory: new IDBFactory() });
});

describe('schema', () => {
  it('creates every store of design §5 at version 1', () => {
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual(['evals', 'fetchState', 'games', 'positions', 'results', 'settings']);
    const tx = db.transaction(['games', 'fetchState', 'evals', 'results']);
    expect(tx.objectStore('games').keyPath).toEqual(['userId', 'id']);
    expect(tx.objectStore('games').index('byUserCreated').keyPath).toEqual(['userId', 'createdAt']);
    expect(tx.objectStore('fetchState').keyPath).toBe('userId');
    expect(tx.objectStore('evals').keyPath).toEqual(['engineId', 'fenKey', 'depth', 'multipv']);
    expect(tx.objectStore('results').keyPath).toEqual(['userId', 'runKey', 'gameId']);
  });

  it('reopens an existing database without an upgrade', async () => {
    const factory = new IDBFactory();
    const first = await openDb({ factory });
    await putGames(first, 'u', [game('a', 1)]);
    first.close();
    const again = await openDb({ factory });
    expect(await countGames(again, 'u')).toBe(1);
  });
});

describe('games', () => {
  it('normalises the user id to lower case, like the per-user files of fetch.py', async () => {
    expect(userIdOf(' AngelOgro ')).toBe('angelogro');
    await putGames(db, 'AngelOgro', [game('a', 1)]);
    expect(await countGames(db, 'angelogro')).toBe(1);
    expect((await getGames(db, 'ANGELOGRO'))[0].userId).toBe('angelogro');
  });

  it('slims games to the fields of design §5', () => {
    expect(Object.keys(slimGame('u', game('a', 1))).sort())
      .toEqual(['createdAt', 'id', 'moves', 'opening', 'perf', 'players', 'userId', 'variant']);
  });

  it('keys games by user and id, so a re-put is not a duplicate', async () => {
    await putGames(db, 'u', [game('a', 1), game('b', 2)]);
    await putGames(db, 'u', [game('a', 1)]);
    await putGames(db, 'other', [game('a', 1)]);
    expect(await countGames(db, 'u')).toBe(2);
    expect(await countGames(db, 'other')).toBe(1);
  });

  it('lists by createdAt per user: all oldest first, latest newest first, summary', async () => {
    await putGames(db, 'u', [game('m', 20), game('o', 10), game('n', 30), game('p', 5)]);
    await putGames(db, 'v', [game('x', 1), game('y', 99)]);
    expect((await getGames(db, 'u')).map((g) => g.id)).toEqual(['p', 'o', 'm', 'n']);
    expect((await latestGames(db, 'u', 2)).map((g) => g.id)).toEqual(['n', 'm']);
    expect(await gameSummary(db, 'u')).toEqual({ count: 4, oldest: 5, newest: 30 });
    expect(await gameSummary(db, 'nobody')).toEqual({ count: 0, oldest: null, newest: null });
  });

  it('writes games and the fetch state in one transaction', async () => {
    await saveFetchBatch(db, 'U', [game('a', 1)], { user: 'U', perfs: ['blitz'], oldestSeen: 1, newestSeen: 1, exhausted: false });
    expect(await countGames(db, 'u')).toBe(1);
    expect(await getFetchState(db, 'u')).toMatchObject({ userId: 'u', user: 'U', perfs: ['blitz'], oldestSeen: 1 });
  });

  it('a failed batch writes neither games nor state', async () => {
    const bad = { ...game('b', 2), createdAt: undefined, id: undefined }; // no key: put throws
    await expect(saveFetchBatch(db, 'u', [game('a', 1), bad], { user: 'u', perfs: [], oldestSeen: 1, newestSeen: 1, exhausted: false }))
      .rejects.toBeTruthy();
    expect(await countGames(db, 'u')).toBe(0);
    expect(await getFetchState(db, 'u')).toBeUndefined();
  });
});

describe('clearUser', () => {
  it("removes this user's games, fetch state, results and positions, and nothing else", async () => {
    await putGames(db, 'u', [game('a', 1), game('b', 2)]);
    await putGames(db, 'v', [game('a', 1)]);
    await putFetchState(db, 'u', { user: 'u', perfs: ['blitz'], oldestSeen: 1, newestSeen: 2, exhausted: true });
    await putFetchState(db, 'v', { user: 'v', perfs: ['blitz'], oldestSeen: 1, newestSeen: 1, exhausted: true });
    const tx = db.transaction(['results', 'positions', 'evals'], 'readwrite');
    tx.objectStore('results').put({ userId: 'u', runKey: 'r', gameId: 'a', color: 'white' });
    tx.objectStore('results').put({ userId: 'v', runKey: 'r', gameId: 'a', color: 'white' });
    tx.objectStore('positions').put({ positions: [] }, 'u');
    tx.objectStore('evals').put({ engineId: 'e', fenKey: 'k', depth: 14, multipv: 1, lines: [] });
    await new Promise((r) => { tx.oncomplete = r; });

    await clearUser(db, 'U');
    expect(await countGames(db, 'u')).toBe(0);
    expect(await getFetchState(db, 'u')).toBeUndefined();
    expect(await countGames(db, 'v')).toBe(1);
    expect(await getFetchState(db, 'v')).toBeTruthy();
    const check = db.transaction(['results', 'positions', 'evals']);
    const counts = await Promise.all(['results', 'positions', 'evals'].map((s) => new Promise((r) => {
      check.objectStore(s).count().onsuccess = (e) => r(e.target.result);
    })));
    expect(counts).toEqual([1, 0, 1]);
  });
});

describe('settings and persistence', () => {
  it('stores any value by name', async () => {
    expect(await getSetting(db, 'lastUser')).toBeUndefined();
    await setSetting(db, 'lastUser', 'AngelOgro');
    await setSetting(db, 'ui', { max: 150 });
    expect(await getSetting(db, 'lastUser')).toBe('AngelOgro');
    expect(await getSetting(db, 'ui')).toEqual({ max: 150 });
  });

  it('requestPersistence asks only when not yet persistent and copes without the API', async () => {
    expect(await requestPersistence({})).toBe(false);
    const persist = vi.fn(async () => true);
    expect(await requestPersistence({ storage: { persisted: async () => false, persist } })).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    const again = vi.fn();
    expect(await requestPersistence({ storage: { persisted: async () => true, persist: again } })).toBe(true);
    expect(again).not.toHaveBeenCalled();
  });
});
