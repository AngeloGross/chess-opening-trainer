// The download loop with a fake Lichess and fake-indexeddb: port of the fetch() cases of
// tests/test_fetch.py, plus the browser-only parts (stop, reload resume, one retry after a 429).
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LichessError } from '../web/lichess/client.js';
import { download } from '../web/lichess/download.js';
import { getFetchState, getGames, openDb, putFetchState } from '../web/store/db.js';

const game = (i, ts, variant = 'standard') => ({ id: `g${i}`, variant, perf: 'blitz', createdAt: ts });

/** Serves `games` like the export API: honours since/until/sort, overshoots max a little (as Lichess does). */
function fakeLichess(games, { overshoot = 2 } = {}) {
  const calls = [];
  async function* stream(user, params, { signal } = {}) {
    calls.push(params);
    let out = games.filter((g) => (params.since ?? 0) <= g.createdAt && g.createdAt <= (params.until ?? 1e15));
    out.sort((a, b) => (params.sort === 'dateDesc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt));
    if (params.max !== undefined) out = out.slice(0, params.max + overshoot);
    for (const g of out) {
      if (signal?.aborted) throw signal.reason;
      await Promise.resolve();
      yield g;
    }
  }
  return { stream, calls };
}

let db;
beforeEach(async () => {
  db = await openDb({ factory: new IDBFactory() });
});

const ids = async (user = 'u') => (await getGames(db, user)).map((g) => g.id);
const run = (stream, maxGames, extra = {}) =>
  download({ db, user: 'u', perfs: ['blitz'], maxGames, stream, sleep: async () => {}, ...extra });

describe('download (test_fetch.py fetch cases)', () => {
  it('enforces max and resumes with since', async () => {
    const api = fakeLichess(Array.from({ length: 12 }, (_, i) => game(i, 1000 - i)));
    expect((await run(api.stream, 10)).added).toBe(10);
    expect(api.calls[0].max).toBe(10);
    expect(api.calls[0].since).toBeUndefined();
    expect((await ids())[0]).toBe('g9'); // oldest stored

    api.calls.length = 0;
    expect((await run(api.stream, 10)).added).toBe(0); // all known, nothing to back-fill
    expect(api.calls.map((c) => [c.sort, c.since])).toEqual([['dateAsc', 1001]]);
  });

  it('back-fill loops past a batch of only skipped games', async () => {
    const games = [...Array.from({ length: 5 }, (_, i) => game(i, 1000 - i, 'fromPosition')),
      ...Array.from({ length: 5 }, (_, i) => game(i + 5, 995 - i))];
    const api = fakeLichess(games, { overshoot: 0 });
    expect((await run(api.stream, 5)).added).toBe(5);
    expect(api.calls.map((c) => [c.until, c.max])).toEqual([[undefined, 5], [995, 5]]);

    api.calls.length = 0;
    expect((await run(api.stream, 5)).added).toBe(0);
    expect(api.calls.map((c) => c.sort)).toEqual(['dateAsc']); // no back-fill re-request
  });

  it('all-skipped history is not requested again', async () => {
    const api = fakeLichess(Array.from({ length: 3 }, (_, i) => game(i, 1000 - i, 'fromPosition')));
    expect((await run(api.stream, 10)).added).toBe(0);
    expect(await getFetchState(db, 'u')).toMatchObject({ oldestSeen: 998, newestSeen: 1000, exhausted: true });

    api.calls.length = 0;
    await run(api.stream, 10);
    expect(api.calls.map((c) => [c.sort, c.since])).toEqual([['dateAsc', 1001]]);
  });

  it('changed perfs reset the cursor and say so', async () => {
    await putFetchState(db, 'u', { user: 'u', perfs: ['blitz'], oldestSeen: 5, newestSeen: 5, exhausted: true });
    const api = fakeLichess([]);
    const notes = [];
    await download({ db, user: 'u', perfs: ['rapid', 'blitz'], maxGames: 10, stream: api.stream, onNote: (m) => notes.push(m) });
    expect(notes).toEqual([expect.stringContaining('Perf types changed (blitz -> blitz,rapid)')]);
    expect(api.calls).toEqual([{ perfType: 'rapid,blitz', sort: 'dateDesc', max: 10 }]);
  });

  it('objects without id are skipped', async () => {
    const api = fakeLichess([game(1, 1000), { variant: 'standard', perf: 'blitz', createdAt: 999 }]);
    expect((await run(api.stream, 10)).added).toBe(1);
  });

  it('an aborted stream keeps received games (after its one retry)', async () => {
    const calls = [];
    async function* broken(user, params) {
      calls.push(params);
      yield game(1, 2);
      throw new LichessError('connection reset', 'network');
    }
    const sleep = vi.fn(async () => {});
    const retries = [];
    const err = await run(broken, 10, { sleep, onRetry: (e, ms) => retries.push([e.kind, ms]) }).catch((e) => e);
    expect(err).toBeInstanceOf(LichessError);
    expect(err.kind).toBe('network');
    expect(await ids()).toEqual(['g1']);
    expect((await getFetchState(db, 'u')).exhausted).toBe(false);
    expect(retries).toEqual([['network', 60_000]]);
    expect(sleep).toHaveBeenCalledOnce();
    // The retry resumed above the stored game instead of starting over.
    expect(calls.map((c) => [c.sort, c.since, c.until])).toEqual([['dateDesc', undefined, undefined], ['dateAsc', 3, undefined]]);
  });
});

describe('download (browser behaviour)', () => {
  const history = Array.from({ length: 150 }, (_, i) => game(i, 10_000 - i));

  it('a stop keeps what was stored and the next run continues without gaps or duplicates', async () => {
    const api = fakeLichess(history);
    const ctrl = new AbortController();
    const err = await download({
      db, user: 'U', perfs: ['blitz'], maxGames: 150, stream: api.stream, signal: ctrl.signal,
      onProgress: (p) => { if (p.added >= 50) ctrl.abort(); },
    }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    const kept = await ids();
    expect(kept.length).toBeGreaterThanOrEqual(50);
    expect(kept.length).toBeLessThan(150);

    api.calls.length = 0;
    const res = await run(api.stream, 150);
    expect(res.added).toBe(150 - kept.length);
    expect(api.calls.map((c) => [c.sort, c.since, c.until, c.max])).toEqual([
      ['dateAsc', 10_001, undefined, undefined],
      ['dateDesc', undefined, 10_000 - kept.length, 150 - kept.length],
    ]);
    const all = await ids();
    expect(all.length).toBe(150);
    expect(new Set(all).size).toBe(150);
  });

  it('a run after a partial one requests only the rest', async () => {
    // A reload kills the worker; what is left is the last committed batch (games + cursor together).
    const api = fakeLichess(history);
    await run(api.stream, 40); // committed
    api.calls.length = 0;
    await run(api.stream, 150);
    expect(api.calls.map((c) => [c.sort, c.until, c.max])).toEqual([['dateAsc', undefined, undefined], ['dateDesc', 9960, 110]]);
    expect(new Set(await ids()).size).toBe(150);
  });

  it('a later run fetches only genuinely new games', async () => {
    const api = fakeLichess(history);
    await run(api.stream, 150);
    api.calls.length = 0;
    expect((await run(api.stream, 150)).added).toBe(0);
    expect(api.calls).toHaveLength(1);

    const newer = fakeLichess([game(900, 20_000), game(901, 20_001), ...history]);
    const res = await run(newer.stream, 150);
    expect(res.added).toBe(2);
    expect(newer.calls.map((c) => [c.sort, c.since])).toEqual([['dateAsc', 10_001]]);
  });

  it('does not retry errors other than rate limit or network', async () => {
    const sleep = vi.fn(async () => {});
    // eslint-disable-next-line require-yield
    async function* notFound() { throw new LichessError('not found', 'not_found'); }
    await expect(run(notFound, 10, { sleep })).rejects.toMatchObject({ kind: 'not_found' });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a stop during the retry wait ends the run', async () => {
    const ctrl = new AbortController();
    // eslint-disable-next-line require-yield
    async function* limited() { throw new LichessError('slow down', 'rate_limited'); }
    const p = download({
      db, user: 'u', perfs: ['blitz'], maxGames: 10, stream: limited, signal: ctrl.signal,
      retryDelayMs: 60_000, onRetry: () => setTimeout(() => ctrl.abort(), 5),
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('an unreadable line is reported as an http error', async () => {
    async function* garbage() { yield game(1, 5); throw new SyntaxError('Unexpected end of JSON input'); }
    await expect(run(garbage, 10)).rejects.toMatchObject({ kind: 'http' });
    expect(await ids()).toEqual(['g1']);
  });
});
