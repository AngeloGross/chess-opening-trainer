// Pool of engine workers with a job queue: the browser counterpart of engine.py's Engine
// (evaluate / topMoves, same result shapes), minus the cache (design slice 5 adds it in front of `analyse`).
// Throughput comes from several single-threaded engines searching different positions (design §3.2).

import { Chess } from '../vendor/chess.js@1.4.0/dist/esm/chess.js';
import { MATE_CP } from '../core/fen.js';

export const MULTIPV = 5;
const START_TIMEOUT_MS = 30_000;

export class EngineAnalysisError extends Error {
  constructor(message, { stopped = false } = {}) {
    super(message);
    this.name = 'EngineAnalysisError';
    this.stopped = stopped;
  }
}

/**
 * A phone or tablet, judged by the user agent (design §8: fewer workers and cheaper analysis defaults).
 * @param {{userAgent?: string, userAgentData?: {mobile?: boolean}}} [nav]
 * @returns {boolean}
 */
export function isMobile(nav = globalThis.navigator ?? {}) {
  return nav.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? '');
}

/**
 * Workers to start: min(hardwareConcurrency − 1, 4) on desktop, 2 on a mobile user agent, at least 1.
 * @param {{hardwareConcurrency?: number, userAgent?: string, userAgentData?: {mobile?: boolean}}} [nav]
 * @returns {number}
 */
export function defaultWorkerCount(nav = globalThis.navigator ?? {}) {
  if (isMobile(nav)) return 2;
  const cores = Number(nav.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(cores - 1, 4));
}

/** python-chess `Board.has_insufficient_material(color)` on a FEN placement field. */
function insufficientFor(placement, color) {
  const own = color === 'w' ? /[PNBRQK]/ : /[pnbrqk]/;
  const pieces = []; // [lower-case type, colour, square colour]
  placement.split('/').forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { file += Number(ch); continue; }
      pieces.push([ch.toLowerCase(), own.test(ch) ? 'us' : 'them', (file + (7 - r)) % 2 === 0 ? 'dark' : 'light']);
      file++;
    }
  });
  const us = pieces.filter((p) => p[1] === 'us');
  if (us.some(([t]) => t === 'p' || t === 'r' || t === 'q')) return false;
  if (us.some(([t]) => t === 'n')) {
    // A lone knight can only mate if the opponent has pieces (other than queens) to block with.
    return us.length <= 2 && !pieces.some(([t, side]) => side === 'them' && t !== 'k' && t !== 'q');
  }
  if (us.some(([t]) => t === 'b')) {
    const bishops = pieces.filter(([t]) => t === 'b');
    const sameColour = bishops.every((b) => b[2] === 'dark') || bishops.every((b) => b[2] === 'light');
    return sameColour && !pieces.some(([t]) => t === 'p' || t === 'n');
  }
  return true;
}

/**
 * engine.py's short cut for positions without a search: checkmate → [[null, −10000]],
 * stalemate or insufficient material (python-chess rules) → [[null, 0]], otherwise null.
 * @param {string} fen
 * @returns {[null, number][] | null}
 */
export function terminalLines(fen) {
  const board = new Chess(fen);
  if (board.isCheckmate()) return [[null, -MATE_CP]];
  if (board.isStalemate()) return [[null, 0]];
  const placement = fen.trim().split(/\s+/)[0];
  if (insufficientFor(placement, 'w') && insufficientFor(placement, 'b')) return [[null, 0]];
  return null;
}

/**
 * @typedef {[string | null, number]} EvalLine
 * @typedef {{lines: EvalLine[], pvs: string[][], nodes: number, timeMs: number}} Analysis  pvs: one PV per line (UCI)
 */

export class EnginePool {
  /**
   * @param {{size?: number, workerUrl?: string | URL, wasmUrl?: string | URL}} [opts]
   */
  constructor({ size = defaultWorkerCount(), workerUrl, wasmUrl } = {}) {
    const worker = new URL(workerUrl ?? './engine.worker.js', import.meta.url);
    const wasm = new URL(wasmUrl ?? '../vendor/stockfish@19.0.0/stockfish-19-lite-single.wasm', import.meta.url);
    // The vendored build reads the .wasm URL from the worker's hash (see engine.worker.js).
    worker.hash = encodeURIComponent(wasm.href);
    this.size = size;
    /** @type {string | null} UCI id name, e.g. "Stockfish 19 Lite WASM"; part of a future cache key */
    this.name = null;
    this._queue = [];
    this._nextId = 1;
    this._closed = false;
    this._slots = Array.from({ length: size }, () => this._spawn(worker));
    this._ready = Promise.all(this._slots.map((s) => s.ready)).then((names) => (this.name = names[0]));
    this._ready.catch(() => {}); // surfaced through ready() and every job
  }

  _spawn(url) {
    const slot = { worker: new Worker(url), job: null, alive: true, ready: null };
    slot.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new EngineAnalysisError('engine did not start in time')), START_TIMEOUT_MS);
      slot.worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === 'ready') {
          clearTimeout(timer);
          slot.isReady = true;
          resolve(msg.name);
          this._dispatch();
        } else if (msg.id === null || msg.id === undefined) {
          clearTimeout(timer);
          this._kill(slot, new EngineAnalysisError(msg.message));
          reject(new EngineAnalysisError(msg.message));
        } else {
          this._settle(slot, msg);
        }
      };
      slot.worker.onerror = (ev) => {
        ev.preventDefault?.();
        clearTimeout(timer);
        const err = new EngineAnalysisError(`engine worker failed: ${ev.message || 'unknown error'}`);
        this._kill(slot, err);
        reject(err);
      };
    });
    return slot;
  }

  _kill(slot, err) {
    if (!slot.alive) return;
    slot.alive = false;
    slot.worker.terminate();
    if (slot.job) slot.job.reject(err);
    slot.job = null;
    if (!this._slots.some((s) => s.alive)) for (const job of this._queue.splice(0)) job.reject(err);
    else this._dispatch();
  }

  _settle(slot, msg) {
    const job = slot.job;
    if (!job || job.id !== msg.id) return; // answer to a job that was already given up
    slot.job = null;
    if (msg.type === 'result') job.resolve({ lines: msg.lines, pvs: msg.pvs ?? msg.lines.map(() => []), nodes: msg.nodes, timeMs: msg.timeMs });
    else job.reject(new EngineAnalysisError(msg.message, { stopped: !!msg.stopped }));
    this._dispatch();
  }

  _dispatch() {
    for (const slot of this._slots) {
      if (!this._queue.length) return;
      if (!slot.alive || !slot.isReady || slot.job) continue;
      const job = this._queue.shift();
      slot.job = job;
      slot.worker.postMessage({ type: 'analyse', id: job.id, fen: job.fen, depth: job.depth, multipv: job.multipv });
    }
  }

  /** Resolves with the engine name once every worker has started; rejects if any failed. */
  ready() {
    return this._ready;
  }

  /** Workers that started and have not failed. */
  get workers() {
    return this._slots.filter((s) => s.alive).length;
  }

  /** Jobs waiting for a worker plus jobs being searched. */
  get pending() {
    return this._queue.length + this._slots.filter((s) => s.job).length;
  }

  /**
   * One search: `{lines, pvs, nodes, timeMs}`, lines `[[uci|null, cp], ...]` best first, cp for the side to move,
   * pvs the principal variation of each line.
   * Terminal positions are answered without the engine (nodes 0). This is the single entry point a cache
   * keyed by (engine name, fenKey, depth, multipv) can wrap later.
   * @param {string} fen @param {number} depth @param {number} [multipv]
   * @returns {Promise<Analysis>}
   */
  analyse(fen, depth, multipv = 1) {
    if (this._closed) return Promise.reject(new EngineAnalysisError('engine pool is terminated'));
    let terminal;
    try {
      terminal = terminalLines(fen);
    } catch (err) {
      return Promise.reject(new EngineAnalysisError(`invalid FEN: ${err.message}`));
    }
    if (terminal) return Promise.resolve({ lines: terminal, pvs: [[]], nodes: 0, timeMs: 0 });
    if (!this.workers) return Promise.reject(new EngineAnalysisError('no engine worker is running'));
    return new Promise((resolve, reject) => {
      this._queue.push({ id: this._nextId++, fen, depth, multipv, resolve, reject });
      this._dispatch();
    });
  }

  /**
   * engine.py `evaluate`: (best move in UCI or null, eval in cp for the side to move).
   * @returns {Promise<EvalLine>}
   */
  async evaluate(fen, depth) {
    return (await this.analyse(fen, depth, 1)).lines[0];
  }

  /**
   * engine.py `top_moves`: up to n best moves with their evals, best first (MultiPV); no null moves.
   * @returns {Promise<[string, number][]>}
   */
  async topMoves(fen, depth, n = MULTIPV) {
    return /** @type {[string, number][]} */ ((await this.analyse(fen, depth, n)).lines.filter((l) => l[0] !== null));
  }

  /** Stop running searches and drop queued jobs; their promises reject with `stopped: true`. */
  stop() {
    const err = new EngineAnalysisError('stopped', { stopped: true });
    for (const job of this._queue.splice(0)) job.reject(err);
    for (const slot of this._slots) if (slot.alive && slot.job) slot.worker.postMessage({ type: 'stop' });
  }

  /** Kill every worker; pending jobs reject. The pool cannot be used afterwards. */
  terminate() {
    this._closed = true;
    const err = new EngineAnalysisError('engine pool is terminated', { stopped: true });
    for (const slot of this._slots) this._kill(slot, err);
  }
}
