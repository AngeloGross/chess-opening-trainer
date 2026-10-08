// Fetch worker (module worker): checks the user, then runs the incremental download (download.js)
// so that a long stream and JSON parsing never block the page. One run at a time, one request at a time.
//
// Protocol, page -> worker:
//   {type:'start', user, perfs, maxGames, since}   maxGames null = no limit; since = ms or null
//   {type:'stop'}                                  aborts the running request or the retry wait
// worker -> page:
//   {type:'user', name}                            canonical Lichess name, before the download starts
//   {type:'note', message}                         e.g. the cursor was reset because the perfs changed
//   {type:'progress', stored, total, added, seen, requests}   after every committed batch
//   {type:'retry', kind, message, delayMs, ...counts}          rate limit or network error: one wait-and-retry
//   {type:'done', ...counts}
//   {type:'stopped', ...counts}
//   {type:'error', kind, message, ...counts}       kind = LichessError kind, or 'internal'

import { checkUser, streamGames, LichessError } from './client.js';
import { download } from './download.js';
import { countGames, openDb } from '../store/db.js';

/** @type {AbortController|null} */
let controller = null;
/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;
/** last progress, so stop and error messages carry the counts */
let last = { stored: 0, total: 0, added: 0, seen: 0, requests: 0 };

const post = (msg) => self.postMessage(msg);

async function start({ user, perfs, maxGames = null, since = null }) {
  controller = new AbortController();
  const { signal } = controller;
  last = { stored: 0, total: 0, added: 0, seen: 0, requests: 0 };
  try {
    dbPromise ??= openDb();
    const db = await dbPromise;
    last.total = await countGames(db, user);
    const name = await checkUser(user, { signal });
    post({ type: 'user', name });
    const result = await download({
      db, user: name, perfs, maxGames, sinceMs: since, stream: streamGames, signal,
      onProgress: (p) => { last = p; post({ type: 'progress', ...p }); },
      onNote: (message) => post({ type: 'note', message }),
      onRetry: (err, delayMs) => post({ type: 'retry', kind: err.kind, message: err.message, delayMs, ...last }),
    });
    post({ type: 'done', ...result });
  } catch (err) {
    if (signal.aborted) post({ type: 'stopped', ...last });
    else if (err instanceof LichessError) post({ type: 'error', kind: err.kind, message: err.message, ...last });
    else post({ type: 'error', kind: 'internal', message: String(err?.message ?? err), ...last });
  } finally {
    controller = null;
  }
}

self.onmessage = ({ data }) => {
  if (data?.type === 'stop') controller?.abort();
  else if (data?.type === 'start') {
    if (controller) post({ type: 'error', kind: 'internal', message: 'A download is already running.', ...last });
    else start(data);
  }
};
