import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MATE_CP } from '../web/core/fen.js';
import { SearchCollector, parseBestmove, parseInfo, reduceSearch } from '../web/engine/uci.js';
import { defaultWorkerCount, terminalLines } from '../web/engine/pool.js';

describe('parseInfo', () => {
  it('reads depth, multipv, cp score, nodes and pv', () => {
    const info = parseInfo('info depth 14 seldepth 20 multipv 2 score cp -35 nodes 123456 nps 650000 hashfull 12 time 190 pv d2d4 e5d4 f3d4');
    expect(info).toEqual({ depth: 14, multipv: 2, score: { cp: -35 }, bound: null, nodes: 123456, pv: ['d2d4', 'e5d4', 'f3d4'] });
  });

  it('reads mate scores and bounds; multipv defaults to 1', () => {
    expect(parseInfo('info depth 9 score mate -3 nodes 10 pv e1e2').score).toEqual({ mate: -3 });
    expect(parseInfo('info depth 9 score mate -3 nodes 10 pv e1e2').multipv).toBe(1);
    expect(parseInfo('info depth 9 multipv 1 score cp 20 lowerbound nodes 5 pv e2e4').bound).toBe('lower');
    expect(parseInfo('info depth 9 multipv 1 score cp 20 upperbound nodes 5 pv e2e4').bound).toBe('upper');
    expect(parseInfo('info depth 0 score mate 0')).toEqual({ depth: 0, multipv: 1, score: { mate: 0 }, bound: null, nodes: null, pv: [] });
  });

  it('ignores lines without a score and partial lines', () => {
    expect(parseInfo('info depth 14 currmove e2e4 currmovenumber 1')).toBeNull();
    expect(parseInfo('info string NNUE evaluation using nn-61e7af4bb97d.nnue')).toBeNull();
    expect(parseInfo('info depth 14 seldepth 20 multipv 1 score')).toBeNull();
    expect(parseInfo('info depth 14 seldepth 20 multipv 1 score cp')).toBeNull();
    expect(parseInfo('info depth')).toBeNull();
    expect(parseInfo('bestmove e2e4')).toBeNull();
    expect(parseInfo('')).toBeNull();
  });
});

describe('parseBestmove', () => {
  it('reads the move, ignores ponder, maps (none) to null', () => {
    expect(parseBestmove('bestmove e2e4 ponder e7e5')).toEqual({ move: 'e2e4' });
    expect(parseBestmove('bestmove e7e8q')).toEqual({ move: 'e7e8q' });
    expect(parseBestmove('bestmove (none)')).toEqual({ move: null });
    expect(parseBestmove('bestmove')).toBeNull();
    expect(parseBestmove('info depth 1 score cp 0 pv e2e4')).toBeNull();
  });
});

describe('reduceSearch', () => {
  it('keeps the deepest exact line per multipv, sorted by multipv', () => {
    const lines = [
      'info string NNUE evaluation using nn-61e7af4bb97d.nnue enabled',
      'info depth 1 seldepth 1 multipv 1 score cp 18 nodes 20 pv e2e4',
      'info depth 1 seldepth 1 multipv 2 score cp 10 nodes 20 pv d2d4',
      'info depth 2 seldepth 2 multipv 1 score cp 30 nodes 60 pv d2d4 d7d5',
      'info depth 2 seldepth 2 multipv 2 score cp 25 nodes 60 pv e2e4 e7e5',
      'info depth 3 currmove g1f3 currmovenumber 3',
      // aspiration re-search: a bound, not a final score
      'info depth 3 seldepth 3 multipv 1 score cp 90 lowerbound nodes 90 pv c2c4',
      // printed out of order: multipv 2 before 1
      'info depth 3 seldepth 4 multipv 2 score cp 21 nodes 140 pv d2d4 d7d5',
      'info depth 3 seldepth 4 multipv 1 score cp 29 nodes 140 pv e2e4 e7e5 g1f3',
      'bestmove e2e4 ponder e7e5',
    ];
    expect(reduceSearch(lines)).toEqual([['e2e4', 29], ['d2d4', 21]]);
  });

  it('a line from an unfinished deeper iteration does not displace a deeper one from the same index', () => {
    const lines = [
      'info depth 5 multipv 1 score cp 40 nodes 1 pv e2e4',
      'info depth 5 multipv 2 score cp 30 nodes 1 pv d2d4',
      'info depth 6 multipv 1 score cp 35 nodes 2 pv e2e4',
      // Stockfish prints not-yet-searched lines with depth - 1 when the search ends early
      'info depth 5 multipv 2 score cp 30 nodes 2 pv d2d4',
      'bestmove e2e4',
    ];
    expect(reduceSearch(lines)).toEqual([['e2e4', 35], ['d2d4', 30]]);
  });

  it('at equal depth the later line wins', () => {
    const lines = [
      'info depth 8 multipv 1 score cp 12 nodes 1 pv g1f3',
      'info depth 8 multipv 1 score cp 15 nodes 2 pv e2e4',
      'bestmove e2e4',
    ];
    expect(reduceSearch(lines)).toEqual([['e2e4', 15]]);
  });

  it('maps mates to ±10000 for the side to move, including negative mates', () => {
    const lines = [
      'info depth 10 multipv 1 score mate 3 nodes 1 pv h5f7',
      'info depth 10 multipv 2 score cp 150 nodes 1 pv d1h5',
      'info depth 10 multipv 3 score mate -2 nodes 1 pv g2g4',
      'bestmove h5f7',
    ];
    expect(reduceSearch(lines)).toEqual([['h5f7', MATE_CP], ['d1h5', 150], ['g2g4', -MATE_CP]]);
  });

  it('bestmove (none) in a mated position gives [[null, -10000]]; in stalemate [[null, 0]]', () => {
    expect(reduceSearch(['info depth 0 score mate 0', 'bestmove (none)'])).toEqual([[null, -MATE_CP]]);
    expect(reduceSearch(['info depth 0 score cp 0', 'bestmove (none)'])).toEqual([[null, 0]]);
  });

  it('gives an empty result when the engine produced no usable line', () => {
    expect(reduceSearch(['bestmove (none)'])).toEqual([]);
    expect(reduceSearch(['info depth 1 multipv 1 score cp 10 lowerbound pv e2e4', 'bestmove e2e4'])).toEqual([]);
  });

  it('stops at bestmove and reports the last node count', () => {
    const c = new SearchCollector();
    expect(c.push('info depth 1 multipv 1 score cp 5 nodes 77 pv e2e4')).toBe(false);
    expect(c.push('bestmove e2e4')).toBe(true);
    expect(c.nodes).toBe(77);
  });
});

describe('terminalLines (engine.py short cut)', () => {
  it('checkmate → [[null, -10000]]', () => {
    expect(terminalLines('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3')).toEqual([[null, -MATE_CP]]);
  });
  it('stalemate → [[null, 0]]', () => {
    expect(terminalLines('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')).toEqual([[null, 0]]);
  });
  it('insufficient material follows python-chess', () => {
    expect(terminalLines('8/8/4k3/8/8/3K4/8/8 w - - 0 1')).toEqual([[null, 0]]); // K v K
    expect(terminalLines('8/8/4k3/8/8/3K4/5N2/8 w - - 0 1')).toEqual([[null, 0]]); // KN v K
    expect(terminalLines('8/8/4k3/2b5/8/3K4/5B2/8 w - - 0 1')).toEqual([[null, 0]]); // KB v KB, both dark squares
    expect(terminalLines('8/8/4k3/3b4/8/3K4/5B2/8 w - - 0 1')).toBeNull(); // opposite-coloured bishops
    expect(terminalLines('8/8/4k3/3n4/8/3K4/5N2/8 w - - 0 1')).toBeNull(); // KN v KN: helpmate exists
    expect(terminalLines('8/8/4k3/3q4/8/3K4/5N2/8 w - - 0 1')).toBeNull(); // queen side can win
    expect(terminalLines('8/8/4k3/8/8/3K4/5NN1/8 w - - 0 1')).toBeNull(); // KNN v K
  });
  it('ordinary positions → null', () => {
    expect(terminalLines('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBeNull();
  });
});

describe('defaultWorkerCount', () => {
  it('uses cores - 1, at most 4, at least 1; 2 on mobile', () => {
    expect(defaultWorkerCount({ hardwareConcurrency: 24, userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe(4);
    expect(defaultWorkerCount({ hardwareConcurrency: 3, userAgent: 'X11; Linux' })).toBe(2);
    expect(defaultWorkerCount({ hardwareConcurrency: 1, userAgent: '' })).toBe(1);
    expect(defaultWorkerCount({ hardwareConcurrency: 8, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' })).toBe(2);
    expect(defaultWorkerCount({ hardwareConcurrency: 8, userAgent: 'x', userAgentData: { mobile: true } })).toBe(2);
  });
});

// Smoke test against the vendored WASM build. Under Node, running the .js file directly makes it a
// UCI engine on stdin/stdout (its own CLI mode), so this exercises the real engine plus reduceSearch.
// The repo's package.json says "type": "module", so Node would load the classic script as ESM and fail;
// a temp copy named .cjs (with the .wasm beside it, where the build looks for it) runs as CommonJS.
const VENDOR = fileURLToPath(new URL('../web/vendor/stockfish@19.0.0/', import.meta.url));
const BASE = 'stockfish-19-lite-single';

function runEngine(script, commands, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`engine timed out; output so far:\n${out.slice(-500)}`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => {
      out += d;
      if (/^bestmove /m.test(out)) {
        clearTimeout(timer);
        proc.stdin.end('quit\n');
        resolve(out.split(/\r?\n/));
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.stdin.write(commands.map((c) => `${c}\n`).join(''));
  });
}

describe('vendored Stockfish WASM under Node (smoke)', () => {
  it('analyses the start position at depth 8 with MultiPV 3', async (ctx) => {
    if (!existsSync(join(VENDOR, `${BASE}.wasm`))) ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), 'sf-smoke-'));
    copyFileSync(join(VENDOR, `${BASE}.js`), join(dir, `${BASE}.cjs`));
    copyFileSync(join(VENDOR, `${BASE}.wasm`), join(dir, `${BASE}.wasm`));
    let out;
    try {
      out = await runEngine(join(dir, `${BASE}.cjs`), ['uci', 'setoption name MultiPV value 3', 'isready', 'position startpos', 'go depth 8']);
    } catch (err) {
      console.warn(`skipping WASM smoke test: ${err.message}`);
      ctx.skip();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(out).toContain('id name Stockfish 19 Lite WASM');
    const lines = reduceSearch(out.slice(out.indexOf('readyok')));
    expect(lines).toHaveLength(3);
    for (const [uci, cp] of lines) {
      expect(uci).toMatch(/^[a-h][1-8][a-h][1-8]$/);
      expect(Math.abs(cp)).toBeLessThan(150);
    }
    expect(lines[0][1]).toBeGreaterThanOrEqual(lines[1][1]);
  }, 60_000);
});
