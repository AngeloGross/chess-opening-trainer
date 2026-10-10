// Analysis coordinator (design §4, §7, §8): runs core/analyse.js over a user's stored games with an
// evaluator backed by the IndexedDB eval cache plus the engine pool, writes one `results` row per
// finished game and checkpoints the positions document. The browser counterpart of cli.py `cmd_analyse`.
//
// Plain async logic: the pool and the database are injected, so vitest runs it with a fake pool and
// fake-indexeddb. The pool only needs `ready() -> engine name`, `analyse(fen, depth, multipv) ->
// {lines}`, `stop()` and `workers` (engine/pool.js EnginePool has all four).
//
// How the parts fit:
// - Cache: key [engineId, fenKey, depth, multipv] (store `evals`, same key as evals.sqlite). Lookups go
//   memory -> in-flight -> IndexedDB -> engine. Answers are written in one transaction every ~250 ms
//   together with the finished games' `results` rows, so a result row never commits before its evals.
//   Empty answers are never cached. Terminal positions are answered without the engine and without the
//   cache, exactly like pool.js (`terminalLines`).
// - In-flight dedupe: one promise per cache key, so two games reaching the same position share one search.
// - Resume: games with a `results` row for the current runKey are skipped; every position they needed is
//   in the cache. A search interrupted by pause is re-issued on resume; one interrupted by a reload is
//   lost with the tab and searched again (it never finished, so it is not repeated work).
// - MultiPV: eager (desktop) queues the MultiPV-5 search as soon as a game yields a mistake; lazy
//   (mobile) only for the top `lazyTop` positions at each checkpoint. `topMoves()` searches on demand.
// - Checkpoints: every 25 games or 10 s, `aggregate` over the stored results plus cached MultiPV rows
//   (never a new search), written to `positions[userId]` in the exact positions.json shape, plus
//   `unchecked: true` on entries whose MultiPV search is not cached yet (slice 7, lazy MultiPV on open).

import { aggregate } from '../core/aggregate.js';
import { analyseGame } from '../core/analyse.js';
import { BOOK_ID, DEFAULT_BOOK_MOVES, DEFAULT_OPENING_FLOOR, DEFAULT_OPENING_MOVES } from '../core/book.js';
import { fenKey } from '../core/fen.js';
import { isSupported } from '../core/fetchPlan.js';
import { EngineAnalysisError, MULTIPV, isMobile, terminalLines } from '../engine/pool.js';
import { getEval, getGames, getResults, putPositions, userIdOf, writeAnalysisBatch } from '../store/db.js';

export const DEFAULT_PERFS = ['blitz', 'rapid', 'classical'];
export const LAZY_TOP = 30;
const FLUSH_MS = 250;
const CHECKPOINT_GAMES = 25;
const CHECKPOINT_MS = 10_000;
const RUN_KEY_VERSION = 'runKey/3';

/**
 * @typedef {object} Options
 * @property {string[]} perfs
 * @property {number|null} since  createdAt lower bound in ms, or null
 * @property {number|null} maxGames  most recent N games; null = all
 * @property {number} maxMoves
 * @property {number} bookMoves  within the first N moves a move reaching a `book` position is not judged
 * @property {number} openingMoves  within the first N moves a loss that leaves the player no worse than
 *   -openingFloor cp (Black: 30 cp more) is an opening choice (core/book.js openingChoice); 0 = off
 * @property {number} openingFloor
 * @property {Set<string>} book  gambit book (core/book.js loadGambitBook); empty = no book
 * @property {number} threshold
 * @property {number} depth
 * @property {'eager'|'lazy'} multipv
 * @property {number} lazyTop  lazy mode: MultiPV for this many top positions per checkpoint
 * @property {number} [concurrency]  games in flight; default 2 × pool workers
 * @property {number} [flushMs]
 * @property {number} [checkpointGames]
 * @property {number} [checkpointMs]
 */

/**
 * Per-device defaults (design §8). Desktop: depth 14, 500 games, eager MultiPV. Mobile (same detection
 * as pool.js): depth 12, 150 games, MultiPV lazily for the top 30. Perfs, max moves, book moves and threshold
 * as the CLI. The book itself is loaded by the app and passed in (`book`).
 * @param {Parameters<typeof isMobile>[0]} [nav]
 * @returns {Options & {mobile: boolean}}
 */
export function defaultOptions(nav = globalThis.navigator ?? {}) {
  const mobile = isMobile(nav);
  return {
    mobile,
    perfs: [...DEFAULT_PERFS],
    since: null,
    maxGames: mobile ? 150 : 500,
    maxMoves: 12,
    bookMoves: DEFAULT_BOOK_MOVES,
    openingMoves: DEFAULT_OPENING_MOVES,
    openingFloor: DEFAULT_OPENING_FLOOR,
    book: new Set(),
    threshold: 20,
    depth: mobile ? 12 : 14,
    multipv: mobile ? 'lazy' : 'eager',
    lazyTop: LAZY_TOP,
  };
}

/**
 * cli.py `select_games`: games of the given perfs, supported, on or after `sinceMs`, most recent first,
 * at most `limit` (all if null). Ties on createdAt keep the input order (Array.sort is stable).
 * @template {{perf?: string, createdAt: number}} G
 * @param {Iterable<G>} games @param {Iterable<string>} perfs @param {number|null} sinceMs @param {number|null} limit
 * @returns {G[]}
 */
export function selectGames(games, perfs, sinceMs, limit) {
  const wanted = new Set(perfs);
  const selected = [...games].filter((g) => wanted.has(g.perf) && isSupported(g) && (sinceMs === null || sinceMs === undefined || g.createdAt >= sinceMs));
  selected.sort((a, b) => b.createdAt - a.createdAt);
  return limit === null || limit === undefined ? selected : selected.slice(0, limit);
}

/**
 * 64-bit FNV-1a over the UTF-8 bytes of `text`, as 16 hex digits.
 * @param {string} text @returns {string}
 */
export function fnv1a64(text) {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) h = BigInt.asUintN(64, (h ^ BigInt(byte)) * 0x100000001b3n);
  return h.toString(16).padStart(16, '0');
}

/**
 * Identity of one analysis run: results of a run are only reused by a run with the same key.
 * runKey = "r3-" + fnv1a64(JSON.stringify(["runKey/3", userId, sortedUniquePerfs, maxMoves, threshold, depth, engineId,
 *   bookId, bookMoves, openingMoves, openingFloor])) where userId is the lower-cased name and bookId is BOOK_ID, or null when no book is used
 * (then bookMoves is 0). `since` and `maxGames` only select games, so they are not part of it: a larger game
 * count reuses every finished game.
 * @param {{user: string, perfs: string[], maxMoves: number, threshold: number, depth: number, engineId: string,
 *   bookMoves?: number, book?: Set<string>, openingMoves?: number, openingFloor?: number}} p
 * @returns {string}
 */
export function runKeyOf({ user, perfs, maxMoves, threshold, depth, engineId, bookMoves = 0, book = new Set(),
  openingMoves = 0, openingFloor = DEFAULT_OPENING_FLOOR }) {
  const useBook = book.size > 0 && bookMoves > 0;
  const canonical = JSON.stringify([RUN_KEY_VERSION, userIdOf(user), [...new Set(perfs)].sort(), maxMoves, threshold, depth, engineId,
    useBook ? BOOK_ID : null, useBook ? bookMoves : 0, openingMoves, openingMoves ? openingFloor : 0]);
  return `r3-${fnv1a64(canonical)}`;
}

/** Thrown into running games by `stop()`. */
export class StoppedError extends Error {
  constructor() {
    super('analysis stopped');
    this.name = 'StoppedError';
  }
}

/** Python-style UTC timestamp, as write_positions writes it: 2026-10-08T09:33:44+00:00 */
function generatedAt(ms) {
  return `${new Date(ms).toISOString().slice(0, 19)}+00:00`;
}

/**
 * @typedef {object} Progress
 * @property {'idle'|'running'|'paused'|'stopped'|'done'|'failed'} state
 * @property {string|null} engineId
 * @property {string|null} runKey
 * @property {number} gamesDone  including games finished by an earlier run (resumed)
 * @property {number} gamesTotal
 * @property {number} gamesResumed  finished before this run started
 * @property {number} positions  single-PV evaluations requested (the CLI's "positions")
 * @property {number} cacheHits  answers from the eval cache (any MultiPV)
 * @property {number} engineSearches  finished engine searches (any MultiPV)
 * @property {number} shared  requests that joined a search already in flight
 * @property {number} terminal  mate, stalemate or insufficient material: answered without engine or cache
 * @property {number} multipvDone
 * @property {number} multipvTotal  MultiPV searches queued (eager: every mistake key; lazy: top positions)
 * @property {number} mistakes  distinct mistake keys so far
 * @property {number} checkpoints
 * @property {number} elapsedMs  wall time since start
 * @property {number|null} etaMs  remaining, from this run's rate; null until a game finished
 * @property {number} gamesThisRun  games finished by this run (not resumed ones)
 * @property {number} activeMs  wall time since start minus paused time
 */

export class Coordinator {
  /**
   * @param {object} p
   * @param {IDBDatabase} p.db
   * @param {{ready: () => Promise<string>, analyse: Function, stop: () => void, workers?: number, size?: number}} p.pool
   * @param {string} p.user  Lichess name as shown in the document; stored lower-cased
   * @param {Partial<Options>} [p.options]  merged over `defaultOptions()`
   * @param {(p: Progress) => void} [p.onProgress]
   * @param {(doc: object) => void} [p.onCheckpoint]
   * @param {() => number} [p.now]
   */
  constructor({ db, pool, user, options = {}, onProgress = () => {}, onCheckpoint = () => {}, now = () => Date.now() }) {
    this.db = db;
    this.pool = pool;
    this.user = user;
    this.userId = userIdOf(user);
    /** @type {Options} */
    this.opts = { ...defaultOptions(), flushMs: FLUSH_MS, checkpointGames: CHECKPOINT_GAMES, checkpointMs: CHECKPOINT_MS,
      ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
    this.onProgress = onProgress;
    this.onCheckpoint = onCheckpoint;
    this.now = now;
    this.engineId = null;
    this.runKey = null;
    /** @type {any[]} selected games, most recent first */
    this.games = [];
    /** @type {Map<string, any>} gameId -> result row of this runKey */
    this.results = new Map();
    /** @type {Map<string, Array<[string|null, number]>>} cache key -> lines, everything seen this session */
    this._known = new Map();
    /** @type {Map<string, Promise<Array<[string|null, number]>>>} cache key -> running lookup */
    this._inflight = new Map();
    /** @type {Map<string, Promise<void>>} fenKey -> queued MultiPV search */
    this._multipv = new Map();
    /** @type {Set<string>} fenKeys whose MultiPV search finished in this session (even with no lines) */
    this._multipvSearched = new Set();
    /** @type {Map<string, string>} mistake fenKey -> full FEN */
    this._mistakeFen = new Map();
    this._pendingEvals = new Map();
    this._pendingResults = [];
    this._flushTimer = null;
    this._flushing = Promise.resolve();
    this._checkpointing = null;
    this._sinceCheckpoint = 0;
    this._lastCheckpoint = 0;
    this._paused = false;
    this._stopped = false;
    this._resume = null; // {promise, resolve} while paused
    this._error = null;
    this._started = 0;
    this._pausedAt = 0;
    this._pausedMs = 0;
    this._doneThisRun = 0;
    this._initialised = null;
    /** @type {object|null} the last positions document */
    this.doc = null;
    /** @type {Progress} */
    this.progress = {
      state: 'idle', engineId: null, runKey: null, gamesDone: 0, gamesTotal: 0, gamesResumed: 0, positions: 0,
      cacheHits: 0, engineSearches: 0, shared: 0, terminal: 0, multipvDone: 0, multipvTotal: 0, mistakes: 0,
      checkpoints: 0, elapsedMs: 0, etaMs: null, gamesThisRun: 0, activeMs: 0,
    };
  }

  // ---- lifecycle ----

  /** Engine name and runKey; safe to call more than once. */
  init() {
    this._initialised ??= (async () => {
      this.engineId = await this.pool.ready();
      const { perfs, maxMoves, threshold, depth, bookMoves, book, openingMoves, openingFloor } = this.opts;
      this.runKey = runKeyOf({ user: this.user, perfs, maxMoves, threshold, depth, engineId: this.engineId, bookMoves, book,
        openingMoves, openingFloor });
      Object.assign(this.progress, { engineId: this.engineId, runKey: this.runKey });
    })();
    return this._initialised;
  }

  /**
   * Analyse the selected games, resuming any earlier run with the same runKey.
   * @returns {Promise<{state: 'done'|'stopped', doc: object|null, progress: Progress}>}
   */
  async run() {
    this._started = this.now();
    this._setState(this._paused ? 'paused' : 'running');
    try {
      await this.init();
      const { perfs, since, maxGames, multipv } = this.opts;
      this.games = selectGames(await getGames(this.db, this.userId), perfs, since, maxGames);
      for (const row of await getResults(this.db, this.userId, this.runKey)) this.results.set(row.gameId, row);
      const todo = this.games.filter((g) => !this.results.has(g.id));
      const resumed = this.games.length - todo.length;
      Object.assign(this.progress, { gamesTotal: this.games.length, gamesDone: resumed, gamesResumed: resumed });
      for (const g of this.games) {
        const m = this.results.get(g.id)?.mistake;
        if (m) this._noteMistake(m);
      }
      this._lastCheckpoint = this.now();
      if (resumed) await this._checkpoint(); // positions from the earlier run, at once (lazy: queues their MultiPV)
      this._emit();

      let next = 0;
      const lane = async () => {
        for (;;) {
          await this._gate();
          if (this._stopped || next >= todo.length) return;
          await this._game(todo[next++]);
          if (this._sinceCheckpoint >= this.opts.checkpointGames || this.now() - this._lastCheckpoint >= this.opts.checkpointMs) {
            await this._checkpoint();
          }
        }
      };
      await Promise.all(Array.from({ length: this._concurrency() }, lane));

      if (!this._stopped) {
        // Every game is done; finish the MultiPV searches the document needs, then write the final document.
        if (multipv === 'lazy') await this._checkpoint();
        await this._settleMultipv();
      }
      if (this._error) throw this._error;
      await this._checkpoint({ queueLazy: false });
      this._setState(this._stopped ? 'stopped' : 'done');
      return { state: /** @type {'done'|'stopped'} */ (this.progress.state), doc: this.doc, progress: this.progress };
    } catch (err) {
      try { await this._flush(); } catch { /* the original error explains more */ }
      this._setState('failed');
      throw err;
    } finally {
      clearTimeout(this._flushTimer);
    }
  }

  /**
   * Stop issuing new work. With `stopRunning` (the default) running searches are stopped too and
   * re-issued on resume (design §7); otherwise they finish and only new searches wait.
   * @param {{stopRunning?: boolean}} [opts]
   */
  pause({ stopRunning = true } = {}) {
    if (this._paused || this._stopped) return;
    this._paused = true;
    this._pausedAt = this.now();
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    this._resume = { promise, resolve };
    if (stopRunning) this.pool.stop();
    if (this.progress.state === 'running') this._setState('paused');
  }

  resume() {
    if (!this._paused || this._stopped) return;
    this._paused = false;
    this._pausedMs += this.now() - this._pausedAt;
    this._resume.resolve();
    this._resume = null;
    if (this.progress.state === 'paused') this._setState('running');
  }

  /** Final: running searches are stopped and `run()` resolves with what was finished. */
  stop() {
    if (this._stopped) return;
    if (this._paused) this.resume();
    this._stopped = true;
    this.pool.stop();
  }

  // ---- cache + engine ----

  _cacheKey(key, multipv) {
    return JSON.stringify([this.engineId, key, this.opts.depth, multipv]);
  }

  /**
   * Lines for `fen` at the run depth: memory, then a search already in flight, then IndexedDB, then the engine.
   * @param {string} fen @param {number} multipv
   * @returns {Promise<Array<[string|null, number]>>}
   */
  async _lines(fen, multipv) {
    const terminal = terminalLines(fen);
    if (terminal) {
      this.progress.terminal += 1;
      return terminal;
    }
    const key = fenKey(fen);
    const ck = this._cacheKey(key, multipv);
    const known = this._known.get(ck);
    if (known) {
      this.progress.cacheHits += 1;
      return known;
    }
    const flying = this._inflight.get(ck);
    if (flying) {
      this.progress.shared += 1;
      return flying;
    }
    const lookup = this._lookup(fen, key, multipv, ck);
    this._inflight.set(ck, lookup);
    try {
      return await lookup;
    } finally {
      this._inflight.delete(ck);
    }
  }

  async _lookup(fen, key, multipv, ck) {
    const row = await getEval(this.db, this.engineId, key, this.opts.depth, multipv);
    if (row?.lines?.length) {
      this._known.set(ck, row.lines);
      this.progress.cacheHits += 1;
      return row.lines;
    }
    let res;
    for (;;) {
      await this._gate();
      if (this._stopped) throw new StoppedError();
      try {
        res = await this.pool.analyse(fen, this.opts.depth, multipv);
        break;
      } catch (err) {
        // Stopped by pause: the search is issued again once resumed. Stopped by stop(): give up.
        if (err?.stopped) {
          if (this._stopped) throw new StoppedError();
          continue;
        }
        throw err;
      }
    }
    this.progress.engineSearches += 1;
    const lines = res.lines ?? [];
    if (lines.length) {
      this._known.set(ck, lines);
      this._pendingEvals.set(ck, { engineId: this.engineId, fenKey: key, depth: this.opts.depth, multipv, lines });
      this._scheduleFlush();
    }
    return lines;
  }

  /** The evaluator analyse.js expects (engine.py `evaluate`). */
  get evaluator() {
    return {
      evaluate: async (fen) => {
        this.progress.positions += 1;
        const lines = await this._lines(fen, 1);
        if (!lines.length) throw new EngineAnalysisError(`${this.engineId} returned no move for ${fen}`);
        return lines[0];
      },
    };
  }

  /**
   * engine.py `top_moves` for a FEN or a fenKey, searched on demand when not cached (for the trainer's
   * lazy MultiPV). A bare key is completed with the FEN of the recorded mistake, or " 0 1".
   * @param {string} fenOrKey
   * @returns {Promise<Array<[string, number]>>}
   */
  async topMoves(fenOrKey) {
    await this.init();
    const fields = fenOrKey.trim().split(/\s+/);
    const fen = fields.length >= 6 ? fenOrKey : (this._mistakeFen.get(fields.join(' ')) ?? `${fields.join(' ')} 0 1`);
    const lines = await this._lines(fen, MULTIPV);
    this._multipvSearched.add(fenKey(fen));
    return /** @type {Array<[string, number]>} */ (lines.filter((l) => l[0] !== null));
  }

  /** Cached MultiPV lines only, never a search (aggregate's `topMoves` at a checkpoint). */
  async _cachedTop(fen) {
    const key = fenKey(fen);
    const ck = this._cacheKey(key, MULTIPV);
    let lines = this._known.get(ck);
    if (!lines) {
      lines = (await getEval(this.db, this.engineId, key, this.opts.depth, MULTIPV))?.lines;
      if (lines?.length) this._known.set(ck, lines);
    }
    return (lines ?? []).filter((l) => l[0] !== null);
  }

  /** Queue the MultiPV search of one position once per run. */
  _queueMultipv(fen) {
    const key = fenKey(fen);
    if (this._multipv.has(key) || this._stopped) return;
    this.progress.multipvTotal += 1;
    const job = this._lines(fen, MULTIPV).then(
      () => { this._multipvSearched.add(key); this.progress.multipvDone += 1; this._emit(); },
      (err) => {
        if (err instanceof StoppedError) return;
        this._fail(err);
      },
    );
    this._multipv.set(key, job);
  }

  /** Wait for every queued MultiPV search, including ones queued while waiting. */
  async _settleMultipv() {
    let seen = -1;
    while (seen !== this._multipv.size) {
      seen = this._multipv.size;
      await Promise.all(this._multipv.values());
    }
  }

  _noteMistake(m) {
    if (!this._mistakeFen.has(m.key)) {
      this._mistakeFen.set(m.key, m.fen);
      this.progress.mistakes = this._mistakeFen.size;
    }
    if (this.opts.multipv === 'eager') this._queueMultipv(m.fen);
  }

  // ---- games ----

  _concurrency() {
    const workers = this.pool.workers ?? this.pool.size ?? 1;
    return Math.max(1, this.opts.concurrency ?? 2 * workers);
  }

  async _game(game) {
    let res;
    try {
      const { maxMoves, threshold, book, bookMoves, openingMoves, openingFloor } = this.opts;
      res = await analyseGame(game, this.user, this.evaluator, maxMoves, threshold, { book, bookMoves, openingMoves, openingFloor });
    } catch (err) {
      if (!(err instanceof StoppedError)) this._fail(err);
      return; // not finished: no result row, so a later run analyses it again
    }
    const row = {
      userId: this.userId, runKey: this.runKey, gameId: game.id, createdAt: game.createdAt,
      color: res?.color ?? null, reached: res?.reached ?? [], mistake: res?.mistake ?? null,
    };
    this.results.set(game.id, row);
    this._pendingResults.push(row);
    this._scheduleFlush();
    this.progress.gamesDone += 1;
    this._doneThisRun += 1;
    this._sinceCheckpoint += 1;
    if (row.mistake) this._noteMistake(row.mistake);
    this._emit();
  }

  /** A real failure (not a stop): end the run and let `run()` reject with it. */
  _fail(err) {
    this._error ??= err;
    this.stop();
  }

  async _gate() {
    while (this._paused && !this._stopped) await this._resume.promise;
  }

  // ---- persistence ----

  _scheduleFlush() {
    if (this._flushTimer !== null) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flush().catch((err) => this._fail(err));
    }, this.opts.flushMs);
  }

  /** Write pending evals and results now, in one transaction; serialised with earlier flushes. */
  _flush() {
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
    const evals = [...this._pendingEvals.values()];
    const results = this._pendingResults;
    this._pendingEvals = new Map();
    this._pendingResults = [];
    this._flushing = this._flushing.catch(() => {}).then(() => writeAnalysisBatch(this.db, { evals, results }));
    return this._flushing;
  }

  /**
   * Aggregate the stored results of the selected games with the cached MultiPV rows and store the document.
   * Lazy mode also queues the MultiPV searches of the top positions. One checkpoint at a time.
   * @param {{queueLazy?: boolean}} [opts]
   */
  async _checkpoint({ queueLazy = true } = {}) {
    while (this._checkpointing) await this._checkpointing;
    this._checkpointing = this._writeCheckpoint(queueLazy);
    try {
      await this._checkpointing;
    } finally {
      this._checkpointing = null;
    }
  }

  async _writeCheckpoint(queueLazy) {
    this._sinceCheckpoint = 0;
    this._lastCheckpoint = this.now();
    await this._flush();
    const pairs = [];
    for (const g of this.games) {
      const row = this.results.get(g.id);
      if (row && row.color !== null) pairs.push([g, { color: row.color, reached: row.reached, mistake: row.mistake }]);
    }
    // Positions without a cached MultiPV search (lazy mode outside the top, or eager searches still queued)
    // get `unchecked: true`: their accept window is only the single-PV best until analysis/alternatives.js
    // (or a later checkpoint) fills it in.
    const unchecked = new Set();
    const entries = await aggregate(pairs, async (fen) => {
      const top = await this._cachedTop(fen);
      if (!top.length && !this._multipvSearched.has(fenKey(fen))) unchecked.add(fenKey(fen));
      return top;
    }, this.opts.threshold);
    for (const e of entries) if (unchecked.has(fenKey(e.fen))) e.unchecked = true;
    if (queueLazy && this.opts.multipv === 'lazy') {
      for (const e of entries.slice(0, this.opts.lazyTop)) this._queueMultipv(e.fen);
    }
    if (!pairs.length) return; // like the CLI: nothing of his analysed yet, keep any earlier document
    const { perfs, maxMoves, threshold, depth, bookMoves, book, openingMoves, openingFloor } = this.opts;
    const useBook = book.size > 0 && bookMoves > 0;
    this.doc = {
      generated: generatedAt(this.now()),
      user: this.user,
      games: pairs.length,
      clean_games: pairs.filter(([, r]) => r.mistake === null).length,
      settings: { perf: [...perfs], max_moves: maxMoves, threshold, depth, engine: this.engineId,
        book_moves: useBook ? bookMoves : 0, book: useBook ? BOOK_ID : null, opening_moves: openingMoves, opening_floor: openingFloor },
      positions: entries,
    };
    await putPositions(this.db, this.userId, this.doc);
    this.progress.checkpoints += 1;
    this.onCheckpoint(this.doc);
    this._emit();
  }

  // ---- progress ----

  _setState(state) {
    this.progress.state = state;
    this._emit();
  }

  _emit() {
    const now = this.now();
    const p = this.progress;
    p.elapsedMs = this._started ? now - this._started : 0;
    const active = p.elapsedMs - this._pausedMs - (this._paused ? now - this._pausedAt : 0);
    const left = p.gamesTotal - p.gamesDone;
    // Games carry their share of eager MultiPV; a lazy or final MultiPV tail is not modelled.
    p.activeMs = Math.max(0, active);
    p.gamesThisRun = this._doneThisRun;
    p.etaMs = this._doneThisRun ? Math.round((active / this._doneThisRun) * left) : (left ? null : 0);
    this.onProgress({ ...p });
  }
}

