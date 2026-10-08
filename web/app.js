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

import { Coordinator, DEFAULT_PERFS, LAZY_TOP, defaultOptions } from './analysis/coordinator.js';
import { chooseStart, cliOffer, loadCliDoc } from './core/startChoice.js';
import { EnginePool, defaultWorkerCount } from './engine/pool.js';
import { getPositions, getSetting, openDb, setSetting, userIdOf } from './store/db.js';
import { mountTrainer } from './trainer.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = defaultOptions();
const OPTIONS_SETTING = 'analysisOptions';
const MAX_GAMES_LIMIT = 5000;
// Lichess user names: 2-30 letters, digits, '_' or '-'.
const NAME_PATTERN = /^[A-Za-z0-9_-]{2,30}$/;

/** App state, also read by the console and the headless checks (CDP). `events` is a timeline. */
const app = (window.app = {
  view: 'loading', source: null, doc: null, cliDoc: null, trainer: null, coordinator: null,
  busy: false, progress: null, events: [],
});

/** @type {IDBDatabase} */
let db;
/** @type {EnginePool|null} */
let pool = null;
/** @type {Worker|null} */
let fetchWorker = null;

function note(type, extra = {}) {
  app.events.push({ type, at: Date.now(), ...extra });
}

// ---------- formatting ----------

function duration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function when(generated) {
  const d = new Date(generated ?? '');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function lichessMessage(kind, name, message) {
  switch (kind) {
    case 'not_found': return `There is no Lichess player called “${name}”. Check the spelling.`;
    case 'closed': return `The Lichess account “${name}” is closed.`;
    case 'rate_limited': return 'Lichess asked us to slow down. Wait a minute, then press Start again.';
    case 'network': return 'Could not reach Lichess. Check the internet connection, wait a minute and try again.';
    default: return message || 'Something went wrong while downloading the games.';
  }
}

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
  const origin = app.source === 'cli' ? 'Command-line analysis' : 'Analysed in this browser';
  $('source-info').textContent = `${origin} · ${doc.games ?? '?'} games${depth} · ${when(doc.generated)}`;

  const offer = cliOffer(app.cliDoc);
  $('update').hidden = app.busy || app.source !== 'browser';
  $('use-cli').hidden = app.busy || !offer || app.source === 'cli';
  if (offer) $('use-cli').textContent = `Use command-line analysis (${offer.user}, ${offer.positions} positions)`;
  $('to-start').hidden = app.busy;
  $('to-start').textContent = app.source === 'cli' ? 'Analyse in the browser' : 'Change user';
}

function showError(text) {
  $('start-error').textContent = text;
  $('start-error').hidden = !text;
}

function showStart(error = '') {
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
    app.trainer = mountTrainer($('trainer'), doc, { migrateLegacyStats: source === 'cli' });
    note('trainer-mount', { source, positions: doc.positions.length, games: doc.games });
  }
  $('player').textContent = doc.user ? `for ${doc.user}` : '';
  renderBar();
}

async function useCli() {
  if (!app.cliDoc || app.busy) return;
  await setSetting(db, 'lastSource', 'cli');
  showDoc(app.cliDoc, 'cli');
}

// ---------- settings ----------

async function loadOptions() {
  const o = (await getSetting(db, OPTIONS_SETTING)) ?? {};
  return { maxGames: o.maxGames ?? DEFAULTS.maxGames, depth: o.depth ?? DEFAULTS.depth };
}

function fillOptions({ maxGames, depth }) {
  $('opt-games').value = String(maxGames);
  if (![...$('opt-depth').options].some((o) => o.value === String(depth))) $('opt-depth').add(new Option(String(depth), String(depth)));
  $('opt-depth').value = String(depth);
}

function readOptions() {
  const games = Math.round(Number($('opt-games').value));
  return {
    maxGames: Number.isFinite(games) && games >= 1 ? Math.min(games, MAX_GAMES_LIMIT) : DEFAULTS.maxGames,
    depth: Number($('opt-depth').value) || DEFAULTS.depth,
  };
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
  const eta = paused ? '' : left ? (p.etaMs === null ? ' · estimating the time left…' : ` · about ${duration(p.etaMs)} left`) : '';
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
    const end = (result) => {
      worker.terminate();
      fetchWorker = null;
      resolve({ name, ...result });
    };
    const downloading = (m, extra = '') => showProgress({
      phase: `Downloading ${name}'s games: ${Math.min(m.stored, maxGames)} / ${maxGames}`,
      value: Math.min(1, m.stored / maxGames), detail: `${m.added} new${extra}`, stop: true,
    });
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'user') {
        name = m.name;
        showProgress({ phase: `Downloading ${name}'s games…`, value: null, stop: true });
      } else if (m.type === 'progress') downloading(m);
      else if (m.type === 'note') $('progress-detail').textContent = m.message;
      else if (m.type === 'retry') {
        showProgress({ phase: `Lichess asked us to slow down. Trying again in ${Math.round(m.delayMs / 1000)} s…`, value: null, stop: true });
      } else if (m.type === 'done') end({ kind: 'done', added: m.added, stored: m.stored });
      else if (m.type === 'stopped') end({ kind: 'stopped' });
      else if (m.type === 'error') end({ kind: 'error', errorKind: m.kind, message: m.message });
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
  try {
    const fetched = await download(user, options.maxGames);
    note('download-end', { kind: fetched.kind, added: fetched.added, stored: fetched.stored });
    if (fetched.kind !== 'done') {
      const text = fetched.kind === 'stopped' ? 'Download stopped.' : lichessMessage(fetched.errorKind, fetched.name, fetched.message);
      if (app.view === 'start') {
        hideProgress();
        showStart(fetched.kind === 'stopped' ? '' : text);
      } else showProgress({ phase: text });
      return;
    }
    const name = fetched.name;
    await setSetting(db, 'lastUser', name);
    await setSetting(db, 'lastSource', 'browser');
    await setSetting(db, OPTIONS_SETTING, options);
    $('name').value = name;

    pool ??= new EnginePool({ size: defaultWorkerCount() });
    const co = (app.coordinator = new Coordinator({
      db, pool, user: name,
      options: { maxGames: options.maxGames, depth: options.depth, multipv: DEFAULTS.multipv, lazyTop: LAZY_TOP },
      onProgress: showAnalysisProgress,
      onCheckpoint: (doc) => showDoc(doc, 'browser'),
    }));
    note('analysis-start', { user: name });
    const { state, doc, progress } = await co.run();
    note('analysis-end', { state, positions: doc?.positions.length ?? 0, games: progress.gamesTotal, engineSearches: progress.engineSearches, cacheHits: progress.cacheHits });
    if (!doc) {
      const text = `No blitz, rapid or classical games of ${name} to analyse.`;
      hideProgress();
      if (app.view === 'start') showStart(text);
      else showProgress({ phase: text });
    } else if (state === 'stopped') {
      showProgress({ phase: `Stopped after ${progress.gamesDone} of ${progress.gamesTotal} games. “Update” continues where it stopped.` });
    } else {
      showProgress({ phase: `Done: ${doc.positions.length} positions from ${doc.games} games (${duration(progress.elapsedMs)}).` });
    }
  } catch (err) {
    console.error(err);
    note('run-error', { message: String(err?.message ?? err) });
    pool?.terminate();
    pool = null; // a failed engine pool is not reused
    showProgress({ phase: `The analysis failed: ${err?.message ?? err}` });
    if (app.view === 'start') $('start-form').hidden = false;
  } finally {
    app.busy = false;
    app.coordinator = null;
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
  $('pause').addEventListener('click', () => app.coordinator?.pause());
  $('resume').addEventListener('click', () => app.coordinator?.resume());
  $('stop').addEventListener('click', () => {
    if (fetchWorker) fetchWorker.postMessage({ type: 'stop' });
    else app.coordinator?.stop();
    $('stop').disabled = true;
    setTimeout(() => { $('stop').disabled = false; }, 500);
  });
}

async function init() {
  try {
    db = await openDb();
  } catch (err) {
    $('loading').textContent = `This browser does not allow storing data for this page (${err?.message ?? err}).`;
    return;
  }
  wire();
  renderDefaults();
  const [lastUser, lastSource, options, cliDoc] = await Promise.all([
    getSetting(db, 'lastUser'), getSetting(db, 'lastSource'), loadOptions(), loadCliDoc(),
  ]);
  app.cliDoc = cliDoc;
  $('name').value = lastUser ?? '';
  fillOptions(options);
  const browserDoc = lastUser ? await getPositions(db, lastUser) : null;
  const choice = chooseStart({ lastSource, browserDoc, cliDoc });
  note('start', { view: choice.view, source: choice.view === 'trainer' ? choice.source : null, lastUser: lastUser ?? null, cli: !!cliDoc });
  if (choice.view === 'trainer') showDoc(choice.doc, choice.source);
  else showStart();
}

init();
