// Pure list logic of the trainer (trainer.js): filters, the opening filter's counts, the per-user stats
// key, and how a new positions document merges into the list that is on screen (design §8: the list
// grows at every checkpoint while the friend trains).

import { userIdOf } from '../store/db.js';

/** The stats key of the CLI-only page, before stats were kept per user (design §5). */
export const LEGACY_STATS_KEY = 'opening-trainer:stats';

/**
 * localStorage key of one user's quiz stats: `opening-trainer:stats:<userId>`.
 * A document without a user falls back to the legacy key.
 * @param {string|undefined|null} user
 * @returns {string}
 */
export function statsKeyFor(user) {
  return user ? `${LEGACY_STATS_KEY}:${userIdOf(user)}` : LEGACY_STATS_KEY;
}

/**
 * Read one user's stats. With `migrateLegacy` (a CLI document: the old page only ever showed that one),
 * stats under the legacy key move to the user's key once, if the user has none yet.
 * @param {Pick<Storage, 'getItem'|'setItem'|'removeItem'>|null|undefined} storage
 * @param {string|undefined|null} user
 * @param {{migrateLegacy?: boolean}} [opts]
 * @returns {Record<string, {tries: number, solved: number, failed: number, last: 'solved'|'failed'}>}
 */
export function loadStats(storage, user, { migrateLegacy = false } = {}) {
  const key = statsKeyFor(user);
  try {
    let raw = storage.getItem(key);
    if (raw === null && migrateLegacy && key !== LEGACY_STATS_KEY) {
      raw = storage.getItem(LEGACY_STATS_KEY);
      if (raw !== null) {
        storage.setItem(key, raw);
        storage.removeItem(LEGACY_STATS_KEY);
      }
    }
    const stats = JSON.parse(raw ?? 'null');
    return stats && typeof stats === 'object' ? stats : {};
  } catch {
    return {}; // storage blocked (private mode etc.) or unreadable: stats last for this page view
  }
}

/**
 * @typedef {{opening: string, color: string, unsolved: boolean}} Filters  '' = any
 * @typedef {{key: string, opening: string, orientation: string}} Position  (the rest of a positions.json entry)
 */

/** @param {Position} pos @param {Filters} f @param {(pos: Position) => boolean} isSolved */
export function matches(pos, f, isSolved) {
  return (!f.opening || pos.opening === f.opening) && (!f.color || pos.orientation === f.color) && (!f.unsolved || !isSolved(pos));
}

/**
 * @template {Position} P
 * @param {P[]} positions @param {Filters} filters @param {(pos: P) => boolean} isSolved
 * @returns {P[]}
 */
export function filterPositions(positions, filters, isSolved) {
  return positions.filter((p) => matches(p, filters, isSolved));
}

/**
 * Openings with their position counts, most positions first, then by name.
 * @param {Position[]} positions
 * @returns {Array<[string, number]>}
 */
export function openingCounts(positions) {
  const counts = new Map();
  for (const p of positions) counts.set(p.opening, (counts.get(p.opening) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * The list after a new document arrived, without losing the place on screen:
 * - entries follow the new document's order (its ranking);
 * - an entry matches the current filters, or was already listed: like a move that solves a position
 *   under "Unsolved only", an update never removes what the friend is looking at (only a filter change does);
 * - the current position stays current (found by key). If the new document no longer has it, the old
 *   entry is kept at its old place so an attempt in progress can finish.
 * @template {Position} P
 * @param {{positions: P[], filters: Filters, isSolved: (pos: P) => boolean, filtered: P[], index: number}} p
 *   `filtered` and `index` describe the list before the update (index of the current entry, -1 for none)
 * @returns {{filtered: P[], index: number}} index -1 when there is no current entry
 */
export function mergeList({ positions, filters, isSolved, filtered, index }) {
  const current = index >= 0 ? filtered[index] : undefined;
  const listed = new Set(filtered.map((p) => p.key));
  const next = positions.filter((p) => listed.has(p.key) || matches(p, filters, isSolved));
  if (!current) return { filtered: next, index: next.length ? 0 : -1 };
  let at = next.findIndex((p) => p.key === current.key);
  if (at < 0) {
    at = Math.min(index, next.length);
    next.splice(at, 0, current);
  }
  return { filtered: next, index: at };
}
