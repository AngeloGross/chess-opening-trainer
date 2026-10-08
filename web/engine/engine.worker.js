// Engine worker: one Stockfish 19 lite (single-threaded WASM) instance, one search at a time.
//
// Classic worker, not a module worker, because the vendored build is a classic script (an IIFE with no
// exports) that must be loaded with importScripts(), which module workers do not have. Inside a worker
// the build installs its own `onmessage` (if none is set), writes every UCI output line with the global
// `postMessage`, and fetches the .wasm from the URL in this worker's `location.hash` (it would otherwise
// guess engine.worker.wasm). So pool.js starts this worker as `engine.worker.js#<encoded .wasm URL>`.
// The pure UCI parser is an ES module and comes in through dynamic import(), which classic workers support.
//
// Protocol (design §7), page -> worker:
//   {type:'analyse', id, fen, depth, multipv}   queued, run one at a time
//   {type:'stop'}                               stops the running search, drops queued jobs
// worker -> page:
//   {type:'ready', name}                        once, after uciok/readyok; `name` is the UCI id name
//   {type:'result', id, lines:[[uci|null, cp], ...], nodes, timeMs}
//   {type:'error', id, message, stopped?}       id null for start-up failures; stopped:true after 'stop'
// Terminal positions (mate, stalemate, insufficient material) are short-cut in pool.js, like engine.py.

'use strict';

const VENDOR = '../vendor/stockfish@19.0.0/stockfish-19-lite-single.js';
const HASH_MB_DEFAULT = 32;

const post = self.postMessage.bind(self);

function fail(id, message, extra = {}) {
  post({ type: 'error', id, message, ...extra });
}

// The build calls WebAssembly.instantiateStreaming without a fallback, which rejects when the server
// does not send `Content-Type: application/wasm`. Fall back to arrayBuffer() + instantiate (design §13.1).
const instantiateStreaming = WebAssembly.instantiateStreaming?.bind(WebAssembly);
WebAssembly.instantiateStreaming = async (source, imports) => {
  const resp = await source;
  const type = resp.headers.get('Content-Type') || '';
  if (instantiateStreaming && type.split(';')[0].trim() === 'application/wasm') return instantiateStreaming(resp, imports);
  return WebAssembly.instantiate(await resp.arrayBuffer(), imports);
};

// Engine output: the build posts each line with the global postMessage; route it to onLine instead.
let onLine = (_line) => {};
self.postMessage = (msg) => {
  if (typeof msg === 'string') onLine(msg);
};

if (!location.hash) fail(null, 'engine.worker.js needs the .wasm URL in its hash (start it via pool.js)');
importScripts(VENDOR);
// With onmessage still unset, the build installed its own handler: that is the engine's stdin.
const engineInput = self.onmessage;
const send = (cmd) => engineInput({ data: cmd });

/** Wait for the first engine line for which `match` returns true; earlier lines go to `each`. */
function until(match, each = () => {}) {
  return new Promise((resolve) => {
    onLine = (line) => {
      if (match(line)) resolve(line);
      else each(line);
    };
  });
}

const queue = [];
let generation = 0; // bumped by 'stop'; jobs from an older generation answer {stopped: true}
let searching = false;
let pumping = false;
let multipv = 1;
let started; // Promise<uci module>

async function start() {
  const uci = await import('./uci.js');
  let name = 'unknown engine';
  const uciok = until((l) => l === 'uciok', (l) => {
    if (l.startsWith('id name ')) name = l.slice(8).trim();
  });
  send('uci');
  await uciok;
  send('setoption name Threads value 1');
  send(`setoption name Hash value ${HASH_MB_DEFAULT}`);
  send(`setoption name MultiPV value ${multipv}`);
  const ready = until((l) => l === 'readyok');
  send('isready');
  await ready;
  post({ type: 'ready', name });
  return uci;
}

async function run(job) {
  const uci = await started;
  const stopped = () => job.gen !== generation;
  if (stopped()) return fail(job.id, 'stopped', { stopped: true });
  if (job.multipv !== multipv) {
    multipv = job.multipv;
    send(`setoption name MultiPV value ${multipv}`);
  }
  // A fresh hash per search makes every result depend on (fen, depth, multipv) only, not on which
  // positions this worker happened to see before: reproducible, and safe to cache across workers.
  send('ucinewgame');
  const ready = until((l) => l === 'readyok');
  send('isready');
  await ready;
  if (stopped()) return fail(job.id, 'stopped', { stopped: true });
  const collector = new uci.SearchCollector();
  const done = until((l) => collector.push(l));
  const t0 = performance.now();
  searching = true;
  send(`position fen ${job.fen}`);
  send(`go depth ${job.depth}`);
  await done;
  searching = false;
  const timeMs = Math.round(performance.now() - t0);
  if (stopped()) return fail(job.id, 'stopped', { stopped: true });
  const lines = collector.lines();
  if (lines.length === 0) return fail(job.id, `engine returned no move for ${job.fen}`);
  post({ type: 'result', id: job.id, lines, nodes: collector.nodes, timeMs });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      await run(job);
    } catch (err) {
      searching = false;
      fail(job.id, String(err?.message ?? err));
    }
  }
  pumping = false;
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg?.type === 'analyse') {
    const { id, fen, depth, multipv: mpv = 1 } = msg;
    if (typeof fen !== 'string' || /[\r\n]/.test(fen) || !Number.isInteger(depth) || depth < 1 || !Number.isInteger(mpv) || mpv < 1) {
      fail(id, 'bad analyse request');
      return;
    }
    queue.push({ id, fen: fen.trim(), depth, multipv: mpv, gen: generation });
    pump();
  } else if (msg?.type === 'stop') {
    generation++;
    for (const job of queue.splice(0)) fail(job.id, 'stopped', { stopped: true });
    if (searching) send('stop');
  }
};

started = start();
started.catch((err) => fail(null, `engine start failed: ${err?.message ?? err}`));
