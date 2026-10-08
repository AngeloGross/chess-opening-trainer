// IndexedDB schema and typed accessors (design §5). Works in pages and module workers alike.
//
// Database `opening-trainer`, version 1:
//   settings    out-of-line key `name`                    any value (lastUser, UI prefs)
//   games       keyPath [userId, id]                      slimmed Lichess game + userId
//                 index byUserCreated [userId, createdAt]
//   fetchState  keyPath userId                            {userId, user, perfs, oldestSeen, newestSeen, exhausted}
//   evals       keyPath [engineId, fenKey, depth, multipv]  {…key, lines: [[uci|null, cp], …]}   (slice 5)
//   results     keyPath [userId, runKey, gameId]          {…key, color, reached, mistake}       (slice 5)
//   positions   out-of-line key userId                    the positions.json document          (slice 6)
// `userId` is the lower-cased Lichess name, as in fetch.py's per-user file names.

export const DB_NAME = 'opening-trainer';
export const DB_VERSION = 1;

/** Fields kept per game (design §5); everything analyse.js needs. */
const GAME_FIELDS = ['id', 'createdAt', 'perf', 'variant', 'players', 'opening', 'moves'];

/** @param {string} user @returns {string} */
export function userIdOf(user) {
  return String(user).trim().toLowerCase();
}

/**
 * Versioned schema: each step creates what its version adds, so later versions only append steps.
 * @param {IDBDatabase} db
 * @param {number} oldVersion
 */
function upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    db.createObjectStore('settings');
    const games = db.createObjectStore('games', { keyPath: ['userId', 'id'] });
    games.createIndex('byUserCreated', ['userId', 'createdAt']);
    db.createObjectStore('fetchState', { keyPath: 'userId' });
    db.createObjectStore('evals', { keyPath: ['engineId', 'fenKey', 'depth', 'multipv'] });
    db.createObjectStore('results', { keyPath: ['userId', 'runKey', 'gameId'] });
    db.createObjectStore('positions');
  }
}

/**
 * @param {{name?: string, factory?: IDBFactory}} [opts]  `factory` lets tests pass a fresh fake-indexeddb
 * @returns {Promise<IDBDatabase>}
 */
export function openDb({ name = DB_NAME, factory = globalThis.indexedDB } = {}) {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = (ev) => upgrade(req.result, ev.oldVersion);
    req.onsuccess = () => {
      const db = req.result;
      // Another tab (or a newer page version) wants to upgrade: let it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('The trainer database is open in an older tab. Close it and retry.'));
  });
}

/** @param {IDBRequest} req @returns {Promise<any>} */
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @param {IDBTransaction} tx @returns {Promise<void>} */
function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Every primary key [userId, …] of one user. Arrays sort after strings and numbers. */
function userKeys(userId) {
  return IDBKeyRange.bound([userId], [userId, []]);
}

/** Index range [userId, createdAt] over all dates. */
function userDates(userId) {
  return IDBKeyRange.bound([userId, -Infinity], [userId, Infinity]);
}

/**
 * @typedef {object} StoredGame
 * @property {string} userId
 * @property {string} id
 * @property {number} createdAt
 * @property {string} perf
 * @property {string} variant
 * @property {object} [players]
 * @property {object} [opening]
 * @property {string} [moves]
 */

/**
 * The stored form of a Lichess export object.
 * @param {string} userId
 * @param {any} game
 * @returns {StoredGame}
 */
export function slimGame(userId, game) {
  /** @type {any} */
  const out = { userId };
  for (const k of GAME_FIELDS) if (game[k] !== undefined) out[k] = game[k];
  return out;
}

// ---- games + fetchState ----

/**
 * @typedef {import('../core/fetchPlan.js').CursorData & {userId: string, user: string, updatedAt?: number}} FetchState
 */

/**
 * Store a batch of games and the fetch cursor in one transaction, so a reload never leaves
 * a cursor that points past games that were not written (or the other way round).
 * @param {IDBDatabase} db
 * @param {string} user
 * @param {any[]} games  raw Lichess objects (slimmed here)
 * @param {Omit<FetchState, 'userId'>|null} [fetchState]
 */
export async function saveFetchBatch(db, user, games, fetchState = null) {
  const userId = userIdOf(user);
  const tx = db.transaction(['games', 'fetchState'], 'readwrite');
  const committed = done(tx);
  try {
    const store = tx.objectStore('games');
    for (const g of games) store.put(slimGame(userId, g));
    if (fetchState) tx.objectStore('fetchState').put({ ...fetchState, userId, updatedAt: Date.now() });
  } catch (err) {
    tx.abort(); // a put that throws (e.g. a game without id) must not commit the rest of the batch
    committed.catch(() => {});
    throw err;
  }
  await committed;
}

/** @param {IDBDatabase} db @param {string} user @param {any[]} games */
export function putGames(db, user, games) {
  return saveFetchBatch(db, user, games, null);
}

/** @param {IDBDatabase} db @param {string} user @returns {Promise<FetchState|undefined>} */
export function getFetchState(db, user) {
  return request(db.transaction('fetchState').objectStore('fetchState').get(userIdOf(user)));
}

/** @param {IDBDatabase} db @param {string} user @param {Omit<FetchState, 'userId'>} state */
export async function putFetchState(db, user, state) {
  const tx = db.transaction('fetchState', 'readwrite');
  tx.objectStore('fetchState').put({ ...state, userId: userIdOf(user), updatedAt: Date.now() });
  await done(tx);
}

/** All stored games of a user, oldest first. @param {IDBDatabase} db @param {string} user @returns {Promise<StoredGame[]>} */
export function getGames(db, user) {
  const index = db.transaction('games').objectStore('games').index('byUserCreated');
  return request(index.getAll(userDates(userIdOf(user))));
}

/** @param {IDBDatabase} db @param {string} user @returns {Promise<number>} */
export function countGames(db, user) {
  return request(db.transaction('games').objectStore('games').count(userKeys(userIdOf(user))));
}

/**
 * The `limit` most recent games of a user, newest first.
 * @param {IDBDatabase} db @param {string} user @param {number} limit
 * @returns {Promise<StoredGame[]>}
 */
export function latestGames(db, user, limit) {
  const index = db.transaction('games').objectStore('games').index('byUserCreated');
  const req = index.openCursor(userDates(userIdOf(user)), 'prev');
  const out = [];
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || out.length >= limit) return resolve(out);
      out.push(cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Count and date range of a user's stored games (all perfs).
 * @param {IDBDatabase} db @param {string} user
 * @returns {Promise<{count: number, oldest: number|null, newest: number|null}>}
 */
export async function gameSummary(db, user) {
  const userId = userIdOf(user);
  const tx = db.transaction('games');
  const index = tx.objectStore('games').index('byUserCreated');
  const edge = async (dir) => (await request(index.openCursor(userDates(userId), dir)))?.value.createdAt ?? null;
  const [count, oldest, newest] = await Promise.all([
    request(tx.objectStore('games').count(userKeys(userId))), edge('next'), edge('prev'),
  ]);
  return { count, oldest, newest };
}

/**
 * Delete everything stored for one user: games, fetch state, results and positions.
 * The eval cache is shared across users and stays.
 * @param {IDBDatabase} db @param {string} user
 */
export async function clearUser(db, user) {
  const userId = userIdOf(user);
  const tx = db.transaction(['games', 'fetchState', 'results', 'positions'], 'readwrite');
  tx.objectStore('games').delete(userKeys(userId));
  tx.objectStore('fetchState').delete(userId);
  tx.objectStore('results').delete(userKeys(userId));
  tx.objectStore('positions').delete(userId);
  await done(tx);
}

// ---- settings ----

/** @param {IDBDatabase} db @param {string} name @returns {Promise<any>} */
export function getSetting(db, name) {
  return request(db.transaction('settings').objectStore('settings').get(name));
}

/** @param {IDBDatabase} db @param {string} name @param {any} value */
export async function setSetting(db, name, value) {
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put(value, name);
  await done(tx);
}

/**
 * Ask the browser to keep this site's storage under pressure (design §3.3). Chromium and Safari
 * answer silently, Firefox prompts, so call it from a user action. Not called automatically yet.
 * @returns {Promise<boolean>} true if storage is (now) persistent
 */
export async function requestPersistence(nav = globalThis.navigator) {
  if (!nav?.storage?.persist) return false;
  if (await nav.storage.persisted?.()) return true;
  return nav.storage.persist();
}

// ---- evals + results + positions (analysis coordinator, slice 5) ----

/**
 * @typedef {[string|null, number]} EvalLine
 * @typedef {{engineId: string, fenKey: string, depth: number, multipv: number, lines: EvalLine[]}} EvalRow
 * @typedef {{userId: string, runKey: string, gameId: string, createdAt: number, color: 'white'|'black'|null,
 *   reached: string[], mistake: object|null}} ResultRow  color null: the game had no result (not his, no moves)
 */

/**
 * One cached search, or undefined.
 * @param {IDBDatabase} db @param {string} engineId @param {string} key @param {number} depth @param {number} multipv
 * @returns {Promise<EvalRow|undefined>}
 */
export function getEval(db, engineId, key, depth, multipv) {
  return request(db.transaction('evals').objectStore('evals').get([engineId, key, depth, multipv]));
}

/**
 * Write cached searches and finished-game results in one transaction. A result row therefore never
 * commits without the evals that were written before it, so a resume can trust it.
 * @param {IDBDatabase} db @param {{evals?: EvalRow[], results?: ResultRow[]}} batch
 */
export async function writeAnalysisBatch(db, { evals = [], results = [] }) {
  if (!evals.length && !results.length) return;
  const tx = db.transaction(['evals', 'results'], 'readwrite');
  const committed = done(tx);
  try {
    for (const row of evals) tx.objectStore('evals').put(row);
    for (const row of results) tx.objectStore('results').put(row);
  } catch (err) {
    tx.abort();
    committed.catch(() => {});
    throw err;
  }
  await committed;
}

/** Every result row of one user and run. @param {IDBDatabase} db @param {string} user @param {string} runKey @returns {Promise<ResultRow[]>} */
export function getResults(db, user, runKey) {
  const userId = userIdOf(user);
  return request(db.transaction('results').objectStore('results').getAll(IDBKeyRange.bound([userId, runKey], [userId, runKey, []])));
}

/** The positions.json document of a user, or undefined. @param {IDBDatabase} db @param {string} user */
export function getPositions(db, user) {
  return request(db.transaction('positions').objectStore('positions').get(userIdOf(user)));
}

/** @param {IDBDatabase} db @param {string} user @param {object} doc */
export async function putPositions(db, user, doc) {
  const tx = db.transaction('positions', 'readwrite');
  tx.objectStore('positions').put(doc, userIdOf(user));
  await done(tx);
}
