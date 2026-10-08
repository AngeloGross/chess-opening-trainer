// Analysis coordinator with a fake engine pool and fake-indexeddb (design §8, slice 5).
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Coordinator, defaultOptions, runKeyOf, selectGames } from '../web/analysis/coordinator.js';
import { fenKey } from '../web/core/fen.js';
import { getEval, getPositions, getResults, openDb, putGames } from '../web/store/db.js';

const DIR = new URL('../spec/fixtures/', import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, DIR), 'utf8'));
const FIXTURES = ['accept-window', 'black-side', 'clean-games', 'colour-and-urls', 'corrupt-moves', 'decided-position',
  'en-passant', 'loss-cap-ranking', 'mate-scores', 'max-moves', 'mistake-found', 'only-first-mistake',
  'repeated-position', 'rounding-ties', 'tie-breaks'];
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * Engine pool double driven by a fixture: single-PV answers from `fakeEngine` (unknown: [null, 0], like
 * tests/helpers.py FixtureEngine), MultiPV answers from `topMoves` (unknown: no lines).
 * `completed` records searches that delivered an answer; `stop()` rejects every running search.
 */
function fakePool({ evals = {}, tops = {}, workers = 2, delayMs = 1, name = 'Fake Engine 1' } = {}) {
  const running = new Set();
  const pool = {
    workers,
    calls: [],
    completed: [],
    stops: 0,
    ready: async () => name,
    analyse(fen, depth, multipv) {
      const key = fenKey(fen);
      pool.calls.push({ key, depth, multipv });
      return new Promise((resolve, reject) => {
        const job = { reject };
        running.add(job);
        setTimeout(() => {
          if (!running.delete(job)) return;
          pool.completed.push(JSON.stringify([key, depth, multipv]));
          resolve({ lines: multipv === 1 ? [evals[key] ?? [null, 0]] : (tops[key] ?? []), nodes: 1, timeMs: delayMs });
        }, delayMs);
      });
    },
    stop() {
      pool.stops += 1;
      for (const job of running) job.reject(Object.assign(new Error('stopped'), { stopped: true }));
      running.clear();
    },
  };
  return pool;
}

const poolFor = (fx, extra = {}) => fakePool({ evals: fx.fakeEngine ?? {}, tops: fx.topMoves ?? {}, ...extra });

async function dbWith(games, user) {
  const db = await openDb({ factory: new IDBFactory() });
  await putGames(db, user, games);
  return db;
}

function options(fx, extra = {}) {
  return {
    perfs: ['blitz'], since: null, maxGames: null, maxMoves: fx.settings.max_moves, threshold: fx.settings.threshold,
    depth: 14, multipv: 'eager', flushMs: 1, ...extra,
  };
}

describe('selectGames and defaults', () => {
  const g = (id, createdAt, extra = {}) => ({ id, createdAt, perf: 'blitz', variant: 'standard', ...extra });

  it('is cli.select_games: perfs, supported, since, most recent first, limit', () => {
    const games = [g('a', 1), g('b', 5), g('c', 3, { perf: 'bullet' }), g('d', 4, { variant: 'chess960' }),
      g('e', 2, { initialFen: 'x' }), g('f', 6), g('h', 0)];
    expect(selectGames(games, ['blitz'], null, null).map((x) => x.id)).toEqual(['f', 'b', 'a', 'h']);
    expect(selectGames(games, ['blitz'], 1, 2).map((x) => x.id)).toEqual(['f', 'b']);
    expect(selectGames(games, ['blitz', 'bullet'], 3, null).map((x) => x.id)).toEqual(['f', 'b', 'c']);
  });

  it('defaults per device: desktop eager d14/500, mobile lazy top-30 d12/150', () => {
    const desktop = defaultOptions({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0' });
    expect(desktop).toMatchObject({ mobile: false, depth: 14, maxGames: 500, multipv: 'eager', maxMoves: 15, threshold: 20 });
    expect(desktop.perfs).toEqual(['blitz', 'rapid', 'classical']);
    const phone = defaultOptions({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36' });
    expect(phone).toMatchObject({ mobile: true, depth: 12, maxGames: 150, multipv: 'lazy', lazyTop: 30 });
    expect(defaultOptions({ userAgentData: { mobile: true } }).mobile).toBe(true);
  });
});

describe('runKey', () => {
  const base = { user: 'AngelOgro', perfs: ['blitz', 'rapid'], maxMoves: 15, threshold: 20, depth: 14, engineId: 'E' };

  it('is stable for the same settings, case of the name and perf order', () => {
    const key = runKeyOf(base);
    expect(key).toMatch(/^r1-[0-9a-f]{16}$/);
    expect(runKeyOf({ ...base, user: 'angelogro', perfs: ['rapid', 'blitz', 'blitz'] })).toBe(key);
  });

  it('changes with every analysis setting and the engine', () => {
    const key = runKeyOf(base);
    for (const change of [{ user: 'x' }, { perfs: ['blitz'] }, { maxMoves: 14 }, { threshold: 21 }, { depth: 12 }, { engineId: 'F' }]) {
      expect(runKeyOf({ ...base, ...change })).not.toBe(key);
    }
  });
});

describe('coordinator on the shared fixtures', () => {
  for (const name of FIXTURES) {
    it(`${name}: positions equal Python's expected.positions`, async () => {
      const fx = fixture(name);
      const db = await dbWith(fx.games, fx.user);
      const pool = poolFor(fx);
      const co = new Coordinator({ db, pool, user: fx.user, options: options(fx) });
      const { state, doc } = await co.run();
      expect(state).toBe('done');
      const analysed = fx.expected.results.filter((r) => r !== null);
      if (!analysed.length) {
        expect(doc).toBeNull();
        return;
      }
      expect(JSON.stringify(doc.positions)).toBe(JSON.stringify(fx.expected.positions));
      expect(doc.games).toBe(analysed.length);
      expect(doc.clean_games).toBe(analysed.filter((r) => r.mistake === null).length);
      expect(doc.settings).toEqual({ perf: ['blitz'], max_moves: fx.settings.max_moves, threshold: fx.settings.threshold, depth: 14, engine: 'Fake Engine 1' });
      expect(Object.keys(doc)).toEqual(['generated', 'user', 'games', 'clean_games', 'settings', 'positions']);
      expect(doc.generated).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
      expect(await getPositions(db, fx.user)).toEqual(doc);
    });
  }
});

describe('cache and in-flight dedupe', () => {
  it('two games reaching the same positions cause one search per position', async () => {
    const fx = fixture('repeated-position'); // 12 games through the same opening
    const db = await dbWith(fx.games, fx.user);
    const pool = poolFor(fx, { workers: 6, delayMs: 5 }); // 12 games in flight at once
    const co = new Coordinator({ db, pool, user: fx.user, options: options(fx) });
    const { progress } = await co.run();
    const keys = pool.calls.map((c) => JSON.stringify(c));
    expect(new Set(keys).size).toBe(keys.length);
    expect(progress.shared).toBeGreaterThan(0);
    expect(progress.engineSearches).toBe(pool.calls.length);
    expect(progress.positions).toBe(fx.expected.results.reduce((n, r) => n + (r ? r.evaluated.length : 0), 0));
  });

  it('writes every search to IndexedDB under [engineId, fenKey, depth, multipv]', async () => {
    const fx = fixture('mistake-found');
    const db = await dbWith(fx.games, fx.user);
    const pool = poolFor(fx);
    await new Coordinator({ db, pool, user: fx.user, options: options(fx) }).run();
    for (const c of pool.calls) {
      const row = await getEval(db, 'Fake Engine 1', c.key, 14, c.multipv);
      // The fixture has no MultiPV lines for some keys: an empty answer is never cached.
      if (c.multipv === 5 && !fx.topMoves?.[c.key]?.length) expect(row, c.key).toBeUndefined();
      else expect(row?.lines?.length, c.key).toBeGreaterThan(0);
    }
  });

  it('a second run with the same settings needs no engine search', async () => {
    const fx = fixture('accept-window');
    const db = await dbWith(fx.games, fx.user);
    const first = await new Coordinator({ db, pool: poolFor(fx), user: fx.user, options: options(fx) }).run();
    const pool = poolFor(fx);
    const again = await new Coordinator({ db, pool, user: fx.user, options: options(fx) }).run();
    // Only MultiPV keys the fixture has no lines for (empty answers are not cached) are searched again.
    const uncached = Object.keys(Object.fromEntries(fx.expected.positions.map((p) => [p.key])))
      .filter((k) => !fx.topMoves?.[k]?.length);
    expect(pool.calls.map((c) => [c.key, c.multipv])).toEqual(uncached.map((k) => [k, 5]));
    expect(again.progress).toMatchObject({ engineSearches: uncached.length, gamesResumed: fx.games.length, gamesDone: fx.games.length });
    expect(JSON.stringify(again.doc.positions)).toBe(JSON.stringify(first.doc.positions));
  });

  it('never caches an empty answer', async () => {
    const fx = fixture('mistake-found');
    const db = await dbWith(fx.games, fx.user);
    const pool = fakePool(); // no MultiPV lines for anything
    const co = new Coordinator({ db, pool, user: fx.user, options: options(fx) });
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    expect(await co.topMoves(fen)).toEqual([]);
    expect(await co.topMoves(fen)).toEqual([]);
    expect(pool.calls.filter((c) => c.multipv === 5)).toHaveLength(2);
    await co._flush();
    expect(await getEval(db, 'Fake Engine 1', fenKey(fen), 14, 5)).toBeUndefined();
    // A non-empty answer is cached: the third call is a hit.
    pool.analyse = async () => ({ lines: [['e7e5', 10]] });
    expect(await co.topMoves(fenKey(fen))).toEqual([['e7e5', 10]]);
    expect(await co.topMoves(fen)).toEqual([['e7e5', 10]]);
    await co._flush();
    expect((await getEval(db, 'Fake Engine 1', fenKey(fen), 14, 5)).lines).toEqual([['e7e5', 10]]);
  });

  it('answers terminal positions without engine or cache, like pool.js', async () => {
    const db = await openDb({ factory: new IDBFactory() });
    const pool = fakePool();
    const co = new Coordinator({ db, pool, user: 'u', options: { flushMs: 1 } });
    await co.init();
    const mate = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
    expect(await co.evaluator.evaluate(mate)).toEqual([null, -10000]);
    expect(await co.evaluator.evaluate('8/8/8/8/8/8/k7/K7 w - - 0 1')).toEqual([null, 0]);
    expect(pool.calls).toEqual([]);
    expect(co.progress).toMatchObject({ terminal: 2, engineSearches: 0, cacheHits: 0 });
  });
});

describe('resume', () => {
  it('after an interruption, finished work causes zero engine calls', async () => {
    const fx = fixture('repeated-position');
    const extra = fixture('tie-breaks');
    const games = [...fx.games, ...extra.games.map((g, i) => ({ ...g, id: `tb${i}`, createdAt: g.createdAt - 10_000_000 }))];
    const evals = { ...extra.fakeEngine, ...fx.fakeEngine };
    const tops = { ...extra.topMoves, ...fx.topMoves };
    const opts = options(fx, { concurrency: 2 });

    // Reference: one uninterrupted run.
    const ref = await new Coordinator({ db: await dbWith(games, fx.user), pool: fakePool({ evals, tops }), user: fx.user, options: opts }).run();

    const db = await dbWith(games, fx.user);
    const first = fakePool({ evals, tops, delayMs: 3 });
    const co1 = new Coordinator({
      db, pool: first, user: fx.user, options: opts,
      onProgress: (p) => { if (p.gamesDone >= 5) co1.stop(); },
    });
    const r1 = await co1.run();
    expect(r1.state).toBe('stopped');
    const finished = r1.progress.gamesDone;
    expect(finished).toBeGreaterThanOrEqual(5);
    expect(finished).toBeLessThan(games.length);
    expect(await getResults(db, fx.user, co1.runKey)).toHaveLength(finished);

    const second = fakePool({ evals, tops, delayMs: 1 });
    const r2 = await new Coordinator({ db, pool: second, user: fx.user, options: opts }).run();
    expect(r2.state).toBe('done');
    expect(r2.progress.gamesResumed).toBe(finished);
    expect(r2.progress.cacheHits).toBeGreaterThan(0);
    // No search that the first run finished is searched again.
    const again = second.completed.filter((k) => first.completed.includes(k));
    expect(again).toEqual([]);
    expect(JSON.stringify(r2.doc.positions)).toBe(JSON.stringify(ref.doc.positions));
  });

  it('a depth change is a new runKey: every game is analysed again at the new depth', async () => {
    const fx = fixture('mistake-found');
    const db = await dbWith(fx.games, fx.user);
    const a = new Coordinator({ db, pool: poolFor(fx), user: fx.user, options: options(fx) });
    await a.run();
    const pool = poolFor(fx);
    const b = new Coordinator({ db, pool, user: fx.user, options: options(fx, { depth: 12 }) });
    const r = await b.run();
    expect(b.runKey).not.toBe(a.runKey);
    expect(r.progress.gamesResumed).toBe(0);
    expect(pool.calls.length).toBeGreaterThan(0);
    expect(pool.calls.every((c) => c.depth === 12)).toBe(true);
    expect(r.doc.settings.depth).toBe(12);
    expect(await getResults(db, fx.user, a.runKey)).toHaveLength(fx.games.length); // the depth-14 run is kept
  });
});

describe('MultiPV modes', () => {
  it('eager searches every mistake key; lazy only the top N at checkpoints', async () => {
    const fx = fixture('accept-window'); // 5 distinct mistake positions
    const mistakes = fx.expected.positions.length;
    expect(mistakes).toBe(5);

    const eagerPool = poolFor(fx);
    const eager = await new Coordinator({ db: await dbWith(fx.games, fx.user), pool: eagerPool, user: fx.user, options: options(fx) }).run();
    expect(eager.progress).toMatchObject({ multipvTotal: mistakes, multipvDone: mistakes, mistakes });
    expect(eagerPool.calls.filter((c) => c.multipv === 5)).toHaveLength(mistakes);

    const lazyPool = poolFor(fx);
    const lazy = await new Coordinator({
      db: await dbWith(fx.games, fx.user), pool: lazyPool, user: fx.user,
      options: options(fx, { multipv: 'lazy', lazyTop: 2, checkpointGames: 1000, checkpointMs: 1e9 }),
    }).run();
    expect(lazy.progress).toMatchObject({ multipvTotal: 2, multipvDone: 2, mistakes });
    const searched = lazyPool.calls.filter((c) => c.multipv === 5).map((c) => c.key);
    expect(searched).toEqual(lazy.doc.positions.slice(0, 2).map((p) => p.key));
    // The top two carry the real accept window; the rest fall back to the single-PV best move.
    expect(lazy.doc.positions.slice(0, 2)).toEqual(eager.doc.positions.slice(0, 2));
    expect(lazy.doc.positions.map((p) => p.key)).toEqual(eager.doc.positions.map((p) => p.key));
  });

  it('lazy with the default top 30 equals eager when there are fewer mistakes', async () => {
    const fx = fixture('tie-breaks');
    const db = await dbWith(fx.games, fx.user);
    const r = await new Coordinator({ db, pool: poolFor(fx), user: fx.user, options: options(fx, { multipv: 'lazy' }) }).run();
    expect(JSON.stringify(r.doc.positions)).toBe(JSON.stringify(fx.expected.positions));
  });
});

describe('pause, resume, stop', () => {
  it('pause issues no new searches; resume re-issues the stopped ones and finishes', async () => {
    const fx = fixture('repeated-position');
    const db = await dbWith(fx.games, fx.user);
    const pool = poolFor(fx, { delayMs: 5 });
    const states = [];
    let paused = false;
    const co = new Coordinator({
      db, pool, user: fx.user, options: options(fx),
      onProgress: (p) => {
        if (states.at(-1) !== p.state) states.push(p.state);
        if (!paused && p.engineSearches >= 2) { paused = true; co.pause(); }
      },
    });
    const done = co.run();
    while (!paused) await tick(1);
    expect(pool.stops).toBe(1); // running searches were stopped
    const calls = pool.calls.length;
    await tick(40);
    expect(pool.calls.length).toBe(calls);
    expect(co.progress.state).toBe('paused');
    co.resume();
    const r = await done;
    expect(r.state).toBe('done');
    expect(states).toEqual(['running', 'paused', 'running', 'done']);
    expect(JSON.stringify(r.doc.positions)).toBe(JSON.stringify(fx.expected.positions));
  });

  it('pause without stopping lets running searches finish', async () => {
    const fx = fixture('mistake-found');
    const db = await dbWith(fx.games, fx.user);
    const pool = poolFor(fx, { delayMs: 5 });
    const co = new Coordinator({ db, pool, user: fx.user, options: options(fx) });
    const done = co.run();
    while (!pool.calls.length) await tick(1);
    co.pause({ stopRunning: false });
    await tick(30);
    expect(pool.stops).toBe(0);
    expect(pool.completed.length).toBe(pool.calls.length); // the running ones finished, nothing new started
    co.resume();
    expect((await done).state).toBe('done');
  });

  it('stop is final, also while paused, and keeps the finished games', async () => {
    const fx = fixture('repeated-position');
    const db = await dbWith(fx.games, fx.user);
    const pool = poolFor(fx, { delayMs: 5 });
    const co = new Coordinator({ db, pool, user: fx.user, options: options(fx, { concurrency: 1 }) });
    const done = co.run();
    while (co.progress.gamesDone < 1) await tick(1);
    co.pause();
    co.stop();
    co.resume(); // no effect after stop
    const r = await done;
    expect(r.state).toBe('stopped');
    expect(r.progress.gamesDone).toBeLessThan(fx.games.length);
    expect(await getResults(db, fx.user, co.runKey)).toHaveLength(r.progress.gamesDone);
  });

  it('an engine failure ends the run with that error and keeps what was finished', async () => {
    const fx = fixture('mistake-found');
    const db = await dbWith(fx.games, fx.user);
    const pool = poolFor(fx);
    const analyse = pool.analyse;
    let n = 0;
    pool.analyse = (...a) => (++n === 4 ? Promise.reject(new Error('worker crashed')) : analyse(...a));
    const co = new Coordinator({ db, pool, user: fx.user, options: options(fx, { concurrency: 1 }) });
    await expect(co.run()).rejects.toThrow('worker crashed');
    expect(co.progress.state).toBe('failed');
  });
});

describe('progress and checkpoints', () => {
  it('reports counts, checkpoints every N games and an ETA', async () => {
    const fx = fixture('rounding-ties'); // 11 games
    const db = await dbWith(fx.games, fx.user);
    const docs = [];
    const seen = [];
    const r = await new Coordinator({
      db, pool: poolFor(fx), user: fx.user, options: options(fx, { checkpointGames: 4, concurrency: 1 }),
      onProgress: (p) => seen.push(p), onCheckpoint: (d) => docs.push(d),
    }).run();
    expect(docs.length).toBe(r.progress.checkpoints);
    expect(docs.length).toBeGreaterThanOrEqual(3); // after 4 and 8 games, plus the final one
    expect(docs.at(-1)).toBe(r.doc);
    expect(r.progress).toMatchObject({ gamesDone: 11, gamesTotal: 11, etaMs: 0 });
    expect(r.progress.cacheHits + r.progress.engineSearches + r.progress.shared + r.progress.terminal)
      .toBeGreaterThanOrEqual(r.progress.positions);
    expect(seen.some((p) => p.state === 'running' && p.gamesDone > 0 && p.gamesDone < 11 && p.etaMs !== null)).toBe(true);
  });
});
