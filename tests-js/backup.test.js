// Backup format and "Load analysis file" (web/core/backup.js, slice 8): build, read, validate, merge.
import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT, BACKUP_VERSION, ImportError, backupFileName, buildBackup, choosePositions, cleanStats,
  describeFile, formatBytes, mergeStats, readAnalysisFile, validatePositionsDoc,
} from '../web/core/backup.js';
import { POSITIONS, STATS, makeDoc } from './backupFixtures.js';

const small = (extra = {}) => buildBackup({
  kind: 'small', user: 'AngelOgro', positions: makeDoc(), stats: STATS,
  settings: { analysisOptions: { maxGames: 500, depth: 14 } }, exported: new Date('2026-10-08T10:00:00Z'), ...extra,
});
const full = () => buildBackup({
  kind: 'full', user: 'AngelOgro', positions: makeDoc(), stats: STATS, exported: new Date('2026-10-08T10:00:00Z'),
  fetchState: { userId: 'angelogro', user: 'AngelOgro', perfs: ['blitz'], oldestSeen: 1, newestSeen: 2, exhausted: false },
  games: [{ userId: 'angelogro', id: 'g1', createdAt: 1, perf: 'blitz', moves: 'e4' }],
  results: [{ userId: 'angelogro', runKey: 'r1-x', gameId: 'g1', createdAt: 1, color: 'white', reached: [], mistake: null }],
  evals: [{ engineId: 'SF', fenKey: 'k', depth: 14, multipv: 1, lines: [['e2e4', 20]] }],
});
/** readAnalysisFile of a value, expecting an ImportError; returns its message. */
const errorOf = (value) => {
  try {
    readAnalysisFile(typeof value === 'string' ? value : JSON.stringify(value));
  } catch (err) {
    expect(err).toBeInstanceOf(ImportError);
    return err.message;
  }
  throw new Error('no error');
};

describe('buildBackup / backupFileName', () => {
  it('writes format, version, kind, user, the document and the stats', () => {
    const b = small();
    expect(b).toMatchObject({ format: BACKUP_FORMAT, version: 1, kind: 'small', user: 'AngelOgro', exported: '2026-10-08T10:00:00.000Z' });
    expect(b.positions).toEqual(makeDoc());
    expect(b.stats).toEqual(STATS);
    expect(b.settings).toEqual({ analysisOptions: { maxGames: 500, depth: 14 } });
    expect(b).not.toHaveProperty('games');
    expect(full()).toHaveProperty('evals');
    expect(BACKUP_VERSION).toBe(1);
  });

  it('names the file after the lower-cased user and the local date', () => {
    expect(backupFileName('AngelOgro', new Date(2026, 9, 8, 23, 59))).toBe('opening-trainer-angelogro-2026-10-08.json');
    expect(backupFileName('', new Date(2026, 0, 2))).toBe('opening-trainer-unknown-2026-01-02.json');
  });

  it('formats sizes', () => {
    expect([formatBytes(800), formatBytes(34_360), formatBytes(1_234_567), formatBytes(3e9)]).toEqual(['800 B', '34 KB', '1.2 MB', '3.0 GB']);
  });
});

describe('readAnalysisFile', () => {
  it('reads a small and a full backup (also with a byte-order mark)', () => {
    const r = readAnalysisFile(JSON.stringify(small()));
    expect(r.type).toBe('backup');
    expect(r.user).toBe('AngelOgro');
    expect(readAnalysisFile('﻿' + JSON.stringify(full())).backup.games).toHaveLength(1);
    expect(describeFile(readAnalysisFile(JSON.stringify(full())))).toMatch(/^Full backup of AngelOgro.*4 positions, stats for 2 positions, 1 games, 1 engine results\.$/);
  });

  it('reads the CLI positions.json shape as it is', () => {
    const r = readAnalysisFile(JSON.stringify(makeDoc(), null, 2));
    expect(r).toEqual({ type: 'positions', user: 'AngelOgro', doc: makeDoc() });
    expect(describeFile(r)).toBe('Analysis of AngelOgro from the command line: 4 positions from 500 games.');
  });

  it('gives a readable error for files that are not JSON or not ours', () => {
    expect(errorOf('')).toBe('The file is empty.');
    expect(errorOf('{"positions": [')).toMatch(/^This is not a trainer file: it is not valid JSON \(/);
    expect(errorOf('\u0000\u0001binary')).toMatch(/not valid JSON/);
    expect(errorOf([1, 2])).toMatch(/expected a backup or a positions\.json/);
    expect(errorOf('"text"')).toMatch(/expected a backup or a positions\.json/);
    expect(errorOf({ hello: 1 })).toMatch(/neither "format" nor "positions"/);
    expect(errorOf({ format: 'something-else', positions: [] })).toBe('This is not a trainer file (format "something-else").');
  });

  it('checks the version: newer formats are refused with a hint', () => {
    expect(errorOf({ ...small(), version: 2 })).toMatch(/newer version of the trainer \(format 2\); this page reads format 1/);
    expect(errorOf({ ...small(), version: undefined })).toBe('The backup has no format version.');
    expect(errorOf({ ...small(), version: 0 })).toBe('Unknown backup format version 0.');
  });

  it('refuses damaged backups', () => {
    expect(errorOf({ ...small(), kind: 'medium' })).toMatch(/"kind" must be/);
    expect(errorOf({ ...small(), user: 'a b' })).toMatch(/no valid Lichess name/);
    expect(errorOf({ ...small(), user: 'Other' })).toMatch(/its analysis is of AngelOgro, not Other/);
    expect(errorOf({ ...small(), stats: [] })).toMatch(/"stats" is not an object/);
    expect(errorOf({ ...small(), positions: null, stats: {} })).toMatch(/is empty/);
    expect(errorOf({ ...full(), games: {} })).toMatch(/"games" is not a list/);
    expect(errorOf({ ...full(), games: [{ userId: 'someone', id: 'g', createdAt: 1 }] })).toMatch(/data of another user \(someone\)/);
    expect(errorOf({ ...full(), evals: [{ engineId: 'SF' }] })).toMatch(/entry 1 of "evals" is invalid/);
    expect(errorOf({ ...full(), fetchState: { userId: 'x' } })).toMatch(/"fetchState" is invalid/);
  });

  it('refuses positions documents the trainer could not show, naming the position and field', () => {
    const broken = (i, patch) => {
      const doc = makeDoc();
      Object.assign(doc.positions[i], patch);
      return doc;
    };
    expect(errorOf(broken(1, { fen: 'not a fen' }))).toBe('The positions.json is damaged: position 2 has an invalid "fen".');
    expect(errorOf(broken(0, { key: 'x' }))).toMatch(/position 1 has an invalid "key"/);
    expect(errorOf(broken(0, { best: 'h1h8' }))).toMatch(/invalid "best"/);
    expect(errorOf(broken(0, { acceptable: [] }))).toMatch(/invalid "acceptable"/);
    expect(errorOf(broken(0, { played: [{ uci: 'e4' }] }))).toMatch(/invalid "played"/);
    expect(errorOf(broken(0, { games: 'x' }))).toMatch(/invalid "games"/);
    expect(errorOf(broken(0, { score: '378' }))).toMatch(/invalid "score"/);
    expect(errorOf(broken(0, { orientation: 'red' }))).toMatch(/invalid "orientation"/);
    expect(errorOf({ ...makeDoc(), user: undefined })).toMatch(/does not say whose games it is/);
    expect(errorOf({ ...makeDoc(), positions: [null] })).toMatch(/position 1 has an invalid "entry"/);
    expect(() => validatePositionsDoc(makeDoc())).not.toThrow();
    expect(() => validatePositionsDoc({ ...makeDoc(), positions: [] })).not.toThrow(); // an empty analysis is still one
  });
});

describe('merge rules', () => {
  it('stats: per position the entry with more tries wins, the incoming one on a tie; idempotent', () => {
    const mine = { a: { tries: 5, solved: 5, failed: 0, last: 'solved' }, b: { tries: 1, solved: 1, failed: 0, last: 'solved' } };
    const theirs = { a: { tries: 2, solved: 0, failed: 2, last: 'failed' }, b: { tries: 1, solved: 0, failed: 1, last: 'failed' }, c: { tries: 1, solved: 1, failed: 0, last: 'solved' } };
    const merged = mergeStats(mine, theirs);
    expect(merged).toEqual({ a: mine.a, b: theirs.b, c: theirs.c });
    expect(mergeStats(merged, theirs)).toEqual(merged);
  });

  it('stats: malformed entries are dropped, never an error', () => {
    expect(cleanStats({ a: { tries: 'x' }, b: null, c: { tries: 0 }, d: { tries: 2, solved: 1, last: 'odd' } }))
      .toEqual({ d: { tries: 2, solved: 1, failed: 0, last: 'failed' } });
    expect(cleanStats('nope')).toEqual({});
  });

  it('positions: replace takes the file; merge the newer analysis, on a tie the larger one', () => {
    const old = makeDoc('AngelOgro', POSITIONS, '2026-10-01T00:00:00+00:00');
    const neu = makeDoc('AngelOgro', POSITIONS.slice(0, 2), '2026-10-08T00:00:00+00:00');
    expect(choosePositions(neu, old, 'replace')).toBe(old);
    expect(choosePositions(neu, old, 'merge')).toBe(neu);
    expect(choosePositions(old, neu, 'merge')).toBe(neu);
    expect(choosePositions(null, old, 'merge')).toBe(old);
    expect(choosePositions(old, null, 'merge')).toBe(old);
    expect(choosePositions(old, null, 'replace')).toBeNull();
    const top2 = makeDoc('AngelOgro', POSITIONS.slice(0, 2), old.generated); // a link with the top positions only
    expect(choosePositions(old, top2, 'merge')).toBe(old);
    expect(choosePositions(top2, old, 'merge')).toBe(old);
  });
});
