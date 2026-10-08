// Lazy MultiPV on open (design §8, mobile): the accept window of a position outside the top 30 is
// computed when the trainer first shows it, then written into the stored document so it is never
// searched again.
//
// The coordinator marks such entries `unchecked: true` (no cached MultiPV-5 search at the checkpoint).
// Until the window is known the entry accepts only its single-PV best move. `applyTopMoves` recomputes
// best, best_san and acceptable exactly like core/aggregate.js does for a bucket with a MultiPV result.

import { acceptableMoves } from '../core/aggregate.js';
import { sanOf } from '../core/analyse.js';
import { updatePositions } from '../store/db.js';

/** @param {any} entry @returns {boolean} the accept window still has to be computed */
export function needsAlternatives(entry) {
  return entry?.unchecked === true;
}

/**
 * The entry with the accept window of `top` (one MultiPV search, best first), without the marker.
 * Same rules and fallbacks as aggregate.js: the player's recorded moves never count as acceptable, and
 * `best` is always in `acceptable`.
 * @param {any} entry  a positions.json entry (its `best` is the single-PV best when unchecked)
 * @param {Array<[string, number]>} top
 * @param {number} threshold
 */
export function applyTopMoves(entry, top, threshold) {
  const wrong = new Set((entry.played ?? []).map((p) => p.uci));
  let best = top.length ? top[0][0] : entry.best;
  let acceptable = acceptableMoves(top, wrong, threshold);
  if (!acceptable.length) acceptable = [!wrong.has(entry.best) ? entry.best : best];
  if (!acceptable.includes(best)) best = acceptable[0];
  const { unchecked: _unchecked, ...rest } = entry;
  return { ...rest, best, best_san: sanOf(entry.fen, best), acceptable };
}

/**
 * Search the alternatives of one entry and store them in the user's document.
 * @param {object} p
 * @param {IDBDatabase} p.db
 * @param {string} p.user
 * @param {any} p.entry
 * @param {number} p.threshold
 * @param {(fen: string) => Promise<Array<[string, number]>>} p.topMoves  Coordinator#topMoves
 * @returns {Promise<any>} the updated entry
 */
export async function checkAlternatives({ db, user, entry, threshold, topMoves }) {
  const top = await topMoves(entry.fen);
  const updated = applyTopMoves(entry, top, threshold);
  await updatePositions(db, user, (doc) => {
    if (!doc?.positions) return undefined;
    let changed = false;
    const positions = doc.positions.map((p) => {
      if (p.key !== entry.key || !needsAlternatives(p)) return p;
      changed = true;
      return applyTopMoves(p, top, threshold);
    });
    return changed ? { ...doc, positions } : undefined;
  });
  return updated;
}
