// Device calibration (design §8: "ETA from a 5-position calibration run on the device before starting,
// never from a fixed table") and the adaptive worker count (design §11).
//
// The run: one untimed warm-up search per worker (engine start-up, hash allocation), then a parallel
// round of at least PARALLEL_SEARCHES positions (whole rounds) spread over every worker of the real pool, timed wall-clock:
// that is the pool's searches per second at the chosen depth. On a phone (compareSingle), two more
// positions are searched one after the other, so only one worker is busy: the single-worker rate.
// About 5 timed positions on a computer, 6 on a phone.
//
// Worker-count rule: start from defaultWorkerCount() (pool.js). Use one worker instead of several when
// the parallel rate is less than SINGLE_MARGIN (10 %) above the single-worker rate: a throttled phone
// that cannot run two engines at once then saves heat and memory and loses nothing. Otherwise keep them.
//
// Cache: settings store `calibration` = {fingerprint, byDepth: {[depth]: Calibration}}. Valid for the same
// device fingerprint (mobile flag, cores, user agent) and MAX_AGE_MS; a new fingerprint drops all depths.

/** Positions from real opening mistakes (web/positions.json), moves 5 to 12, varied structures. */
export const CALIBRATION_FENS = [
  'r1bqkb1r/1p3ppp/p1n1p3/2pn4/3P4/5N2/PPP2PPP/RNBQRBK1 b kq - 0 8',
  'rnbq1rk1/ppp1bppp/4p3/3pP3/2PPn3/2N2N2/PP3PPP/R1BQKB1R w KQ - 1 7',
  'r1b1k1nr/ppp2Npp/5q2/2b1n3/2BpP3/5Q2/PP3PPP/RNB1K2R w KQkq - 3 9',
  '2rq1rk1/p1p2ppp/bpP1pn2/b2p4/2P5/1Q3NP1/PP2PPBP/R1BR2K1 w - - 0 12',
  'rnbqk1nr/pp3ppp/2pbp3/3p4/2PP4/2N2N2/PP2PPPP/R1BQKB1R w KQkq - 2 5',
  'rnbqkbnr/5ppp/p7/1N2p3/2pPP3/8/1P3PPP/R1BQKBNR w KQkq - 0 8',
  'rnbqkb1r/pp3ppp/2p1pn2/3p4/2PP4/2N2N2/PP2PPPP/R1BQKB1R w KQkq - 0 5',
  'rnbqkb1r/pp3ppp/4p3/2pn4/8/2N1P1P1/PP1P1PBP/R1BQK1NR b KQkq - 0 6',
  'rnbqkb1r/pp1p2pp/4pn2/5pB1/3pP3/5N2/PPPN1PPP/R2QKB1R w KQkq - 0 6',
  'r1bqkb1r/pp3p1p/2n2p2/1Bppp3/3P4/2P1PN2/PP3PPP/RN1QK2R b KQkq - 3 7',
];

export const CALIBRATION_SETTING = 'calibration';
export const PARALLEL_SEARCHES = 4;
export const SINGLE_SEARCHES = 2;
export const SINGLE_MARGIN = 1.1;
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const WARMUP_DEPTH = 6;

/**
 * @typedef {object} Calibration
 * @property {number} depth
 * @property {number} poolWorkers  workers of the measured pool
 * @property {number} parallelRate  searches/s with every worker busy
 * @property {number|null} singleRate  searches/s with one worker busy (phones only)
 * @property {number} workers  the worker count to use (worker-count rule)
 * @property {number} rate  searches/s with `workers` workers: what the ETA uses
 * @property {number} searches  timed searches
 * @property {number} at  ms timestamp
 * @property {string|null} engine
 */

/** @param {{hardwareConcurrency?: number, userAgent?: string}} nav @param {boolean} mobile */
export function deviceFingerprint(nav, mobile) {
  return `${mobile ? 'mobile' : 'desktop'}|${Number(nav?.hardwareConcurrency) || 0}|${nav?.userAgent ?? ''}`;
}

/**
 * The cached calibration for this device and depth, or null.
 * @param {any} stored  the settings value
 * @param {{fingerprint: string, depth: number, now: number}} p
 * @returns {Calibration|null}
 */
export function cachedCalibration(stored, { fingerprint, depth, now }) {
  if (!stored || stored.fingerprint !== fingerprint) return null;
  const c = stored.byDepth?.[depth];
  if (!c || !(c.rate > 0) || !(now - c.at < MAX_AGE_MS) || c.at > now) return null;
  return c;
}

/**
 * The settings value with `cal` added (other depths of the same device kept, another device's dropped).
 * @param {any} stored @param {string} fingerprint @param {Calibration} cal
 */
export function withCalibration(stored, fingerprint, cal) {
  const byDepth = stored?.fingerprint === fingerprint ? { ...stored.byDepth } : {};
  byDepth[cal.depth] = cal;
  return { fingerprint, byDepth };
}

/** The worker count of the most recent calibration of this device, or null. */
export function preferredWorkers(stored, fingerprint) {
  if (!stored || stored.fingerprint !== fingerprint) return null;
  const latest = Object.values(stored.byDepth ?? {}).sort((a, b) => b.at - a.at)[0];
  return latest?.workers ?? null;
}

/**
 * Worker-count rule (see the top of this file).
 * @param {{poolWorkers: number, parallelRate: number, singleRate: number|null}} p
 * @returns {{workers: number, rate: number}}
 */
export function chooseWorkers({ poolWorkers, parallelRate, singleRate }) {
  if (poolWorkers > 1 && singleRate !== null && singleRate > 0 && parallelRate < singleRate * SINGLE_MARGIN) {
    return { workers: 1, rate: singleRate };
  }
  return { workers: poolWorkers, rate: parallelRate };
}

/** Timed parallel searches: at least PARALLEL_SEARCHES, in full rounds so no worker idles at the end. */
export function parallelSearches(workers) {
  const w = Math.max(1, workers);
  return w * Math.ceil(PARALLEL_SEARCHES / w);
}

/**
 * Measure the pool at `depth`.
 * @param {{analyse: (fen: string, depth: number, multipv?: number) => Promise<any>, ready: () => Promise<string>, workers: number}} pool
 * @param {number} depth
 * @param {{compareSingle?: boolean, now?: () => number, fens?: string[], onStep?: (done: number, total: number) => void}} [opts]
 * @returns {Promise<Calibration>}
 */
export async function calibrate(pool, depth, { compareSingle = false, now = () => performance.now(), fens = CALIBRATION_FENS, onStep = () => {} } = {}) {
  const engine = await pool.ready();
  const workers = Math.max(1, pool.workers);
  const single = compareSingle && workers > 1 ? SINGLE_SEARCHES : 0;
  const parallel = parallelSearches(workers);
  const total = parallel + single;
  let done = 0;
  const step = () => onStep(++done, total);
  let next = 0;
  const fen = () => fens[next++ % fens.length];

  // Warm-up: one shallow search per worker, untimed.
  await Promise.all(Array.from({ length: workers }, () => pool.analyse(fen(), Math.min(WARMUP_DEPTH, depth), 1)));

  let t = now();
  await Promise.all(Array.from({ length: parallel }, () => pool.analyse(fen(), depth, 1).then(step)));
  const parallelRate = parallel / Math.max(1e-3, (now() - t) / 1000);

  let singleRate = null;
  if (single) {
    t = now();
    for (let i = 0; i < single; i++) await pool.analyse(fen(), depth, 1).then(step);
    singleRate = single / Math.max(1e-3, (now() - t) / 1000);
  }
  const choice = chooseWorkers({ poolWorkers: workers, parallelRate, singleRate });
  return { depth, poolWorkers: workers, parallelRate, singleRate, ...choice, searches: total, at: Date.now(), engine };
}
