// Trainer list logic (web/core/trainerList.js): filters, per-user stats key, and merging a new document
// into the list on screen during an analysis (design slice 6).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SORT, LEGACY_STATS_KEY, SORT_KEY, filterPositions, intendedKeyFor, isIntendedIn, loadIntended, loadSort, loadStats,
  mergeList, openingCounts, saveIntended, sortPositions, statsKeyFor, usualMove,
} from '../web/core/trainerList.js';

const pos = (key, opening = 'Sicilian', orientation = 'white') => ({ key, opening, orientation });
const ALL = { opening: '', color: '', unsolved: false };
const never = () => false;
const keys = (list) => list.map((p) => p.key);

function memoryStorage(init = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

describe('statsKeyFor / loadStats', () => {
  it('keys stats by the lower-cased user', () => {
    expect(statsKeyFor('AngelOgro')).toBe('opening-trainer:stats:angelogro');
    expect(statsKeyFor(' Bob ')).toBe('opening-trainer:stats:bob');
    expect(statsKeyFor(undefined)).toBe(LEGACY_STATS_KEY);
  });

  it('reads the user key and ignores other users', () => {
    const storage = memoryStorage({ 'opening-trainer:stats:bob': '{"k1":{"last":"solved"}}', 'opening-trainer:stats:eve': '{"k2":{}}' });
    expect(loadStats(storage, 'Bob')).toEqual({ k1: { last: 'solved' } });
    expect(loadStats(storage, 'nobody')).toEqual({});
  });

  it('moves legacy stats to the user of a CLI document once', () => {
    const storage = memoryStorage({ [LEGACY_STATS_KEY]: '{"k":{"last":"failed"}}' });
    expect(loadStats(storage, 'Bob')).toEqual({}); // not a CLI document: no migration
    expect(loadStats(storage, 'Bob', { migrateLegacy: true })).toEqual({ k: { last: 'failed' } });
    expect(storage.data.has(LEGACY_STATS_KEY)).toBe(false);
    expect(storage.data.get('opening-trainer:stats:bob')).toBe('{"k":{"last":"failed"}}');
  });

  it('never overwrites existing user stats with legacy ones', () => {
    const storage = memoryStorage({ [LEGACY_STATS_KEY]: '{"old":{}}', 'opening-trainer:stats:bob': '{"new":{}}' });
    expect(loadStats(storage, 'bob', { migrateLegacy: true })).toEqual({ new: {} });
    expect(storage.data.has(LEGACY_STATS_KEY)).toBe(true);
  });

  it('survives blocked or broken storage', () => {
    const blocked = { getItem() { throw new Error('denied'); }, setItem() {}, removeItem() {} };
    expect(loadStats(blocked, 'bob')).toEqual({});
    expect(loadStats(memoryStorage({ 'opening-trainer:stats:bob': '{not json' }), 'bob')).toEqual({});
    expect(loadStats(memoryStorage({ 'opening-trainer:stats:bob': '42' }), 'bob')).toEqual({});
  });
});

describe('filterPositions / openingCounts', () => {
  const list = [pos('a', 'Sicilian', 'white'), pos('b', 'French', 'black'), pos('c', 'Sicilian', 'black')];

  it('filters by opening, colour and unsolved', () => {
    expect(keys(filterPositions(list, ALL, never))).toEqual(['a', 'b', 'c']);
    expect(keys(filterPositions(list, { ...ALL, opening: 'Sicilian' }, never))).toEqual(['a', 'c']);
    expect(keys(filterPositions(list, { ...ALL, color: 'black' }, never))).toEqual(['b', 'c']);
    expect(keys(filterPositions(list, { ...ALL, unsolved: true }, (p) => p.key === 'a'))).toEqual(['b', 'c']);
  });

  it('counts openings, most first, then by name', () => {
    expect(openingCounts([...list, pos('d', 'Caro-Kann')])).toEqual([['Sicilian', 2], ['Caro-Kann', 1], ['French', 1]]);
  });
});

describe('mergeList (update during an analysis)', () => {
  it('starts at the first entry when nothing was shown', () => {
    expect(mergeList({ positions: [pos('a'), pos('b')], filters: ALL, isSolved: never, filtered: [], index: -1 }))
      .toEqual({ filtered: [pos('a'), pos('b')], index: 0 });
    expect(mergeList({ positions: [], filters: ALL, isSolved: never, filtered: [], index: -1 }))
      .toEqual({ filtered: [], index: -1 });
  });

  it('grows the list in the new ranking and keeps the current position by key', () => {
    const before = [pos('a'), pos('b'), pos('c')];
    const after = [pos('d'), pos('b'), pos('a'), pos('e'), pos('c')];
    const merged = mergeList({ positions: after, filters: ALL, isSolved: never, filtered: before, index: 2 });
    expect(keys(merged.filtered)).toEqual(['d', 'b', 'a', 'e', 'c']);
    expect(merged.filtered[merged.index].key).toBe('c');
  });

  it('hands out the new entry object for the current key (newer accept window)', () => {
    const old = { ...pos('a'), acceptable: ['e2e4'] };
    const fresh = { ...pos('a'), acceptable: ['e2e4', 'd2d4'] };
    const merged = mergeList({ positions: [fresh], filters: ALL, isSolved: never, filtered: [old], index: 0 });
    expect(merged.filtered[merged.index]).toBe(fresh);
  });

  it('applies the filters to new entries only', () => {
    const filters = { ...ALL, opening: 'French' };
    const before = [pos('b', 'French')];
    const after = [pos('a', 'Sicilian'), pos('b', 'French'), pos('c', 'French'), pos('d', 'Sicilian')];
    const merged = mergeList({ positions: after, filters, isSolved: never, filtered: before, index: 0 });
    expect(keys(merged.filtered)).toEqual(['b', 'c']);
    expect(merged.index).toBe(0);
  });

  it('keeps a position solved under "Unsolved only" until the filters change', () => {
    const filters = { ...ALL, unsolved: true };
    const solved = new Set(['a']); // just solved on the board
    const isSolved = (p) => solved.has(p.key);
    const before = [pos('a'), pos('b')];
    const after = [pos('x'), pos('a'), pos('b'), pos('y')];
    solved.add('y'); // solved earlier in another session, new in the document: filtered out
    const merged = mergeList({ positions: after, filters, isSolved, filtered: before, index: 0 });
    expect(keys(merged.filtered)).toEqual(['x', 'a', 'b']);
    expect(merged.filtered[merged.index].key).toBe('a');
  });

  it('keeps the current entry at its place when the new document lost it', () => {
    const before = [pos('a'), pos('b'), pos('c')];
    const after = [pos('a'), pos('c'), pos('d')];
    const merged = mergeList({ positions: after, filters: ALL, isSolved: never, filtered: before, index: 1 });
    expect(keys(merged.filtered)).toEqual(['a', 'b', 'c', 'd']);
    expect(merged.index).toBe(1);
  });

  it('drops a non-current entry the new document lost', () => {
    const merged = mergeList({ positions: [pos('a')], filters: ALL, isSolved: never, filtered: [pos('a'), pos('b')], index: 0 });
    expect(keys(merged.filtered)).toEqual(['a']);
  });
});

describe('sort orders', () => {
  const e = (key, errors, reached, score, avgLoss) => ({ key, errors, reached, score, avg_loss: avgLoss });
  const list = [e('a', 2, 9, 300, 150), e('b', 5, 6, 150, 30), e('c', 5, 8, 100, 20), e('d', 1, 1, 500, 500)];

  it('defaults to most often wrong, ties by reached, then score', () => {
    expect(DEFAULT_SORT).toBe('frequent');
    expect(keys(sortPositions(list, 'frequent'))).toEqual(['c', 'b', 'a', 'd']);
    expect(keys(sortPositions(list, 'nonsense'))).toEqual(['c', 'b', 'a', 'd']);
  });

  it('by score and by average loss; the input stays as it was', () => {
    expect(keys(sortPositions(list, 'score'))).toEqual(['d', 'a', 'b', 'c']);
    expect(keys(sortPositions(list, 'loss'))).toEqual(['d', 'a', 'b', 'c']);
    expect(keys(list)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('remembers a known order only', () => {
    expect(loadSort(memoryStorage({ [SORT_KEY]: 'loss' }))).toBe('loss');
    expect(loadSort(memoryStorage({ [SORT_KEY]: 'x' }))).toBe('frequent');
    expect(loadSort(null)).toBe('frequent');
  });
});

describe('moves marked as intended', () => {
  const p = (key, ...ucis) => ({ ...pos(key), played: ucis.map((uci) => ({ uci, san: uci })) });
  const marked = new Set(['k1|g2g4']);
  const isIntended = (x) => isIntendedIn(x, marked);

  it('is about the usual move only', () => {
    expect(usualMove(p('k1', 'g2g4', 'h2h4'))).toEqual({ id: 'k1|g2g4', san: 'g2g4' });
    expect(usualMove(p('k1'))).toBe(null);
    expect(isIntended(p('k1', 'g2g4', 'h2h4'))).toBe(true);
    expect(isIntended(p('k1', 'h2h4', 'g2g4'))).toBe(false);
    expect(isIntended(p('k2', 'g2g4'))).toBe(false);
  });

  it('hides marked positions unless "Show intended" is on, also in a merge', () => {
    const list = [p('k1', 'g2g4'), p('k2', 'a2a3')];
    expect(keys(filterPositions(list, ALL, never, isIntended))).toEqual(['k2']);
    expect(keys(filterPositions(list, { ...ALL, intended: true }, never, isIntended))).toEqual(['k1', 'k2']);
    const merged = mergeList({ positions: list, filters: ALL, isSolved: never, isIntended, filtered: [], index: -1 });
    expect(keys(merged.filtered)).toEqual(['k2']);
  });

  it('is stored per user, sorted, and removed when empty', () => {
    const storage = memoryStorage();
    saveIntended(storage, 'AngelOgro', ['b|x', 'a|y', 'a|y']);
    expect(storage.data.get(intendedKeyFor('angelogro'))).toBe('["a|y","b|x"]');
    expect(loadIntended(storage, 'ANGELOGRO')).toEqual(new Set(['a|y', 'b|x']));
    expect(loadIntended(storage, 'Bob')).toEqual(new Set());
    saveIntended(storage, 'AngelOgro', []);
    expect(storage.data.has(intendedKeyFor('angelogro'))).toBe(false);
    expect(loadIntended(memoryStorage({ [intendedKeyFor('x')]: '{bad' }), 'x')).toEqual(new Set());
  });
});
