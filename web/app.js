// App shell (design §2, slice 6): Lichess name -> user check -> download -> analysis -> trainer.
//
// How the parts fit:
// - Download: lichess/fetch.worker.js (user check + incremental download into IndexedDB), one worker per run.
// - Analysis: analysis/coordinator.js on this thread with an engine/pool.js pool. Every checkpoint stores
//   the positions document (store `positions`) and hands it to `showDoc`: the first one mounts the
//   trainer, later ones call `trainer.update(doc)`, so the friend trains while the analysis continues.
// - Trainer: trainer.js, mounted with a document object (browser analysis, or the CLI's positions.json).
// - Returning visitor: the stored document of the remembered user is shown at once; "Update" downloads
//   newer games and analyses only games without a result for the same settings (the coordinator resumes).
// - Served by `trainer serve`: an existing web/positions.json is offered as "Use analysis from the command
//   line"; that choice is remembered, so the next visit shows it directly (design §10).
// - Data panel (dataPanel.js, slice 8): storage state, backup export/import, "Load analysis file" and
//   "Send to phone". An import stores the document like a browser analysis (source 'browser') plus an
//   import marker (store/backupStore.js), so the bar says where it came from and "Update" stays hidden.
// - A "Send to phone" link (`#import=…`) is imported at start-up (merge, no question asked: nothing is
//   lost), the fragment is removed from the address bar, and the trainer opens.
// - Persistent storage is requested after the first analysis checkpoint and after an import.
// - Slice 7 (UX polish):
//   - ETA: core/calibration.js measures the real engine pool at the chosen depth (cached per device and
//     depth in the settings store, "Re-measure" in Settings); core/eta.js turns it into "About 12 min for
//     150 games at depth 12 on this device" before Start, and blends it with the run's real throughput.
//   - Worker count: the calibration's rule (one worker if it is as fast as two on a phone).
//   - Lazy MultiPV on open: the trainer asks `alternativesFor` for entries marked `unchecked`; it uses the
//     running coordinator, or an idle one on a lazily started pool (a returning visit).
//   - Messages: every failure goes through core/messages.js (what happened + what to do next).
//   - Wake Lock during the run (wakeLock.js) and a "keep the screen on" note on phones.

import { checkAlternatives } from './analysis/alternatives.js';
import { Coordinator, DEFAULT_PERFS, LAZY_TOP, defaultOptions } from './analysis/coordinator.js';
import {
  CALIBRATION_SETTING, cachedCalibration, calibrate, deviceFingerprint, preferredWorkers, withCalibration,
} from './core/calibration.js';
import { loadGambitBook } from './core/book.js';
import { estimateRun, estimateText, formatDuration, liveEtaMs } from './core/eta.js';
import { classifyError, messageFor, messageText, retryCountdownText } from './core/messages.js';
import { chooseStart, cliOffer, loadCliDoc } from './core/startChoice.js';
import { TransferError, decodeFragment, payloadOf } from './core/transfer.js';
import { mountDataPanel } from './dataPanel.js';
import { EnginePool, defaultWorkerCount } from './engine/pool.js';
import { applyImport, importMarkerName } from './store/backupStore.js';
import { getPositions, getSetting, openDb, requestPersistence, setSetting, userIdOf } from './store/db.js';
import { loadIntended } from './core/trainerList.js';
import { mountTrainer } from './trainer.js';
import { createWakeLock } from './wakeLock.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = defaultOptions();
const OPTIONS_SETTING = 'analysisOptions';
const MAX_GAMES_LIMIT = 5000;
const MAX_MOVES_LIMIT = 40;
// Lichess user names: 2-30 letters, digits, '_' or '-'.
const NAME_PATTERN = /^[A-Za-z0-9_-]{2,30}$/;

/** App state, also read by the console and the headless checks (CDP). `events` is a timeline. */
const app = (window.app = {
  view: 'loading', source: null, doc: null, cliDoc: null, trainer: null, coordinator: null,
  busy: false, progress: null, events: [], imported: null, transfer: null,
  calibration: null, estimate: null, wakeLock: null, poolSize: 0,
});
const FINGERPRINT = deviceFingerprint(globalThis.navigator ?? {}, DEFAULTS.mobile);
/** WebAssembly and module workers are what the engine needs; without them nothing can be analysed here. */
const ENGINE_POSSIBLE = typeof WebAssembly === 'object' && typeof Worker === 'function';

/** @type {IDBDatabase} */
let db;
/** @type {EnginePool|null} */
let pool = null;
/** @type {Worker|null} */
let fetchWorker = null;
/** @type {ReturnType<typeof mountDataPanel>} */
let dataPanel;
let persistenceAsked = false;
/** settings value `calibration` (core/calibration.js), loaded at start-up */
let calStore = null;
/** @type {Promise<any>} calibrations run one at a time */
let calChain = Promise.resolve();
let calRunning = null; // depth being measured, or null
/** @type {import('./core/messages.js').Message|null} the last calibration failure */
let calError = null;
let calTimer = null;
/** @type {{pool: EnginePool, key: string, co: Coordinator}|null} coordinator for on-demand MultiPV outside a run */
let idle = null;
const wake = createWakeLock({
  onChange: (state, err) => {
    app.wakeLock = state;
    note('wakelock', { state, error: err ? String(err?.message ?? err) : undefined });
    renderKeepAwake();
  },
});

function note(type, extra = {}) {
  app.events.push({ type, at: Date.now(), ...extra });
}

// ---------- formatting ----------

const duration = formatDuration;

function when(generated) {
  const d = new Date(generated ?? '');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const online = () => globalThis.navigator?.onLine !== false;

// ---------- views ----------

function setView(view) {
  app.view = view;
  $('loading').hidden = true;
  $('start').hidden = view !== 'start';
  $('trainer').hidden = view !== 'trainer';
  renderBar();
}

function renderBar() {
  const doc = app.view === 'trainer' ? app.doc : null;
  $('bar').hidden = !doc;
  if (!doc) return;
  const depth = doc.settings?.depth ? ` · depth ${doc.settings.depth}` : '';
  const origin = app.source === 'cli' ? 'Command-line analysis' : importedLabel(app.imported) ?? 'Analysed in this browser';
  $('source-info').textContent = `${origin} · ${doc.games ?? '?'} games${depth} · ${when(doc.generated)}`;

  const offer = cliOffer(app.cliDoc);
  $('update').hidden = app.busy || app.source !== 'browser' || !!app.imported;
  $('use-cli').hidden = app.busy || !offer || app.source === 'cli';
  if (offer) $('use-cli').textContent = `Use command-line analysis (${offer.user}, ${offer.positions} positions)`;
  $('to-start').hidden = app.busy;
  $('to-start').textContent = app.source === 'cli' ? 'Analyse in the browser' : 'Change user';
}

/** Where an imported document came from, or null (store/backupStore.js import marker). */
function importedLabel(marker) {
  if (!marker) return null;
  if (marker.kind === 'positions') return 'Command-line analysis (loaded file)';
  if (marker.kind === 'link') return marker.total > marker.positions ? `From a link (top ${marker.positions} of ${marker.total})` : 'From a link';
  return 'From a backup';
}

/** @param {string|import('./core/messages.js').Message} error  a message gets its hint on a second line */
function showError(error) {
  const el = $('start-error');
  if (error && typeof error === 'object') {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = error.hint;
    el.replaceChildren(document.createTextNode(error.text), hint);
  } else el.textContent = error || '';
  el.hidden = !error;
}

/** A failure: on the start screen with its hint, otherwise in the progress panel. */
function showFailure(m) {
  note('message', { kind: m.kind, text: messageText(m) });
  if (app.view === 'trainer') showProgress({ phase: messageText(m) });
  else {
    hideProgress();
    showStart(m);
  }
}

function showStart(error = '') {
  if (!app.busy) renderEta();
  const offer = cliOffer(app.cliDoc);
  $('cli-offer').hidden = !offer;
  if (offer) {
    $('cli-user').textContent = offer.user;
    $('cli-count').textContent = String(offer.positions);
  }
  $('start-form').hidden = false;
  $('back').hidden = !app.trainer;
  $('player').textContent = '';
  showError(error);
  setView('start');
}

/**
 * Show a document in the trainer: mount it, or update the one on screen when it is the same user and source.
 * @param {any} doc @param {'cli'|'browser'} source
 */
function showDoc(doc, source) {
  const same = app.trainer && app.source === source && userIdOf(app.doc?.user ?? '') === userIdOf(doc.user ?? '');
  app.doc = doc;
  if (same) {
    app.trainer.update(doc);
    if (app.view !== 'trainer') {
      setView('trainer');
      app.trainer.cg.redrawAll(); // the board was hidden: measure it again
    }
    note('trainer-update', { source, positions: doc.positions.length, games: doc.games });
  } else {
    app.trainer?.destroy();
    app.source = source;
    setView('trainer'); // visible before mounting, so chessground can measure the board
    app.trainer = mountTrainer($('trainer'), doc, { migrateLegacyStats: source === 'cli', alternatives: alternativesFor });
    note('trainer-mount', { source, positions: doc.positions.length, games: doc.games });
  }
  $('player').textContent = doc.user ? `for ${doc.user}` : '';
  renderBar();
}

/** The first checkpoint is the moment there is something worth keeping (design §3.3). */
function askPersistence(from) {
  if (persistenceAsked) return;
  persistenceAsked = true;
  requestPersistence().then((granted) => {
    note('persist', { granted, from });
    if (dataPanel?.isOpen) dataPanel.renderStorage();
  });
}

/** After an import: show the stored document, mounted afresh so the trainer reads the imported stats. */
function showImported(result, message) {
  if (!result.doc) {
    showProgress({ phase: message });
    return;
  }
  app.imported = result.marker;
  app.trainer?.destroy();
  app.trainer = null;
  $('name').value = result.user;
  showDoc(result.doc, 'browser');
  showProgress({ phase: message });
  askPersistence('import');
}

/**
 * A "Send to phone" link: `#import=…` in the address. Merged into what is stored, then the trainer.
 * @returns {Promise<true|string|null>} true: imported and shown; a string: the error, when nothing is on
 *   screen yet (start-up shows it); null: no link, or the error is already shown
 */
async function importFromLink() {
  if (payloadOf(location.hash) === null) return null;
  const hash = location.hash;
  history.replaceState(null, '', location.pathname + location.search); // never import twice, never bookmark it
  if (app.busy) {
    showProgress({ phase: 'Stop the analysis first, then open the link again.' });
    return null;
  }
  try {
    const { doc, stats, total } = await decodeFragment(hash);
    const result = await applyImport(db, localStorage, { kind: 'link', doc, stats, total }, 'merge');
    note('link-import', { user: result.user, positions: result.doc?.positions.length ?? 0, total, stats: result.stats, keptExisting: result.keptExisting, chars: hash.length });
    const part = doc.positions.length < total ? `the top ${doc.positions.length} of ${total} positions` : `${doc.positions.length} positions`;
    showImported(result, result.keptExisting
      ? `This device already had a newer analysis of ${result.user}; it stays. Stats from the link were merged.`
      : `Imported ${part} of ${result.user} from the link, with stats for ${result.stats} positions.`);
    return true;
  } catch (err) {
    console.error(err);
    const kind = classifyError(err, { where: 'link' });
    const text = kind === 'no_decompression' ? messageText(messageFor(kind))
      : err instanceof TransferError ? err.message : `The link could not be imported (${err?.message ?? err}).`;
    note('link-error', { message: text });
    if (app.view === 'loading') return text;
    if (app.view === 'trainer') showProgress({ phase: text });
    else showStart(text);
    return null;
  }
}

async function useCli() {
  if (!app.cliDoc || app.busy) return;
  await setSetting(db, 'lastSource', 'cli');
  app.imported = null;
  showDoc(app.cliDoc, 'cli');
}

// ---------- settings ----------

async function loadOptions() {
  const o = (await getSetting(db, OPTIONS_SETTING)) ?? {};
  return { maxGames: o.maxGames ?? DEFAULTS.maxGames, depth: o.depth ?? DEFAULTS.depth, maxMoves: o.maxMoves ?? DEFAULTS.maxMoves };
}

function fillOptions({ maxGames, depth, maxMoves }) {
  $('opt-games').value = String(maxGames);
  $('opt-moves').value = String(maxMoves);
  $('moves-info').textContent = String(maxMoves);
  if (![...$('opt-depth').options].some((o) => o.value === String(depth))) $('opt-depth').add(new Option(String(depth), String(depth)));
  $('opt-depth').value = String(depth);
}

function readOptions() {
  const games = Math.round(Number($('opt-games').value));
  const moves = Math.round(Number($('opt-moves').value));
  return {
    maxGames: Number.isFinite(games) && games >= 1 ? Math.min(games, MAX_GAMES_LIMIT) : DEFAULTS.maxGames,
    depth: Number($('opt-depth').value) || DEFAULTS.depth,
    maxMoves: Number.isFinite(moves) && moves >= 1 ? Math.min(moves, MAX_MOVES_LIMIT) : DEFAULTS.maxMoves,
  };
}

// ---------- engine pool, calibration and ETA ----------

/** The pool, started on first use; `size` replaces a pool of another size (never during a run). */
function ensurePool(size) {
  const want = size ?? pool?.size ?? preferredWorkers(calStore, FINGERPRINT) ?? defaultWorkerCount();
  if (pool && pool.size === want && pool.workers > 0) return pool;
  pool?.terminate();
  idle = null;
  pool = new EnginePool({ size: want });
  app.poolSize = want;
  app.enginePool = pool; // for the console and the headless checks
  note('pool', { size: want });
  return pool;
}

function cachedCal(depth) {
  const cal = cachedCalibration(calStore, { fingerprint: FINGERPRINT, depth, now: Date.now() });
  if (cal) app.calibration = cal;
  return cal;
}

/**
 * The device calibration at `depth`: cached, or measured now on the real pool (one at a time).
 * @param {number} depth @param {{force?: boolean, onStep?: (done: number, total: number) => void}} [opts]
 */
function ensureCalibration(depth, { force = false, onStep } = {}) {
  const job = calChain.catch(() => {}).then(async () => {
    const cached = force ? null : cachedCal(depth);
    if (cached) return cached;
    if (!ENGINE_POSSIBLE) throw Object.assign(new Error('WebAssembly or Web Workers are missing'), { name: 'EngineAnalysisError' });
    calRunning = depth;
    renderEta();
    try {
      const measured = ensurePool(defaultWorkerCount()); // the rule compares against the default count
      note('calibration-start', { depth, workers: measured.size });
      const cal = await calibrate(measured, depth, { compareSingle: DEFAULTS.mobile, onStep });
      calStore = withCalibration(calStore, FINGERPRINT, cal);
      await setSetting(db, CALIBRATION_SETTING, calStore).catch((err) => note('calibration-not-saved', { message: String(err?.message ?? err) }));
      calError = null;
      app.calibration = cal;
      note('calibration', cal);
      return cal;
    } catch (err) {
      calError = messageFor(classifyError(err, { where: 'engine' }), { detail: String(err?.message ?? err) });
      pool?.terminate();
      pool = null;
      throw err;
    } finally {
      calRunning = null;
    }
  });
  calChain = job;
  return job;
}

/** Measure soon (debounced) for the depth on screen, unless it is cached or already being measured. */
function scheduleCalibration() {
  clearTimeout(calTimer);
  calTimer = setTimeout(() => {
    const { depth } = readOptions();
    if (app.busy || app.view !== 'start' || cachedCal(depth) || calRunning === depth || calError) return;
    ensureCalibration(depth).then(renderEta, renderEta);
  }, 300);
}

/** The ETA line before Start and the measurement line in Settings. */
function renderEta() {
  const o = readOptions();
  const cal = cachedCal(o.depth);
  const eta = $('eta');
  const info = $('calibration-info');
  $('remeasure').hidden = !ENGINE_POSSIBLE || calRunning !== null;
  if (!ENGINE_POSSIBLE) {
    eta.textContent = messageText(messageFor('engine_failed'));
    eta.className = 'small error';
    info.textContent = '';
    return;
  }
  eta.className = 'small';
  if (cal) {
    const est = estimateRun({ games: o.maxGames, rate: cal.rate, multipv: DEFAULTS.multipv, lazyTop: LAZY_TOP });
    eta.textContent = estimateText(est, { games: o.maxGames, depth: o.depth });
    const engines = cal.workers === 1 ? '1 engine' : `${cal.workers} engines`;
    const single = cal.singleRate !== null && cal.workers !== cal.poolWorkers
      ? ` (${cal.poolWorkers} engines were no faster than one here)` : '';
    info.textContent = `Measured on this device: ${cal.rate.toFixed(1)} positions/s at depth ${cal.depth} with ${engines}${single}, ${when(new Date(cal.at))}.`;
  } else if (calRunning !== null) {
    eta.textContent = `Measuring how fast this device analyses at depth ${calRunning}…`;
    info.textContent = '';
  } else if (calError) {
    eta.textContent = messageText(calError);
    eta.className = 'small error';
    info.textContent = '';
  } else {
    eta.textContent = `Measuring how fast this device analyses at depth ${o.depth}…`;
    info.textContent = '';
    scheduleCalibration();
  }
}

/** The run's estimate (before it starts), kept for the live ETA. */
function planEstimate(cal, options) {
  const est = estimateRun({ games: options.maxGames, rate: cal.rate, multipv: DEFAULTS.multipv, lazyTop: LAZY_TOP });
  app.estimate = { rate: cal.rate, workers: cal.workers, depth: cal.depth, games: options.maxGames, ...est };
  return est;
}

// ---------- lazy MultiPV on open ----------

/**
 * The accept window of an `unchecked` entry (trainer.js asks when it shows one): searched by the running
 * coordinator when it analyses the same user and depth, otherwise by an idle coordinator on the pool,
 * started now if needed. The stored document is updated, so a reload shows the full window.
 * @param {any} entry
 */
async function alternativesFor(entry) {
  const doc = app.doc;
  if (!doc?.user || !db) throw new Error('no stored document to update');
  const user = doc.user;
  const depth = doc.settings?.depth ?? DEFAULTS.depth;
  const threshold = doc.settings?.threshold ?? DEFAULTS.threshold;
  const co = app.coordinator;
  let topMoves;
  let via;
  if (co && co.progress.state === 'running' && userIdOf(co.user) === userIdOf(user) && co.opts.depth === depth && co.opts.threshold === threshold) {
    topMoves = (fen) => co.topMoves(fen);
    via = 'run';
  } else {
    if (!ENGINE_POSSIBLE) throw new Error('no engine in this browser');
    const p = ensurePool();
    const key = `${userIdOf(user)}|${depth}|${threshold}`;
    if (!idle || idle.pool !== p || idle.key !== key) {
      idle = {
        pool: p, key,
        co: new Coordinator({ db, pool: p, user, options: {
          depth, threshold, maxMoves: doc.settings?.max_moves ?? DEFAULTS.maxMoves, perfs: doc.settings?.perf ?? DEFAULTS.perfs, multipv: 'lazy',
        } }),
      };
    }
    const c = idle.co;
    topMoves = (fen) => c.topMoves(fen);
    via = 'idle';
  }
  const t = Date.now();
  note('alternatives-start', { key: entry.key, via });
  const updated = await checkAlternatives({ db, user, entry, threshold, topMoves });
  if (app.doc?.positions && userIdOf(app.doc.user ?? '') === userIdOf(user)) {
    app.doc = { ...app.doc, positions: app.doc.positions.map((p) => (p.key === updated.key && p.unchecked ? updated : p)) };
  }
  note('alternatives-done', { key: entry.key, via, ms: Date.now() - t, acceptable: updated.acceptable, best: updated.best });
  return updated;
}

// ---------- mobile run comfort ----------

function renderKeepAwake() {
  const el = $('keep-awake');
  el.hidden = !(DEFAULTS.mobile && app.busy);
  el.textContent = wake.held
    ? 'The screen stays on while this runs. Keep this tab in front: phones slow down or pause tabs in the background.'
    : 'Keep the screen on and this tab in front: phones slow down or pause tabs in the background. Closing the tab only pauses; “Update” continues later.';
}

function renderDefaults() {
  const device = DEFAULTS.mobile ? 'this phone' : 'this computer';
  const answers = DEFAULTS.multipv === 'eager' ? 'answers checked for every mistake' : `answers checked for the top ${LAZY_TOP} positions`;
  $('defaults').textContent = `Defaults for ${device}: depth ${DEFAULTS.depth}, the ${DEFAULTS.maxGames} most recent games, ${answers}.`;
}

// ---------- progress ----------

/**
 * @param {{phase: string, value?: number|null, detail?: string, pause?: boolean, resume?: boolean, stop?: boolean}} p
 *   value null: indeterminate bar; undefined: no bar
 */
function showProgress({ phase, value, detail = '', pause = false, resume = false, stop = false }) {
  $('progress').hidden = false;
  $('phase').textContent = phase;
  const bar = $('progress-bar');
  bar.hidden = value === undefined;
  if (value === null) bar.removeAttribute('value');
  else if (value !== undefined) bar.value = value;
  $('progress-detail').textContent = detail;
  $('pause').hidden = !pause;
  $('resume').hidden = !resume;
  $('stop').hidden = !stop;
}

function hideProgress() {
  $('progress').hidden = true;
}

function showAnalysisProgress(p) {
  app.progress = p;
  if (p.state === 'done' || p.state === 'stopped' || p.state === 'failed') return; // run() writes the last line
  if (!p.engineId) {
    showProgress({ phase: 'Starting the engine…', value: null, stop: true });
    return;
  }
  const paused = p.state === 'paused';
  const left = p.gamesTotal - p.gamesDone;
  let phase = `Analysing games: ${p.gamesDone} / ${p.gamesTotal}`;
  if (paused) phase = `Paused at ${p.gamesDone} / ${p.gamesTotal} games`;
  else if (p.gamesTotal && !left && p.multipvDone < p.multipvTotal) phase = `Checking answers: ${p.multipvDone} / ${p.multipvTotal}`;
  let etaMs = p.etaMs;
  const est = app.estimate;
  if (est && p.gamesTotal) {
    // The model's time per game, moving to the measured one as games finish (core/eta.js).
    etaMs = liveEtaMs({ gamesLeft: left, gamesThisRun: p.gamesThisRun, activeMs: p.activeMs, modelPerGameMs: est.perGameMs,
      multipvLeft: p.multipvTotal - p.multipvDone, rate: est.rate });
  }
  app.liveEtaMs = etaMs;
  const busyTail = !left && p.multipvDone < p.multipvTotal;
  const eta = paused ? '' : (left || busyTail) ? (etaMs === null ? ' · estimating the time left…' : ` · about ${duration(etaMs)} left`) : '';
  const detail = `${p.positions} positions · ${p.cacheHits} from the cache, ${p.engineSearches} engine searches`
    + ` · ${p.mistakes} mistake positions${eta}`;
  const running = p.state === 'running' || paused;
  showProgress({ phase, value: p.gamesTotal ? p.gamesDone / p.gamesTotal : null, detail, pause: p.state === 'running', resume: paused, stop: running });
}

// ---------- download ----------

/**
 * Check the user and download up to `maxGames` games in the fetch worker.
 * @returns {Promise<{kind: 'done'|'stopped'|'error', name: string, errorKind?: string, message?: string, added?: number}>}
 */
function download(user, maxGames) {
  return new Promise((resolve) => {
    const worker = (fetchWorker = new Worker(new URL('./lichess/fetch.worker.js', import.meta.url), { type: 'module' }));
    let name = user;
    let countdown = null;
    const endCountdown = () => {
      clearInterval(countdown);
      countdown = null;
      $('stop').textContent = 'Stop';
    };
    const end = (result) => {
      endCountdown();
      worker.terminate();
      fetchWorker = null;
      resolve({ name, ...result });
    };
    const downloading = (m, extra = '') => showProgress({
      phase: `Downloading ${name}'s games: ${Math.min(m.stored, maxGames)} / ${maxGames}`,
      value: Math.min(1, m.stored / maxGames), detail: `${m.added} new${extra}`, stop: true,
    });
    worker.onmessage = ({ data: m }) => {
      if (m.type !== 'retry' && m.type !== 'note') endCountdown();
      if (m.type === 'user') {
        name = m.name;
        showProgress({ phase: `Downloading ${name}'s games…`, value: null, stop: true });
      } else if (m.type === 'progress') downloading(m);
      else if (m.type === 'note') $('progress-detail').textContent = m.message;
      else if (m.type === 'retry') {
        // One automatic retry after a minute (design §3.1): a visible countdown, "Cancel" stops it.
        const until = Date.now() + m.delayMs;
        note('retry', { kind: m.kind, delayMs: m.delayMs });
        const tick = () => showProgress({ phase: retryCountdownText(m.kind, (until - Date.now()) / 1000), value: null,
          detail: m.stored ? `${m.stored} games are already stored and stay.` : '', stop: true });
        endCountdown();
        tick();
        $('stop').textContent = 'Cancel';
        countdown = setInterval(tick, 1000);
      } else if (m.type === 'done') end({ kind: 'done', added: m.added, stored: m.stored });
      else if (m.type === 'stopped') end({ kind: 'stopped' });
      else if (m.type === 'error') end({ kind: 'error', errorKind: m.kind, message: m.message, status: m.status });
    };
    worker.onerror = (e) => end({ kind: 'error', errorKind: 'internal', message: `The download could not start (${e.message}).` });
    showProgress({ phase: `Checking the Lichess name “${user}”…`, value: null, stop: true });
    worker.postMessage({ type: 'start', user, perfs: DEFAULT_PERFS, maxGames, since: null });
  });
}

// ---------- the run: download, then analysis ----------

/**
 * Download and analyse `user`'s games. Checkpoints go to the trainer as they come.
 * @param {string} user @param {{maxGames: number, depth: number}} options
 */
async function run(user, options) {
  if (app.busy) return;
  app.busy = true;
  renderBar();
  showError('');
  if (app.view === 'start') $('start-form').hidden = true;
  note('run-start', { user, ...options });
  renderKeepAwake();
  try {
    if (!online()) {
      showFailure(messageFor('offline'));
      return;
    }
    // Calibration first (cached per device and depth): it gives the ETA and the worker count.
    let cal = cachedCal(options.depth);
    if (!cal) {
      showProgress({ phase: 'Measuring how fast this device analyses…', value: 0, stop: false });
      try {
        cal = await ensureCalibration(options.depth, { onStep: (done, total) => showProgress({ phase: 'Measuring how fast this device analyses…', value: done / total }) });
      } catch (err) {
        console.error(err);
        showFailure(calError ?? messageFor('engine_failed'));
        return;
      }
    }
    const est = planEstimate(cal, options);
    note('estimate', { games: options.maxGames, depth: options.depth, totalMs: Math.round(est.totalMs), analysisMs: Math.round(est.analysisMs),
      downloadMs: Math.round(est.downloadMs), rate: cal.rate, workers: cal.workers });
    app.runStartedAt = Date.now();
    wake.hold();
    const fetched = await download(user, options.maxGames);
    note('download-end', { kind: fetched.kind, added: fetched.added, stored: fetched.stored });
    if (fetched.kind !== 'done') {
      if (fetched.kind === 'stopped') {
        if (app.view === 'start') {
          hideProgress();
          showStart('');
        } else showProgress({ phase: 'Download stopped.' });
      } else {
        const kind = fetched.errorKind === 'network' && !online() ? 'offline' : fetched.errorKind;
        showFailure(messageFor(kind, { name: fetched.name, status: fetched.status, detail: fetched.message }));
      }
      return;
    }
    const name = fetched.name;
    if (!fetched.stored) {
      // Nothing in the selected time controls: say so before starting any engine.
      showFailure(messageFor('no_games', { name, perfs: DEFAULT_PERFS }));
      return;
    }
    await setSetting(db, 'lastUser', name);
    await setSetting(db, 'lastSource', 'browser');
    await setSetting(db, OPTIONS_SETTING, options);
    await setSetting(db, importMarkerName(name), null); // the analysis below replaces an imported document
    $('name').value = name;

    // Gambit book (vendored, same origin) and the moves this user marked as intended: neither is judged.
    const book = await loadGambitBook();
    const intended = loadIntended(localStorage, name);
    note('skip', { book: book.size, intended: intended.size });

    ensurePool(cal.workers);
    const co = (app.coordinator = new Coordinator({
      db, pool, user: name,
      options: { maxGames: options.maxGames, depth: options.depth, maxMoves: options.maxMoves, book, intended,
        multipv: DEFAULTS.multipv, lazyTop: LAZY_TOP },
      onProgress: (p) => {
        showAnalysisProgress(p);
        if (p.state === 'paused') wake.release();
        else if (p.state === 'running' && !wake.held) wake.hold();
      },
      onCheckpoint: (doc) => {
        app.imported = null;
        showDoc(doc, 'browser');
        askPersistence('checkpoint');
      },
    }));
    note('analysis-start', { user: name, workers: pool.size });
    const { state, doc, progress } = await co.run();
    const runMs = Date.now() - app.runStartedAt;
    note('analysis-end', { state, positions: doc?.positions.length ?? 0, games: progress.gamesTotal, engineSearches: progress.engineSearches,
      cacheHits: progress.cacheHits, analysisMs: progress.elapsedMs, runMs, estimatedMs: Math.round(est.totalMs) });
    if (!doc) {
      showFailure(messageFor('no_games', { name, perfs: DEFAULT_PERFS }));
    } else if (state === 'stopped') {
      showProgress({ phase: `Stopped after ${progress.gamesDone} of ${progress.gamesTotal} games. “Update” continues where it stopped.` });
    } else {
      showProgress({ phase: `Done: ${doc.positions.length} positions from ${doc.games} games in ${duration(runMs)} (estimated ${duration(est.totalMs)}).` });
    }
  } catch (err) {
    console.error(err);
    note('run-error', { message: String(err?.message ?? err), name: err?.name });
    pool?.terminate();
    pool = null; // a failed engine pool is not reused
    idle = null;
    const kind = classifyError(err, { online: online() });
    showProgress({ phase: messageText(messageFor(kind, { detail: String(err?.message ?? err) })) });
    if (app.view === 'start') $('start-form').hidden = false;
  } finally {
    app.busy = false;
    app.coordinator = null;
    app.estimate = null;
    wake.release();
    renderKeepAwake();
    renderBar();
  }
}

// ---------- startup ----------

function wire() {
  $('start-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = $('name').value.trim();
    if (!name) return showError('Enter your Lichess name.');
    if (!NAME_PATTERN.test(name)) return showError(`“${name}” is not a Lichess name: 2 to 30 letters, digits, “_” or “-”.`);
    run(name, readOptions());
  });
  $('use-cli-start').addEventListener('click', useCli);
  $('use-cli').addEventListener('click', useCli);
  $('back').addEventListener('click', () => {
    if (app.trainer && app.doc) showDoc(app.doc, app.source);
  });
  $('to-start').addEventListener('click', () => {
    hideProgress();
    showStart();
  });
  $('update').addEventListener('click', async () => {
    if (app.doc?.user) run(app.doc.user, await loadOptions());
  });
  const openData = () => dataPanel.open().then(() => $('data').scrollIntoView({ block: 'start' }));
  $('open-data').addEventListener('click', openData);
  $('open-data-start').addEventListener('click', openData);
  window.addEventListener('hashchange', () => { importFromLink(); });
  $('pause').addEventListener('click', () => {
    note('click-pause');
    app.coordinator?.pause();
  });
  $('resume').addEventListener('click', () => {
    note('click-resume');
    app.coordinator?.resume();
  });
  const optionsChanged = () => { if (!app.busy) renderEta(); };
  $('opt-games').addEventListener('input', optionsChanged);
  $('opt-moves').addEventListener('input', () => { $('moves-info').textContent = String(readOptions().maxMoves); });
  $('opt-depth').addEventListener('change', optionsChanged);
  $('remeasure').addEventListener('click', () => {
    if (app.busy) return;
    calError = null;
    ensureCalibration(readOptions().depth, { force: true }).then(renderEta, renderEta);
  });
  $('stop').addEventListener('click', () => {
    note('click-stop', { during: fetchWorker ? 'download' : 'analysis' });
    if (fetchWorker) fetchWorker.postMessage({ type: 'stop' });
    else app.coordinator?.stop();
    $('stop').disabled = true;
    setTimeout(() => { $('stop').disabled = false; }, 500);
  });
}

async function init() {
  try {
    if (!globalThis.indexedDB) throw new Error('indexedDB is missing');
    db = await openDb();
  } catch (err) {
    console.error(err);
    const m = messageFor(classifyError(err, { where: 'storage' }));
    note('message', { kind: m.kind, text: messageText(m) });
    $('loading').textContent = messageText(m);
    $('loading').className = 'loading error';
    return;
  }
  dataPanel = mountDataPanel({
    db, storage: localStorage, note,
    current: () => (app.trainer ? app.doc : null),
    busy: () => app.busy,
    onImported: (result) => {
      dataPanel.close();
      showImported(result, `Imported ${result.user}: ${result.doc?.positions.length ?? 0} positions, stats for ${result.stats} positions${result.games ? `, ${result.games} games` : ''}.`);
    },
  });
  wire();
  renderDefaults();
  const [lastUser, lastSource, options, cliDoc, calibration] = await Promise.all([
    getSetting(db, 'lastUser'), getSetting(db, 'lastSource'), loadOptions(), loadCliDoc(), getSetting(db, CALIBRATION_SETTING),
  ]);
  app.cliDoc = cliDoc;
  calStore = calibration ?? null;
  $('name').value = lastUser ?? '';
  fillOptions(options);
  const link = await importFromLink();
  if (link === true) {
    note('start', { view: 'trainer', source: 'link', lastUser: lastUser ?? null, cli: !!cliDoc });
    return;
  }
  const browserDoc = lastUser ? await getPositions(db, lastUser) : null;
  app.imported = lastUser ? (await getSetting(db, importMarkerName(lastUser))) ?? null : null;
  const choice = chooseStart({ lastSource, browserDoc, cliDoc });
  note('start', { view: choice.view, source: choice.view === 'trainer' ? choice.source : null, lastUser: lastUser ?? null, cli: !!cliDoc });
  const linkError = typeof link === 'string' ? link : '';
  if (choice.view === 'trainer') {
    showDoc(choice.doc, choice.source);
    if (linkError) showProgress({ phase: linkError });
  } else showStart(linkError);
}

init();
