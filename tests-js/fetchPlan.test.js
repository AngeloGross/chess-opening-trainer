// Port of the pure cases of tests/test_fetch.py, one to one (same names, same numbers).
import { describe, expect, it } from 'vitest';
import { Batch, Cursor, StoreState, backfillParams, isSupported, newerParams } from '../web/core/fetchPlan.js';

const PERFS = ['blitz', 'rapid', 'classical'];
const NO_CURSOR = new Cursor();

function state(timestamps = [], perf = 'blitz') {
  return StoreState.fromGames(timestamps.map((ts, i) => ({ id: String(i), perf, createdAt: ts })), PERFS);
}

describe('newerParams / backfillParams (test_fetch.py)', () => {
  it('empty store fetches most recent max games', () => {
    const s = state();
    expect(newerParams(s, NO_CURSOR)).toBeNull();
    expect(backfillParams(s, NO_CURSOR, 2000, null)).toEqual({ sort: 'dateDesc', max: 2000 });
  });

  it('newer games start after newest stored', () => {
    expect(newerParams(state([1000, 3000, 2000]), NO_CURSOR)).toEqual({ since: 3001, sort: 'dateAsc' });
  });

  it('newer games respect since', () => {
    expect(newerParams(state([1000]), NO_CURSOR, 5000)).toEqual({ since: 5000, sort: 'dateAsc' });
    expect(newerParams(state([9000]), NO_CURSOR, 5000)).toEqual({ since: 9001, sort: 'dateAsc' });
  });

  it('back-fills older games until oldest minus one', () => {
    expect(backfillParams(state([1000, 3000, 2000]), NO_CURSOR, 10, null)).toEqual({ sort: 'dateDesc', until: 999, max: 7 });
  });

  it('back-fill continues below skipped games', () => {
    const cursor = new Cursor({ oldestSeen: 400, newestSeen: 1000 });
    expect(backfillParams(state([1000]), cursor, 10, null)).toEqual({ sort: 'dateDesc', until: 399, max: 9 });
    expect(newerParams(state(), cursor)).toEqual({ since: 1001, sort: 'dateAsc' });
  });

  it('no back-fill when enough games stored or exhausted', () => {
    expect(backfillParams(state([1, 2, 3]), NO_CURSOR, 3, null)).toBeNull();
    expect(backfillParams(state([1, 2, 3]), NO_CURSOR, 2, null)).toBeNull();
    expect(backfillParams(state([1]), new Cursor({ exhausted: true }), 10, null)).toBeNull();
  });

  it('all games has no max', () => {
    expect(backfillParams(state([1000]), NO_CURSOR, null, null)).toEqual({ sort: 'dateDesc', until: 999 });
  });

  it('since bounds the back-fill', () => {
    expect(backfillParams(state([5000]), NO_CURSOR, null, 4000)).toEqual({ sort: 'dateDesc', until: 4999, since: 4000 });
    expect(backfillParams(state([3000, 5000]), NO_CURSOR, null, 4000)).toBeNull();
  });
});

describe('StoreState / isSupported (test_fetch.py)', () => {
  it('other perfs do not count', () => {
    const s = StoreState.fromGames(
      [{ id: 'a', perf: 'bullet', createdAt: 9 }, { id: 'b', perf: 'blitz', createdAt: 5 }], PERFS,
    );
    expect([s.count, s.newest, s.oldest, [...s.ids].sort()]).toEqual([1, 5, 5, ['a', 'b']]);
  });

  it('only standard games without initial FEN', () => {
    expect(isSupported({ variant: 'standard' })).toBe(true);
    expect(isSupported({ variant: 'chess960' })).toBe(false);
    expect(isSupported({ variant: 'fromPosition' })).toBe(false);
    expect(isSupported({ variant: 'standard', initialFen: '8/8/8/8/8/8/8/8 w - - 0 1' })).toBe(false);
  });
});

describe('Cursor.load (test_changed_perfs_reset_the_cursor)', () => {
  it('keeps a cursor for the same perf set and resets it for a changed one', () => {
    const saved = new Cursor({ perfs: ['blitz'], oldestSeen: 5, exhausted: true }).toJSON();
    expect(Cursor.load(saved, ['blitz']).oldestSeen).toBe(5);
    const reset = Cursor.load(saved, ['rapid', 'blitz']);
    expect([reset.perfs, reset.oldestSeen, reset.exhausted]).toEqual([['blitz', 'rapid'], null, false]);
    expect(reset.resetFrom).toEqual(['blitz']);
  });

  it('starts fresh when nothing usable is saved', () => {
    for (const saved of [undefined, null, 'x', { perfs: 'blitz' }, { perfs: ['blitz'], oldestSeen: 'old' }]) {
      const c = Cursor.load(saved, ['rapid', 'blitz']);
      expect(c.toJSON()).toEqual({ perfs: ['blitz', 'rapid'], oldestSeen: null, newestSeen: null, exhausted: false });
      expect(c.resetFrom).toBeNull();
    }
  });
});

describe('Batch (the per-request accounting of fetch.py run())', () => {
  const g = (id, ts, extra = {}) => ({ id, createdAt: ts, variant: 'standard', perf: 'blitz', ...extra });

  it('enforces max, skips known, unsupported and id-less objects, and moves the cursor', () => {
    const s = state([500]); // id '0'
    const cursor = new Cursor();
    const b = new Batch({ sort: 'dateDesc', until: 499, max: 2 }, s, cursor, ['blitz']);
    expect(b.accept(g('0', 499))).toBe('skip'); // already stored
    expect(b.accept({ variant: 'standard', createdAt: 498 })).toBe('skip'); // no id: cursor untouched
    expect(b.accept(g('x', 497, { variant: 'chess960' }))).toBe('skip');
    expect(b.accept(g('a', 496))).toBe('store');
    expect(b.accept(g('b', 495))).toBe('store');
    expect(b.accept(g('c', 494))).toBe('stop'); // Lichess over-delivered
    expect([b.seen, b.stored, b.ranDry]).toEqual([5, 2, false]);
    expect([cursor.oldestSeen, cursor.newestSeen]).toEqual([495, 499]);
    expect([s.count, s.oldest, s.ids.has('b')]).toEqual([3, 495, true]);
  });

  it('runs dry when fewer than max arrive, and always without a max', () => {
    const b = new Batch({ sort: 'dateDesc', max: 5 }, state(), new Cursor(), ['blitz']);
    b.accept(g('a', 1));
    expect(b.ranDry).toBe(true);
    expect(new Batch({ sort: 'dateAsc', since: 1 }, state(), new Cursor(), ['blitz']).ranDry).toBe(true);
  });
});
