// Backup export and the three imports (backup file, CLI positions.json, "Send to phone" link) against
// IndexedDB plus the per-user quiz stats in localStorage (slice 8). No DOM: dataPanel.js and app.js call
// it, vitest runs it with fake-indexeddb and a memory storage.
//
// Import marker: setting `imported:<userId>` = {kind, at, positions, total} | null. Set when the shown
// document came from a file or link without the games behind it (CLI file, small backup, link): the
// app then says "Imported …" instead of "Analysed in this browser" and hides "Update", whose analysis
// would replace the imported document with a fresh (possibly partial) one. A full backup or a new
// browser analysis clears it.
import { buildBackup, choosePositions, cleanStats, mergeStats } from '../core/backup.js';
import { statsKeyFor } from '../core/trainerList.js';
import { exportUserData, getPositions, getSetting, importUserData, setSetting, userIdOf } from './db.js';

export const OPTIONS_SETTING = 'analysisOptions';
export const importMarkerName = (user) => `imported:${userIdOf(user)}`;

/** @param {Pick<Storage, 'getItem'>} storage @param {string} user */
export function readStats(storage, user) {
  try {
    return cleanStats(JSON.parse(storage.getItem(statsKeyFor(user)) ?? 'null'));
  } catch {
    return {};
  }
}

/** @param {Pick<Storage, 'setItem'>} storage @param {string} user @param {Record<string, any>} stats */
function writeStats(storage, user, stats) {
  storage.setItem(statsKeyFor(user), JSON.stringify(stats));
}

/**
 * The backup object of `doc`'s user. `doc` is the document on screen (it may be the CLI's file, which is
 * not in IndexedDB); a full backup adds the stored games, fetch state, results and the eval cache.
 * @param {IDBDatabase} db @param {Pick<Storage, 'getItem'>} storage @param {any} doc @param {'small'|'full'} kind
 */
export async function collectBackup(db, storage, doc, kind) {
  const user = doc.user;
  const stored = await exportUserData(db, user, { full: kind === 'full' });
  const analysisOptions = await getSetting(db, OPTIONS_SETTING);
  return buildBackup({
    kind, user, ...stored, positions: doc, stats: readStats(storage, user),
    settings: analysisOptions ? { analysisOptions } : {},
  });
}

/**
 * What this browser already has of `user`, for the confirmation.
 * @returns {Promise<{doc: any|null, stats: number}>}
 */
export async function existingOf(db, storage, user) {
  return { doc: (await getPositions(db, user)) ?? null, stats: Object.keys(readStats(storage, user)).length };
}

/**
 * @typedef {{kind: 'backup', backup: any} | {kind: 'positions', doc: any} | {kind: 'link', doc: any, stats: Record<string, any>, total: number}} Incoming
 * @typedef {{user: string, doc: any|null, keptExisting: boolean, stats: number, games: number, marker: any}} ImportResult
 */

/**
 * Apply an import. Merge: newer analysis and the stats entry with more tries win, rows are upserted.
 * Replace: the file's analysis and stats overwrite this browser's (a CLI file has no stats, so the
 * friend's stats stay; they are keyed by position and still apply).
 * @param {IDBDatabase} db @param {Pick<Storage, 'getItem'|'setItem'>} storage @param {Incoming} incoming
 * @param {'merge'|'replace'} mode
 * @returns {Promise<ImportResult>}
 */
export async function applyImport(db, storage, incoming, mode) {
  const backup = incoming.kind === 'backup' ? incoming.backup : null;
  const user = backup ? backup.user : incoming.doc.user;
  const newDoc = backup ? backup.positions ?? null : incoming.doc;
  const newStats = backup ? cleanStats(backup.stats) : incoming.kind === 'link' ? cleanStats(incoming.stats) : null;
  const full = backup?.kind === 'full';

  const existing = (await getPositions(db, user)) ?? null;
  const doc = choosePositions(existing, newDoc, mode);
  const keptExisting = !!existing && doc === existing;

  /** @type {any} */
  const data = { positions: doc };
  if (full) Object.assign(data, { fetchState: backup.fetchState ?? null, games: backup.games ?? [], results: backup.results ?? [], evals: backup.evals ?? [] });
  await importUserData(db, user, data, mode);

  let stats = readStats(storage, user);
  if (newStats) stats = mode === 'replace' ? newStats : mergeStats(stats, newStats);
  try {
    writeStats(storage, user, stats);
  } catch {
    // storage blocked: the analysis is imported, stats are not
  }

  const options = backup?.settings?.analysisOptions;
  if (options && typeof options === 'object' && (mode === 'replace' || !(await getSetting(db, OPTIONS_SETTING)))) {
    await setSetting(db, OPTIONS_SETTING, options);
  }

  // The marker follows the document that is now stored.
  const markerName = importMarkerName(user);
  let marker = await getSetting(db, markerName) ?? null;
  if (doc && !keptExisting) {
    marker = full ? null : {
      kind: incoming.kind === 'backup' ? 'backup' : incoming.kind,
      at: new Date().toISOString(),
      positions: doc.positions.length,
      total: incoming.kind === 'link' ? incoming.total : doc.positions.length,
    };
  } else if (!doc) marker = null;
  await setSetting(db, markerName, marker);
  if (doc) {
    await setSetting(db, 'lastUser', user);
    await setSetting(db, 'lastSource', 'browser');
  }
  return { user, doc, keptExisting, stats: Object.keys(stats).length, games: full ? backup.games?.length ?? 0 : 0, marker };
}
