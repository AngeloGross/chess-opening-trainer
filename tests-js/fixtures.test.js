// Shared fixtures (spec/fixtures/*.json) through the JS port; pytest runs the same files through Python.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aggregate } from '../web/core/aggregate.js';
import { analyseGame } from '../web/core/analyse.js';
import { NO_SKIP } from '../web/core/book.js';
import { fenKey } from '../web/core/fen.js';

const DIR = new URL('../spec/fixtures/', import.meta.url);
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8')));

/** Mirrors tests/helpers.py FixtureEngine: unknown positions are (null, 0). */
function fixtureEngine(table) {
  const calls = [];
  return {
    calls,
    async evaluate(fen) {
      const key = fenKey(fen);
      calls.push(key);
      const [best, cp] = table[key] ?? [null, 0];
      return [best, cp];
    },
  };
}

/** The JS GameResult in the fixture's (Python dataclass) field names. */
function resultDoc(res, calls) {
  if (res === null) return null;
  const m = res.mistake;
  return {
    color: res.color,
    reached: res.reached,
    mistake: m && {
      fen: m.fen, key: m.key, ply: m.ply, played: m.played, played_san: m.playedSan,
      best: m.best, best_san: m.bestSan, loss: m.loss, eval_best: m.evalBest,
    },
    evaluated: calls,
  };
}

async function runFixture(fx) {
  const { max_moves: maxMoves, threshold } = fx.settings;
  const skip = fx.skip
    ? { book: new Set(fx.skip.book ?? []), bookMoves: fx.skip.book_moves ?? 0, openingMoves: fx.skip.opening_moves ?? 0,
      openingFloor: fx.skip.opening_floor ?? 20 }
    : NO_SKIP;
  const results = [];
  const analysed = [];
  for (const game of fx.games) {
    const engine = fixtureEngine(fx.fakeEngine ?? {});
    const res = await analyseGame(game, fx.user, engine, maxMoves, threshold, skip);
    results.push(resultDoc(res, engine.calls));
    if (res !== null) analysed.push([game, res]);
  }
  const top = fx.topMoves ?? {};
  const progress = [];
  const positions = await aggregate(
    analysed,
    async (fen) => top[fenKey(fen)] ?? [],
    threshold,
    (done, total) => progress.push([done, total]),
  );
  return { results, positions, progress };
}

describe('shared fixtures', () => {
  it('exist', () => expect(fixtures.length).toBeGreaterThanOrEqual(10));

  for (const fx of fixtures) {
    it(fx.name, async () => {
      const actual = await runFixture(fx);
      expect(actual.results).toEqual(fx.expected.results);
      // Key order matters for the document: compare serialised entries, not just deep equality.
      expect(JSON.stringify(actual.positions)).toBe(JSON.stringify(fx.expected.positions));
      expect(actual.progress).toEqual(fx.expected.progress);
    });
  }
});
