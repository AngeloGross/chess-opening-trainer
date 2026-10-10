// Backup export and imports against IndexedDB + localStorage (web/store/backupStore.js, slice 8).
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { readAnalysisFile } from '../web/core/backup.js';
import { loadIntended, saveIntended, statsKeyFor } from '../web/core/trainerList.js';
import { applyImport, collectBackup, existingOf, importMarkerName, readStats } from '../web/store/backupStore.js';
import {
  exportUserData, getFetchState, getGames, getPositions, getSetting, openDb, putFetchState, putGames, putPositions,
  setSetting, storageInfo, writeAnalysisBatch,
} from '../web/store/db.js';
import { POSITIONS, STATS, makeDoc, memoryStorage } from './backupFixtures.js';

const game = (id, ts) => ({ id, createdAt: ts, perf: 'blitz', variant: 'standard', moves: 'e4 e5', players: {}, opening: {} });
const evalRow = (k) => ({ engineId: 'SF19 lite', fenKey: k, depth: 14, multipv: 1, lines: [['e2e4', 20]] });
const resultRow = (gameId) => ({ userId: 'angelogro', runKey: 'r1-a', gameId, createdAt: 1, color: 'white', reached: [], mistake: null });

let db;
let storage;
beforeEach(async () => {
  db = await openDb({ factory: new IDBFactory() });
  storage = memoryStorage({ [statsKeyFor('AngelOgro')]: JSON.stringify(STATS) });
});

/** A browser that analysed AngelOgro: games, fetch state, results, evals, the document and stats. */
async function analysedBrowser() {
  await putGames(db, 'AngelOgro', [game('g1', 1), game('g2', 2)]);
  await putFetchState(db, 'AngelOgro', { user: 'AngelOgro', perfs: ['blitz'], oldestSeen: 1, newestSeen: 2, exhausted: false });
  await writeAnalysisBatch(db, { evals: [evalRow('a'), evalRow('b')], results: [resultRow('g1'), resultRow('g2')] });
  await putPositions(db, 'AngelOgro', makeDoc());
  await setSetting(db, 'analysisOptions', { maxGames: 60, depth: 12 });
}

/** A backup file's round trip: JSON text -> readAnalysisFile, like a real file. */
const asFile = (backup) => readAnalysisFile(JSON.stringify(backup));

describe('collectBackup', () => {
  it('small: the document on screen and the stats; full: plus games, fetch state, results and the eval cache', async () => {
    await analysedBrowser();
    const small = await collectBackup(db, storage, makeDoc(), 'small');
    expect(small).toMatchObject({ kind: 'small', user: 'AngelOgro', stats: STATS, settings: { analysisOptions: { maxGames: 60, depth: 12 } } });
    expect(small.positions).toEqual(makeDoc());
    expect(small).not.toHaveProperty('games');
    const full = await collectBackup(db, storage, makeDoc(), 'full');
    expect(full.games.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(full.results).toHaveLength(2);
    expect(full.evals).toHaveLength(2);
    expect(full.fetchState.newestSeen).toBe(2);
    expect(JSON.stringify(full).length).toBeGreaterThan(JSON.stringify(small).length);
  });

  it('exportUserData only returns the user asked for', async () => {
    await analysedBrowser();
    await putGames(db, 'Other', [game('o1', 5)]);
    expect((await exportUserData(db, 'angelogro', { full: true })).games.map((g) => g.id)).toEqual(['g1', 'g2']);
  });
});

describe('applyImport', () => {
  it('a full backup into a fresh browser restores everything; Update can resume (no import marker)', async () => {
    await analysedBrowser();
    const backup = await collectBackup(db, storage, makeDoc(), 'full');
    const fresh = await openDb({ factory: new IDBFactory() });
    const freshStorage = memoryStorage();
    const r = await applyImport(fresh, freshStorage, { kind: 'backup', backup: asFile(backup).backup }, 'replace');
    expect(r).toMatchObject({ user: 'AngelOgro', keptExisting: false, stats: 2, games: 2, marker: null });
    expect(await getPositions(fresh, 'angelogro')).toEqual(makeDoc());
    expect((await getGames(fresh, 'AngelOgro')).map((g) => g.id)).toEqual(['g1', 'g2']);
    expect((await getFetchState(fresh, 'AngelOgro')).newestSeen).toBe(2);
    expect((await exportUserData(fresh, 'AngelOgro', { full: true })).evals).toHaveLength(2);
    expect(readStats(freshStorage, 'AngelOgro')).toEqual(STATS);
    expect(freshStorage.data.has('opening-trainer:stats:angelogro')).toBe(true); // the per-user key
    expect(await getSetting(fresh, 'analysisOptions')).toEqual({ maxGames: 60, depth: 12 });
    expect(await getSetting(fresh, 'lastUser')).toBe('AngelOgro');
    expect(await getSetting(fresh, 'lastSource')).toBe('browser');
  });

  it('a small backup into a fresh browser: document + stats, marked as imported', async () => {
    const backup = await collectBackup(db, storage, makeDoc(), 'small');
    const fresh = await openDb({ factory: new IDBFactory() });
    const s = memoryStorage();
    const r = await applyImport(fresh, s, { kind: 'backup', backup }, 'replace');
    expect(r.marker).toMatchObject({ kind: 'backup', positions: 4, total: 4 });
    expect(await getSetting(fresh, importMarkerName('AngelOgro'))).toEqual(r.marker);
    expect(readStats(s, 'angelogro')).toEqual(STATS);
  });

  it('merge keeps the newer analysis and the stats with more tries; importing twice changes nothing', async () => {
    await analysedBrowser();
    const older = makeDoc('AngelOgro', POSITIONS.slice(0, 1), '2026-01-01T00:00:00+00:00');
    const incomingStats = { [POSITIONS[0].key]: { tries: 1, solved: 0, failed: 1, last: 'failed' }, newkey: { tries: 4, solved: 4, failed: 0, last: 'solved' } };
    const backup = { format: 'opening-trainer-backup', version: 1, kind: 'small', exported: '2026-01-01T00:00:00Z', user: 'AngelOgro', positions: older, stats: incomingStats, settings: { analysisOptions: { maxGames: 9, depth: 10 } } };
    const r = await applyImport(db, storage, { kind: 'backup', backup }, 'merge');
    expect(r.keptExisting).toBe(true);
    expect((await getPositions(db, 'AngelOgro')).positions).toHaveLength(4);
    const stats = readStats(storage, 'AngelOgro');
    expect(stats[POSITIONS[0].key]).toEqual(STATS[POSITIONS[0].key]); // 3 tries beat 1
    expect(stats.newkey.tries).toBe(4);
    expect(await getSetting(db, 'analysisOptions')).toEqual({ maxGames: 60, depth: 12 }); // merge keeps settings
    expect(await getSetting(db, importMarkerName('AngelOgro'))).toBeNull(); // the browser analysis stays unmarked
    await applyImport(db, storage, { kind: 'backup', backup }, 'merge');
    expect(readStats(storage, 'AngelOgro')).toEqual(stats);
  });

  it('replace overwrites the analysis and the stats', async () => {
    await analysedBrowser();
    const older = makeDoc('AngelOgro', POSITIONS.slice(0, 1), '2026-01-01T00:00:00+00:00');
    const backup = { format: 'opening-trainer-backup', version: 1, kind: 'small', exported: '2026-01-01T00:00:00Z', user: 'AngelOgro', positions: older, stats: {}, settings: {} };
    await applyImport(db, storage, { kind: 'backup', backup }, 'replace');
    expect((await getPositions(db, 'AngelOgro')).positions).toHaveLength(1);
    expect(readStats(storage, 'AngelOgro')).toEqual({});
    expect((await getGames(db, 'AngelOgro')).length).toBe(2); // a small backup brings no games, so they stay
  });

  it('a CLI positions.json: trainable for its user, stats untouched, marked as a loaded file', async () => {
    const file = readAnalysisFile(JSON.stringify(makeDoc('Friend_1')));
    storage.setItem(statsKeyFor('Friend_1'), JSON.stringify(STATS));
    const r = await applyImport(db, storage, { kind: 'positions', doc: file.doc }, 'replace');
    expect(r.marker).toMatchObject({ kind: 'positions', positions: 4 });
    expect(await getPositions(db, 'friend_1')).toEqual(makeDoc('Friend_1'));
    expect(readStats(storage, 'Friend_1')).toEqual(STATS);
    expect(await getSetting(db, 'lastUser')).toBe('Friend_1');
  });

  it('a link with the top positions merges its stats and never shrinks a complete copy', async () => {
    await putPositions(db, 'AngelOgro', makeDoc());
    const top = makeDoc('AngelOgro', POSITIONS.slice(0, 2));
    const linkStats = { [POSITIONS[1].key]: { tries: 2, solved: 2, failed: 0, last: 'solved' } };
    const r = await applyImport(db, storage, { kind: 'link', doc: top, stats: linkStats, total: 4 }, 'merge');
    expect(r.keptExisting).toBe(true);
    expect((await getPositions(db, 'AngelOgro')).positions).toHaveLength(4);
    expect(Object.keys(readStats(storage, 'AngelOgro')).sort()).toEqual([POSITIONS[0].key, POSITIONS[1].key, POSITIONS[2].key].sort());

    const fresh = await openDb({ factory: new IDBFactory() });
    const r2 = await applyImport(fresh, memoryStorage(), { kind: 'link', doc: top, stats: linkStats, total: 4 }, 'merge');
    expect(r2.marker).toMatchObject({ kind: 'link', positions: 2, total: 4 });
  });

  it('existingOf describes what is stored', async () => {
    expect(await existingOf(db, storage, 'AngelOgro')).toEqual({ doc: null, stats: 2 });
    await putPositions(db, 'AngelOgro', makeDoc());
    expect((await existingOf(db, storage, 'AngelOgro')).doc.positions).toHaveLength(4);
  });
});

describe('storageInfo', () => {
  it('degrades without a StorageManager (insecure origin) and reads persisted + estimate', async () => {
    expect(await storageInfo({})).toEqual({ supported: false, persisted: null, usage: null, quota: null });
    const nav = { storage: { persisted: async () => true, estimate: async () => ({ usage: 1234, quota: 5e9 }) } };
    expect(await storageInfo(nav)).toEqual({ supported: true, persisted: true, usage: 1234, quota: 5e9 });
    const failing = { storage: { persisted: async () => { throw new Error('x'); } } };
    expect(await storageInfo(failing)).toEqual({ supported: true, persisted: null, usage: null, quota: null });
  });
});

describe('moves marked as intended', () => {
  const marks = (s) => [...loadIntended(s, 'AngelOgro')].sort();

  it('travel in the backup and merge or replace on import', async () => {
    await analysedBrowser();
    saveIntended(storage, 'AngelOgro', ['k|a']);
    const { backup } = await asFile(await collectBackup(db, storage, makeDoc(), 'small'));
    expect(backup.settings.intended).toEqual(['k|a']);

    const other = memoryStorage();
    saveIntended(other, 'AngelOgro', ['k|b']);
    await applyImport(await openDb({ factory: new IDBFactory() }), other, { kind: 'backup', backup }, 'merge');
    expect(marks(other)).toEqual(['k|a', 'k|b']);
    await applyImport(await openDb({ factory: new IDBFactory() }), other, { kind: 'backup', backup }, 'replace');
    expect(marks(other)).toEqual(['k|a']);
    await applyImport(await openDb({ factory: new IDBFactory() }), other, { kind: 'backup', backup: { ...backup, settings: {} } }, 'replace');
    expect(marks(other)).toEqual([]);
  });

  it('a CLI file leaves them alone', async () => {
    saveIntended(storage, 'AngelOgro', ['k|a']);
    await applyImport(db, storage, { kind: 'positions', doc: makeDoc() }, 'replace');
    expect(marks(storage)).toEqual(['k|a']);
  });
});
