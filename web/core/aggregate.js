// Group first mistakes by position and rank them (port of opening_trainer/aggregate.py).
// Produces positions.json entries identical to the CLI's: same keys, order, rounding, sort and tie-breaks.
import { gameUrl, sanOf } from './analyse.js';
import { round1 } from './fen.js';

export const MAX_GAME_URLS = 5;
// A blunder of several pawns would otherwise drown out a mistake he repeats every week.
export const LOSS_CAP = 500;

/** @typedef {import('./analyse.js').GameResult} GameResult */
/** @typedef {(fen: string) => Promise<Array<[string, number]>>} TopMoves */
/** @typedef {(done: number, total: number) => void} OnProgress */

/**
 * Insertion-ordered counter with Python `Counter.most_common` ordering:
 * count descending, first-inserted first among equal counts.
 * @template T
 */
class Counter {
  constructor() {
    /** @type {Map<string, {value: T, count: number}>} */
    this.items = new Map();
  }

  /** @param {string} id  identity of `value` @param {T} value */
  add(id, value) {
    const item = this.items.get(id);
    if (item) item.count += 1;
    else this.items.set(id, { value, count: 1 });
  }

  /** @returns {Array<{value: T, count: number}>} */
  mostCommon() {
    return [...this.items.values()].sort((a, b) => b.count - a.count); // Array.sort is stable
  }
}

/**
 * Moves within `threshold` cp of the top MultiPV line, minus moves recorded as mistakes.
 * The top line is always within the window, so it is included unless it is itself a recorded mistake.
 * @param {Array<[string, number]>} top
 * @param {Set<string>} wrong
 * @param {number} threshold
 * @returns {string[]}
 */
export function acceptableMoves(top, wrong, threshold) {
  if (!top.length) return [];
  const bestCp = top[0][1];
  return [...new Set(top.filter(([uci, cp]) => bestCp - cp < threshold && !wrong.has(uci)).map(([uci]) => uci))];
}

/**
 * Rank the first mistakes of `results` into positions.json entries.
 * @param {Iterable<[any, GameResult]>} results  (Lichess game, its result) for every analysed game, most recent first
 * @param {TopMoves} topMoves  MultiPV search for a FEN, best first
 * @param {number} threshold
 * @param {OnProgress} [onProgress]
 * @returns {Promise<object[]>}
 */
export async function aggregate(results, topMoves, threshold, onProgress) {
  /** @type {Map<string, number>} */
  const reached = new Map();
  /** @type {Map<string, {fen: string, color: string, best: string, losses: number[],
   *   played: Counter<[string, string]>, openings: Counter<[string, string]>, gameUrls: string[]}>} */
  const buckets = new Map();

  for (const [game, res] of results) {
    for (const key of new Set(res.reached)) reached.set(key, (reached.get(key) ?? 0) + 1);
    const m = res.mistake;
    if (!m) continue;
    let b = buckets.get(m.key);
    if (!b) {
      b = { fen: m.fen, color: res.color, best: m.best, losses: [], played: new Counter(), openings: new Counter(), gameUrls: [] };
      buckets.set(m.key, b);
    }
    b.losses.push(m.loss); // raw, uncapped
    b.played.add(JSON.stringify([m.played, m.playedSan]), [m.played, m.playedSan]);
    const opening = game.opening || {};
    // Python: opening.get("eco", "") keeps an explicit null, so only a missing key gets the default.
    const eco = 'eco' in opening ? opening.eco : '';
    const name = 'name' in opening ? opening.name : 'Unknown';
    b.openings.add(JSON.stringify([eco, name]), [eco, name]);
    if (b.gameUrls.length < MAX_GAME_URLS) b.gameUrls.push(gameUrl(game, res.color, m.ply));
  }

  const entries = [];
  let i = 0;
  for (const [key, b] of buckets) {
    i += 1;
    const errors = b.losses.length;
    const capped = b.losses.map((loss) => Math.min(loss, LOSS_CAP));
    const avgLoss = sum(capped) / errors;
    const wrong = new Set([...b.played.items.values()].map(({ value: [uci] }) => uci));

    // Best move and accept window come from the same MultiPV search.
    const top = await topMoves(b.fen);
    let best = top.length ? top[0][0] : b.best;
    // Depth noise can make the top line one of the player's "mistakes"; then fall back so the quiz has an answer.
    let acceptable = acceptableMoves(top, wrong, threshold);
    if (!acceptable.length) acceptable = [!wrong.has(b.best) ? b.best : best];
    if (!acceptable.includes(best)) best = acceptable[0];

    const [eco, name] = b.openings.mostCommon()[0].value;
    entries.push({
      key,
      fen: b.fen,
      orientation: b.color === 'white' ? 'white' : 'black',
      errors,
      reached: Math.max(reached.get(key) ?? 0, errors),
      avg_loss: round1(avgLoss),
      raw_avg_loss: round1(sum(b.losses) / errors),
      score: round1(errors * avgLoss),
      best,
      best_san: sanOf(b.fen, best),
      acceptable,
      played: b.played.mostCommon().map(({ value: [uci, san], count }) => ({ uci, san, count })),
      eco,
      opening: name,
      games: b.gameUrls,
    });
    onProgress?.(i, buckets.size);
  }
  // Python sorts by (-score, -errors, key); keys are ASCII, so code-unit order equals code-point order.
  entries.sort((a, b) => b.score - a.score || b.errors - a.errors || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return entries;
}

/** Losses are integer centipawns, so this sum is exact, like Python's. @param {number[]} xs */
function sum(xs) {
  return xs.reduce((total, x) => total + x, 0);
}
