// Incremental download of one user's games into IndexedDB: the loop of fetch.py's `fetch()`.
// fetch.worker.js runs it; tests run it with a fake `stream` and fake-indexeddb.
//
// Order, as in fetch.py: first games newer than anything seen (oldest first), then older games
// (newest first) in batches until `maxGames` are stored or the history runs dry. Games and the cursor
// are written together every few games, so a stop, crash or reload keeps everything written so far
// and the next run continues where this one ended.

import { Batch, Cursor, StoreState, backfillParams, newerParams } from '../core/fetchPlan.js';
import { getFetchState, getGames, saveFetchBatch, userIdOf } from '../store/db.js';
import { LichessError } from './client.js';

export const RETRY_DELAY_MS = 60_000; // Lichess asks for a full minute after a 429 (design §3.1)
const FLUSH_GAMES = 25;
const FLUSH_MS = 500;

/**
 * @typedef {object} Progress
 * @property {number} stored  stored games of the selected perfs (committed)
 * @property {number} total   stored games of any perf (committed)
 * @property {number} added   games added by this run (committed)
 * @property {number} seen    objects received by this run (stored or skipped)
 * @property {number} requests export requests made by this run
 */

/**
 * Resolves after `ms`, rejects with an AbortError as soon as `signal` aborts.
 * @param {number} ms @param {AbortSignal} [signal]
 */
export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(signal.reason); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 429 and network failures (including a 429 without CORS headers) are worth one patient retry. */
function retryable(err) {
  return err instanceof LichessError && (err.kind === 'rate_limited' || err.kind === 'network');
}

/**
 * @param {object} opts
 * @param {IDBDatabase} opts.db
 * @param {string} opts.user  canonical Lichess name (used in the request; stored lower-cased)
 * @param {string[]} opts.perfs
 * @param {number|null} opts.maxGames  null: no limit
 * @param {number|null} [opts.sinceMs]
 * @param {(user: string, params: object, opts: {signal: AbortSignal}) => AsyncIterable<any>} opts.stream  client.js streamGames
 * @param {AbortSignal} [opts.signal]
 * @param {(p: Progress) => void} [opts.onProgress]  after every committed batch
 * @param {(message: string) => void} [opts.onNote]
 * @param {(err: LichessError, delayMs: number) => void} [opts.onRetry]  before the single wait-and-retry
 * @param {typeof abortableSleep} [opts.sleep]
 * @param {number} [opts.retryDelayMs]
 * @returns {Promise<Progress>}
 */
export async function download({
  db, user, perfs, maxGames, sinceMs = null, stream, signal,
  onProgress = () => {}, onNote = () => {}, onRetry = () => {},
  sleep = abortableSleep, retryDelayMs = RETRY_DELAY_MS,
}) {
  const userId = userIdOf(user);
  const cursor = Cursor.load(await getFetchState(db, userId), perfs);
  if (cursor.resetFrom) {
    onNote(`Perf types changed (${cursor.resetFrom.join(',')} -> ${cursor.perfs.join(',')}); restarting the back-fill for the new set.`);
  }
  const state = StoreState.fromGames(await getGames(db, userId), perfs);
  const common = { perfType: perfs.join(',') };
  const counts = { added: 0, seen: 0, requests: 0 };
  let pending = [];
  let lastFlush = Date.now();

  const progress = () => ({ stored: state.count, total: state.ids.size, ...counts });

  /** Commit the pending games together with the cursor that covers them. */
  async function flush() {
    const games = pending;
    lastFlush = Date.now();
    await saveFetchBatch(db, userId, games, { user, ...cursor.toJSON() });
    pending = []; // only once written: on a failed write they are kept for the next flush
    counts.added += games.length;
    onProgress(progress());
  }

  /** One export request. @param {import('../core/fetchPlan.js').ExportParams} params */
  async function run(params) {
    const batch = new Batch(params, state, cursor, perfs);
    // Own controller per request: leaving the loop early (the max was reached) also cancels the body.
    const ctrl = new AbortController();
    const relay = () => ctrl.abort(signal.reason);
    signal?.addEventListener('abort', relay, { once: true });
    counts.requests += 1;
    try {
      for await (const game of stream(user, { ...common, ...params }, { signal: ctrl.signal })) {
        const verdict = batch.accept(game);
        if (verdict === 'stop') break;
        counts.seen += 1;
        if (verdict === 'store') pending.push(game);
        if (pending.length >= FLUSH_GAMES || Date.now() - lastFlush >= FLUSH_MS) await flush();
      }
    } catch (err) {
      if (err instanceof SyntaxError) throw new LichessError(`Unreadable answer from Lichess: ${err.message}`, 'http');
      throw err;
    } finally {
      signal?.removeEventListener('abort', relay);
      ctrl.abort();
    }
    await flush();
    return batch;
  }

  async function plan() {
    if (signal?.aborted) throw signal.reason;
    const newer = newerParams(state, cursor, sinceMs);
    if (newer !== null) await run(newer);
    // Back-fill in batches: skipped games use up a batch, so ask again until enough are stored.
    for (;;) {
      const params = backfillParams(state, cursor, maxGames, sinceMs);
      if (params === null) break;
      const batch = await run(params);
      if (batch.ranDry) {
        if (sinceMs === null) {
          cursor.exhausted = true;
          await flush();
        }
        break;
      }
    }
  }

  let retried = false;
  for (;;) {
    try {
      await plan();
      return progress();
    } catch (err) {
      // Keep what arrived before the failure or the stop. If storing itself failed, report the original error.
      try { await flush(); } catch { /* the original error explains more */ }
      if (retried || !retryable(err) || signal?.aborted) throw err;
      retried = true;
      onRetry(err, retryDelayMs);
      await sleep(retryDelayMs, signal);
    }
  }
}
