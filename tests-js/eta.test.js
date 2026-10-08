// ETA model, calibration cache and procedure, worker-count rule (slice 7).
import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_FENS, MAX_AGE_MS, cachedCalibration, calibrate, chooseWorkers, deviceFingerprint, parallelSearches,
  preferredWorkers, withCalibration,
} from '../web/core/calibration.js';
import { estimateRun, estimateText, formatDuration, liveEtaMs, runCost } from '../web/core/eta.js';

describe('ETA model', () => {
  it('costs 4.2 single + 0.8 MultiPV (x7) per game; lazy caps MultiPV at the top 30', () => {
    expect(runCost({ games: 100, multipv: 'eager' })).toEqual({ singles: 420, multipvs: 80, units: 420 + 560 });
    expect(runCost({ games: 150, multipv: 'lazy' })).toMatchObject({ singles: 630, multipvs: 30, units: 630 + 210 });
    expect(runCost({ games: 20, multipv: 'lazy' }).multipvs).toBe(16); // fewer mistakes than the top 30
  });

  it('turns the measured rate into minutes, with the download at 20 games/s', () => {
    // Desktop at depth 14 (design §8): ~10 searches/s per engine, 4 engines -> 500 games in about 2 min.
    const desk = estimateRun({ games: 500, rate: 40, multipv: 'eager' });
    expect(desk.analysisMs).toBeCloseTo((500 * 9.8 / 40) * 1000);
    expect(desk.downloadMs).toBe(25_000);
    expect(desk.perGameMs).toBeCloseTo(245);
    // The measured phone (design §8): 2.6 s per search per engine at depth 14, 2 engines; depth 12 about 2x cheaper.
    const phone = estimateRun({ games: 150, rate: 2 / 1.3, multipv: 'lazy' });
    expect(phone.totalMs / 60_000).toBeGreaterThan(8);
    expect(phone.totalMs / 60_000).toBeLessThan(15); // design: "an estimated 10-15 min"
    expect(estimateText(phone, { games: 150, depth: 12 })).toBe(`About ${formatDuration(phone.totalMs)} for 150 games at depth 12 on this device.`);
    expect(() => estimateRun({ games: 1, rate: 0, multipv: 'eager' })).toThrow();
  });

  it('reflects a changed game count or depth (rate) before Start', () => {
    const a = estimateRun({ games: 150, rate: 2, multipv: 'eager' }).totalMs;
    expect(estimateRun({ games: 300, rate: 2, multipv: 'eager' }).totalMs).toBeCloseTo(2 * a);
    expect(estimateRun({ games: 150, rate: 1, multipv: 'eager' }).totalMs).toBeGreaterThan(a);
  });

  it('live ETA: the model at first, then the measured time per game', () => {
    const model = 1000;
    expect(liveEtaMs({ gamesLeft: 10, gamesThisRun: 0, activeMs: 0, modelPerGameMs: model, rate: 10 })).toBe(10_000);
    // Real games take 3 s each: after 5 games halfway, after 95 games almost all measured.
    expect(liveEtaMs({ gamesLeft: 10, gamesThisRun: 5, activeMs: 15_000, modelPerGameMs: model, rate: 10 })).toBe(20_000);
    expect(liveEtaMs({ gamesLeft: 10, gamesThisRun: 95, activeMs: 285_000, modelPerGameMs: model, rate: 10 })).toBe(29_000);
    // All games done, MultiPV searches left: 3 x 7 single searches at 10/s.
    expect(liveEtaMs({ gamesLeft: 0, gamesThisRun: 40, activeMs: 1, modelPerGameMs: model, multipvLeft: 3, rate: 10 })).toBe(2100);
    expect(liveEtaMs({ gamesLeft: 0, gamesThisRun: 40, activeMs: 1, modelPerGameMs: model, rate: 10 })).toBe(0);
  });

  it('formats durations', () => {
    expect([formatDuration(400), formatDuration(42_000), formatDuration(12 * 60_000), formatDuration(65 * 60_000)]).toEqual(['1 s', '42 s', '12 min', '1 h 5 min']);
  });
});

describe('calibration cache', () => {
  const fp = deviceFingerprint({ hardwareConcurrency: 8, userAgent: 'UA' }, false);
  const cal = (depth, at, extra = {}) => ({ depth, at, rate: 5, workers: 2, poolWorkers: 2, parallelRate: 5, singleRate: null, searches: 4, engine: 'E', ...extra });

  it('is per device and depth, and expires', () => {
    let stored = withCalibration(null, fp, cal(12, 1000));
    stored = withCalibration(stored, fp, cal(14, 2000, { workers: 1 }));
    expect(cachedCalibration(stored, { fingerprint: fp, depth: 12, now: 5000 })).toMatchObject({ depth: 12 });
    expect(cachedCalibration(stored, { fingerprint: fp, depth: 14, now: 5000 })).toMatchObject({ depth: 14 });
    expect(cachedCalibration(stored, { fingerprint: fp, depth: 16, now: 5000 })).toBeNull(); // another depth: measure
    expect(cachedCalibration(stored, { fingerprint: 'other', depth: 12, now: 5000 })).toBeNull(); // another device
    expect(cachedCalibration(stored, { fingerprint: fp, depth: 12, now: 1000 + MAX_AGE_MS })).toBeNull(); // too old
    expect(cachedCalibration(stored, { fingerprint: fp, depth: 12, now: 500 })).toBeNull(); // clock went back
    expect(cachedCalibration(null, { fingerprint: fp, depth: 12, now: 5000 })).toBeNull();
    expect(preferredWorkers(stored, fp)).toBe(1); // the latest measurement
    expect(preferredWorkers(stored, 'other')).toBeNull();
  });

  it('re-measuring replaces one depth; another device starts over', () => {
    let stored = withCalibration(withCalibration(null, fp, cal(12, 1000)), fp, cal(14, 1000));
    stored = withCalibration(stored, fp, cal(12, 3000, { rate: 9 }));
    expect(Object.keys(stored.byDepth)).toEqual(['12', '14']);
    expect(stored.byDepth[12].rate).toBe(9);
    const phone = deviceFingerprint({ hardwareConcurrency: 8, userAgent: 'UA' }, true);
    expect(phone).not.toBe(fp);
    expect(Object.keys(withCalibration(stored, phone, cal(12, 4000)).byDepth)).toEqual(['12']);
  });
});

describe('worker-count rule', () => {
  it('keeps every worker unless one is about as fast (within 10 %)', () => {
    expect(chooseWorkers({ poolWorkers: 2, parallelRate: 1.5, singleRate: null })).toEqual({ workers: 2, rate: 1.5 });
    expect(chooseWorkers({ poolWorkers: 2, parallelRate: 1.5, singleRate: 0.8 })).toEqual({ workers: 2, rate: 1.5 });
    expect(chooseWorkers({ poolWorkers: 2, parallelRate: 0.85, singleRate: 0.8 })).toEqual({ workers: 1, rate: 0.8 }); // < 10 % gain
    expect(chooseWorkers({ poolWorkers: 2, parallelRate: 0.7, singleRate: 0.8 })).toEqual({ workers: 1, rate: 0.8 }); // throttled
    expect(chooseWorkers({ poolWorkers: 1, parallelRate: 0.7, singleRate: 0.8 })).toEqual({ workers: 1, rate: 0.7 });
  });
});

describe('calibrate', () => {
  /**
   * A pool on a virtual clock: each search takes `ms`; the first parallelSearches() timed searches run
   * together and finish `speedup` times faster (2 for two real cores, 1 for a phone that throttles to one).
   */
  function timedPool({ workers, ms, speedup = workers }) {
    let clock = 0;
    let timed = 0;
    const calls = [];
    return {
      workers,
      calls,
      now: () => clock,
      ready: async () => 'Fake',
      async analyse(fen, depth) {
        calls.push({ fen, depth });
        await new Promise((r) => setTimeout(r, 0));
        if (depth > 6) clock += timed++ < parallelSearches(workers) ? ms / speedup : ms;
        return { lines: [['e2e4', 0]], nodes: 1, timeMs: ms };
      },
    };
  }

  it('desktop: one warm-up per worker, whole rounds of distinct positions, no single-worker phase', async () => {
    const pool = timedPool({ workers: 3, ms: 100 });
    const steps = [];
    const cal = await calibrate(pool, 14, { now: pool.now, onStep: (d, t) => steps.push(`${d}/${t}`) });
    expect(parallelSearches(3)).toBe(6);
    expect(parallelSearches(4)).toBe(4);
    expect(pool.calls.map((c) => c.depth)).toEqual([6, 6, 6, 14, 14, 14, 14, 14, 14]);
    expect(new Set(pool.calls.map((c) => c.fen)).size).toBe(9); // no repeated position (hash hits)
    expect(steps.at(-1)).toBe('6/6');
    expect(cal).toMatchObject({ depth: 14, poolWorkers: 3, singleRate: null, workers: 3, searches: 6, engine: 'Fake' });
    expect(cal.parallelRate).toBeCloseTo(30); // 6 searches in 6 x 100 ms / 3
    expect(cal.rate).toBe(cal.parallelRate);
    expect(CALIBRATION_FENS.length).toBeGreaterThanOrEqual(8);
  });

  it('phone: compares one engine with two and applies the rule', async () => {
    const good = timedPool({ workers: 2, ms: 1000, speedup: 2 });
    const fine = await calibrate(good, 12, { compareSingle: true, now: good.now });
    expect(fine).toMatchObject({ searches: 6, workers: 2, poolWorkers: 2 });
    expect(fine.parallelRate).toBeCloseTo(2);
    expect(fine.singleRate).toBeCloseTo(1);

    const throttled = timedPool({ workers: 2, ms: 1000, speedup: 1 });
    const cal = await calibrate(throttled, 12, { compareSingle: true, now: throttled.now });
    expect(cal.parallelRate).toBeCloseTo(1);
    expect(cal.singleRate).toBeCloseTo(1);
    expect(cal).toMatchObject({ workers: 1, poolWorkers: 2 });
    expect(cal.rate).toBe(cal.singleRate);
  });
});
