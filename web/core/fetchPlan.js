// Incremental-download planning (port of the pure parts of opening_trainer/fetch.py).
// What to request next from the Lichess export so that a stopped or reloaded download resumes
// without gaps and without re-downloading: newer games oldest first, then older games newest first.
// No I/O here; lichess/download.js streams and stores, store/db.js persists.

/**
 * Only standard chess from the normal starting position.
 * @param {{variant?: string, initialFen?: string}} game
 * @returns {boolean}
 */
export function isSupported(game) {
  return game.variant === 'standard' && !('initialFen' in game);
}

/** Summary of the stored games of the selected perf types (fetch.py `StoreState`). */
export class StoreState {
  constructor() {
    /** @type {Set<string>} ids of every stored game, any perf */
    this.ids = new Set();
    this.count = 0;
    /** @type {number|null} createdAt in ms */
    this.newest = null;
    /** @type {number|null} */
    this.oldest = null;
  }

  /**
   * @param {Iterable<{id: string, perf?: string, createdAt: number}>} games
   * @param {Iterable<string>} perfs
   */
  static fromGames(games, perfs) {
    const state = new StoreState();
    const wanted = new Set(perfs);
    for (const g of games) state.add(g, wanted);
    return state;
  }

  /**
   * Count one more stored game. fetch.py re-reads the file instead; the result is the same.
   * @param {{id: string, perf?: string, createdAt: number}} game
   * @param {Set<string>} perfs
   */
  add(game, perfs) {
    this.ids.add(game.id);
    if (!perfs.has(game.perf)) return;
    const ts = game.createdAt;
    this.count += 1;
    this.newest = this.newest === null ? ts : Math.max(this.newest, ts);
    this.oldest = this.oldest === null ? ts : Math.min(this.oldest, ts);
  }
}

/**
 * @typedef {object} CursorData  persisted per user (IndexedDB `fetchState`)
 * @property {string[]} perfs
 * @property {number|null} oldestSeen
 * @property {number|null} newestSeen
 * @property {boolean} exhausted  the back-fill reached the user's first game
 */

/** What has been seen for one perf set, stored or not (fetch.py `Cursor`). */
export class Cursor {
  /** @param {Partial<CursorData>} [data] */
  constructor({ perfs = [], oldestSeen = null, newestSeen = null, exhausted = false } = {}) {
    this.perfs = perfs;
    this.oldestSeen = oldestSeen;
    this.newestSeen = newestSeen;
    this.exhausted = exhausted;
    /** @type {string[]|null} the previous perf set when `load` reset the cursor (not persisted) */
    this.resetFrom = null;
  }

  /** @param {number} ts */
  see(ts) {
    this.oldestSeen = this.oldestSeen === null ? ts : Math.min(this.oldestSeen, ts);
    this.newestSeen = this.newestSeen === null ? ts : Math.max(this.newestSeen, ts);
  }

  /**
   * The saved cursor, or a fresh one when nothing usable is saved or the perf set changed
   * (then `resetFrom` holds the old set, so the caller can say why the back-fill restarts).
   * @param {Partial<CursorData>|null|undefined} saved
   * @param {string[]} perfs
   * @returns {Cursor}
   */
  static load(saved, perfs) {
    const wanted = [...perfs].sort();
    const valid = saved && typeof saved === 'object' && Array.isArray(saved.perfs)
      && [saved.oldestSeen, saved.newestSeen].every((v) => v === null || v === undefined || Number.isFinite(v));
    if (!valid) return new Cursor({ perfs: wanted });
    const cursor = new Cursor({
      perfs: saved.perfs,
      oldestSeen: saved.oldestSeen ?? null,
      newestSeen: saved.newestSeen ?? null,
      exhausted: saved.exhausted === true,
    });
    if (cursor.perfs.join(',') !== wanted.join(',')) {
      const fresh = new Cursor({ perfs: wanted });
      fresh.resetFrom = cursor.perfs;
      return fresh;
    }
    return cursor;
  }

  /** @returns {CursorData} */
  toJSON() {
    return { perfs: this.perfs, oldestSeen: this.oldestSeen, newestSeen: this.newestSeen, exhausted: this.exhausted };
  }
}

/** @typedef {{sort: 'dateAsc'|'dateDesc', since?: number, until?: number, max?: number}} ExportParams */

/** @param {Array<number|null>} values */
function minOf(...values) {
  const present = values.filter((v) => v !== null);
  return present.length ? Math.min(...present) : null;
}

/** @param {Array<number|null>} values */
function maxOf(...values) {
  const present = values.filter((v) => v !== null);
  return present.length ? Math.max(...present) : null;
}

/**
 * Params for games newer than anything seen, oldest first so an abort leaves no gap.
 * @param {StoreState} state
 * @param {Cursor} cursor
 * @param {number|null} [sinceMs]
 * @returns {ExportParams|null}
 */
export function newerParams(state, cursor, sinceMs = null) {
  const newest = maxOf(state.newest, cursor.newestSeen);
  if (newest === null) return null;
  return { since: Math.max(newest + 1, sinceMs ?? 0), sort: 'dateAsc' };
}

/**
 * Params for older games, newest first, until `maxGames` are stored or `sinceMs` is reached.
 * `maxGames = null` means no limit (the CLI's --all).
 * @param {StoreState} state
 * @param {Cursor} cursor
 * @param {number|null} [maxGames]
 * @param {number|null} [sinceMs]
 * @returns {ExportParams|null}
 */
export function backfillParams(state, cursor, maxGames = null, sinceMs = null) {
  if (maxGames !== null && state.count >= maxGames) return null;
  const oldest = minOf(state.oldest, cursor.oldestSeen);
  if (sinceMs !== null && oldest !== null && oldest <= sinceMs) return null;
  if (sinceMs === null && cursor.exhausted) return null;
  /** @type {ExportParams} */
  const params = { sort: 'dateDesc' };
  if (oldest !== null) params.until = oldest - 1;
  if (maxGames !== null) params.max = maxGames - state.count;
  if (sinceMs !== null) params.since = sinceMs;
  return params;
}

/**
 * Accounting for one export request (the body of fetch.py's `run`): decides per streamed object
 * whether to stop, skip or store it, and moves the cursor and the store state along.
 */
export class Batch {
  /**
   * @param {ExportParams} params
   * @param {StoreState} state
   * @param {Cursor} cursor
   * @param {Iterable<string>} perfs
   */
  constructor(params, state, cursor, perfs) {
    this.params = params;
    this.state = state;
    this.cursor = cursor;
    this.perfs = new Set(perfs);
    // Lichess may return more than `max` when perfType is set, so enforce it here too.
    this.limit = params.max ?? null;
    /** objects delivered (stored or skipped), not counting the one that hit the limit */
    this.seen = 0;
    this.stored = 0;
  }

  /**
   * @param {any} game  one parsed ndjson object
   * @returns {'stop'|'skip'|'store'}  'stop': end the request, the object was not consumed
   */
  accept(game) {
    if (this.limit !== null && this.stored >= this.limit) return 'stop';
    this.seen += 1;
    const id = game?.id;
    const ts = game?.createdAt;
    if (!id || !Number.isInteger(ts)) return 'skip';
    this.cursor.see(ts);
    if (this.state.ids.has(id) || !isSupported(game)) return 'skip';
    this.state.add(game, this.perfs);
    this.stored += 1;
    return 'store';
  }

  /** The stream ended before `max`: nothing older is left (within `since`, if given). */
  get ranDry() {
    return this.params.max === undefined || this.seen < this.params.max;
  }
}
