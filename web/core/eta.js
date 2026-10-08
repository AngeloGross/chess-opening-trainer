// Time estimates for an analysis run (design §8): a per-game cost model fed with the device's measured
// search rate (core/calibration.js), and a live estimate that moves from the model to the run's real
// throughput as games finish. Pure, so vitest checks the numbers.
//
// Cost model, from the CLI cache of a 500-game run (design §8): per game about 4.2 single-PV searches and
// 0.8 MultiPV-5 searches, and one MultiPV-5 search costs about 7 single searches (704 ms vs 100 ms at
// depth 14). Lazy MultiPV (mobile) only searches the top 30 positions during the run; the rest are checked
// when a position is first opened in the trainer and are not part of the estimate.
// The download runs at about 20 games/s (anonymous Lichess export, design §3.1).

export const SINGLE_PER_GAME = 4.2;
export const MULTIPV_PER_GAME = 0.8;
export const MULTIPV_COST = 7;
export const DOWNLOAD_GAMES_PER_S = 20;
/** Games' worth of weight the model keeps in the live estimate (more finished games: less model). */
export const MODEL_WEIGHT_GAMES = 5;

/**
 * Single-search equivalents of one run.
 * @param {{games: number, multipv: 'eager'|'lazy', lazyTop?: number}} p
 * @returns {{singles: number, multipvs: number, units: number}}
 */
export function runCost({ games, multipv, lazyTop = 30 }) {
  const n = Math.max(0, games);
  const singles = n * SINGLE_PER_GAME;
  const multipvs = multipv === 'lazy' ? Math.min(lazyTop, n * MULTIPV_PER_GAME) : n * MULTIPV_PER_GAME;
  return { singles, multipvs, units: singles + multipvs * MULTIPV_COST };
}

/**
 * Estimated time of a run before it starts.
 * @param {{games: number, rate: number, multipv: 'eager'|'lazy', lazyTop?: number, download?: boolean}} p
 *   rate: measured single-PV searches per second of the whole pool at the run's depth
 * @returns {{totalMs: number, analysisMs: number, downloadMs: number, perGameMs: number}}
 */
export function estimateRun({ games, rate, multipv, lazyTop = 30, download = true }) {
  if (!(rate > 0)) throw new RangeError('rate must be positive');
  const { units } = runCost({ games, multipv, lazyTop });
  const analysisMs = (units / rate) * 1000;
  const downloadMs = download ? (Math.max(0, games) / DOWNLOAD_GAMES_PER_S) * 1000 : 0;
  return { totalMs: analysisMs + downloadMs, analysisMs, downloadMs, perGameMs: games > 0 ? analysisMs / games : 0 };
}

/**
 * Remaining time during a run: the model's time per game, blended with the measured time per game
 * (active time / games finished in this run) as games finish, times the games left, plus the MultiPV
 * searches still queued once every game is done.
 * @param {{gamesLeft: number, gamesThisRun: number, activeMs: number, modelPerGameMs: number,
 *   multipvLeft?: number, rate: number}} p
 * @returns {number} ms
 */
export function liveEtaMs({ gamesLeft, gamesThisRun, activeMs, modelPerGameMs, multipvLeft = 0, rate }) {
  const k = MODEL_WEIGHT_GAMES;
  const perGame = (Math.max(0, activeMs) + k * modelPerGameMs) / (Math.max(0, gamesThisRun) + k);
  const tail = gamesLeft > 0 ? 0 : (Math.max(0, multipvLeft) * MULTIPV_COST / rate) * 1000;
  return Math.max(0, Math.round(perGame * Math.max(0, gamesLeft) + tail));
}

/** "40 s", "12 min", "1 h 5 min" @param {number} ms */
export function formatDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * The sentence shown before Start, e.g. "About 12 min for 150 games at depth 12 on this device."
 * @param {{totalMs: number}} estimate @param {{games: number, depth: number}} options
 */
export function estimateText(estimate, { games, depth }) {
  return `About ${formatDuration(estimate.totalMs)} for ${games} games at depth ${depth} on this device.`;
}
