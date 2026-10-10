// "Why am I better?" slice 1: settled material (shared with Python), the eval line, the pass test verdict
// and the on-demand explainer with a fake engine.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createExplainer } from '../web/analysis/explainer.js';
import { engineLine, formatEval, offersWhy, passFen, planGain, playerMaterial, verdict } from '../web/core/explain.js';
import { MATE_CP, fenKey } from '../web/core/fen.js';
import { settledMaterial } from '../web/core/material.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const A40 = 'rnbqkbnr/p1pppppp/1p6/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2'; // 1. d4 b6
const BLACK_TO_MOVE = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
const IN_CHECK = '4k3/8/8/8/8/8/4q3/4K3 w - - 0 1';
// d4 forks the knights on c5 and e5: a gain no capture on the board shows yet.
const FORK = '4k3/8/8/2n1n3/8/8/3P4/4K3 w - - 0 1';

describe('settledMaterial', () => {
  it('matches book.py settled_material on every golden position', () => {
    const { cases } = JSON.parse(readFileSync(new URL('../spec/golden/settled-material.json', import.meta.url), 'utf8'));
    expect(cases.length).toBeGreaterThan(500);
    expect(cases.filter(([fen, settled]) => settledMaterial(fen) !== settled)).toEqual([]);
  });

  it('is from the side to move in playerMaterial', () => {
    const blackUp = 'rnbqkbnr/pppppppp/8/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3'; // White has no e-pawn
    expect(settledMaterial(blackUp)).toBe(-1);
    expect(playerMaterial(blackUp)).toBe(1);
  });
});

describe('eval line', () => {
  it('formats pawns with one decimal and a real minus sign', () => {
    expect([89, -34, 4, -4, 100, 1234].map(formatEval)).toEqual(['+0.9', '−0.3', '0.0', '0.0', '+1.0', '+12.3']);
  });

  it('names the eval and the material for the player', () => {
    expect(engineLine({ evalCp: 100, material: 0 })).toBe('Engine: +1.0 for you · material equal');
    expect(engineLine({ evalCp: -40, material: 1 })).toBe('Engine: −0.4 for you · you are a pawn up');
    expect(engineLine({ evalCp: MATE_CP, material: -2 })).toBe('Engine: a forced mate for you · you are 2 pawns down');
  });

  it('offers "Why?" from +0.8 without extra material and without a mate', () => {
    expect(offersWhy({ evalCp: 80, material: 0 })).toBe(true);
    expect(offersWhy({ evalCp: 150, material: -1 })).toBe(true);
    expect(offersWhy({ evalCp: 79, material: 0 })).toBe(false);
    expect(offersWhy({ evalCp: 150, material: 1 })).toBe(false);
    expect(offersWhy({ evalCp: MATE_CP, material: 0 })).toBe(false);
  });
});

describe('passFen', () => {
  it('hands the move to the opponent, clears en passant, keeps castling', () => {
    expect(passFen(START)).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 1 1');
    expect(passFen(BLACK_TO_MOVE)).toBe('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
    expect(passFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1')).toBe('4k3/8/8/3pP3/8/8/8/4K3 b - - 1 1');
  });

  it('is null in check', () => {
    expect(passFen(IN_CHECK)).toBeNull();
  });
});

describe('planGain', () => {
  it('finds the first ply from which the player stays a pawn up', () => {
    expect(playerMaterial(FORK)).toBe(-5);
    expect(planGain(FORK, ['d2d4', 'e5c6', 'd4c5'])).toEqual({ gain: 3, moves: 2, moveNumber: 2 });
    expect(planGain(FORK, ['e1e2', 'e8e7', 'd2d4', 'e7e6', 'd4e5'])).toEqual({ gain: 2, moves: 3, moveNumber: 3 }); // Kxe5 takes the pawn back
  });

  it('is null when the gain is given back, after an illegal move, or without a gain', () => {
    expect(planGain(START, ['e2e4', 'd7d5', 'e4d5', 'g8f6', 'f1c4', 'f6d5'])).toBeNull(); // the d5 pawn is taken back
    expect(planGain(FORK, ['d2d4', 'a1a8'])).toBeNull();
    expect(planGain(START, ['e2e4', 'e7e5'])).toBeNull();
  });
});

describe('verdict', () => {
  it('static: the player keeps most of the advantage when passing', () => {
    const v = verdict({ fen: A40, evalCp: 100, passCp: 70, material: 0, pv: ['e2e4'] });
    expect(v.kind).toBe('static');
    expect(v.text).toBe('Your position itself is better (+1.0): even if it were Black\'s move, you would keep +0.7.');
  });

  it('dynamic: the advantage is gone if he passes; names the best move', () => {
    const v = verdict({ fen: A40, evalCp: 89, passCp: -5, material: 0, pv: ['e2e4', 'c8b7'] });
    expect(v.kind).toBe('dynamic');
    expect(v.text).toBe('Your advantage is in your next move, e4 (+0.9 now, about −0.1 if you did nothing).');
  });

  it('the boundary is STATIC_SHARE of the eval', () => {
    expect(verdict({ fen: A40, evalCp: 100, passCp: 60, material: 0 }).kind).toBe('static');
    expect(verdict({ fen: A40, evalCp: 100, passCp: 59, material: 0 }).kind).toBe('dynamic');
  });

  it('adds when best play wins material', () => {
    const v = verdict({ fen: FORK, evalCp: 120, passCp: 10, material: 0, pv: ['d2d4', 'e5c6', 'd4c5'] });
    expect(v.text).toBe('Your advantage is in your next move, d4 (+1.2 now, about +0.1 if you did nothing).'
      + ' With best play you win material worth 3 pawns within 2 moves (by move 2).');
    expect(v.plan).toEqual({ gain: 3, moves: 2, moveNumber: 2 });
  });

  it('material up and mate have their own sentences; White is named for Black', () => {
    expect(verdict({ fen: BLACK_TO_MOVE, evalCp: 100, passCp: 90, material: 1 }).text).toBe(
      'You are a pawn up (once the captures on the board are played out).');
    expect(verdict({ fen: BLACK_TO_MOVE, evalCp: 100, passCp: 90, material: 0 }).text).toContain('if it were White\'s move');
    expect(verdict({ fen: A40, evalCp: MATE_CP, passCp: 0, material: 0 })).toEqual({ kind: 'mate', text: 'You have a forced mate.', plan: null });
  });

  it('in check there is no pass test', () => {
    const v = verdict({ fen: IN_CHECK, evalCp: 100, passCp: null, material: -9, pv: ['e1e2'] });
    expect(v.kind).toBe('check');
    expect(v.text).toBe('You are in check, so there is nothing to compare: your advantage (+1.0) is in how you answer it, with Kxe2.');
  });
});

describe('createExplainer', () => {
  function fakeAnalyse(table) {
    const calls = [];
    const analyse = async (fen, depth, multipv) => {
      calls.push([fenKey(fen), depth, multipv]);
      const hit = table[fenKey(fen)];
      if (!hit) throw new Error('unknown position');
      return { lines: [[hit.pv[0] ?? null, hit.cp]], pvs: [hit.pv], nodes: 1, timeMs: 1 };
    };
    return { analyse, calls };
  }

  it('evaluates once per position and adds the pass search for the verdict', async () => {
    const pass = passFen(A40);
    const fake = fakeAnalyse({ [fenKey(A40)]: { cp: 89, pv: ['e2e4', 'c8b7'] }, [fenKey(pass)]: { cp: 5, pv: ['c8b7'] } });
    const ex = createExplainer({ analyse: fake.analyse, depth: 12 });
    expect(await ex.evaluation(A40)).toEqual({ evalCp: 89, pv: ['e2e4', 'c8b7'], material: 0 });
    expect(await ex.verdict(A40)).toMatchObject({ kind: 'dynamic', passCp: -5, evaluation: { evalCp: 89 } });
    await ex.verdict(A40);
    await ex.evaluation(A40);
    expect(fake.calls).toEqual([[fenKey(A40), 12, 1], [fenKey(pass), 12, 1]]);
  });

  it('tries again after a failed search', async () => {
    const table = {};
    const ex = createExplainer({ analyse: fakeAnalyse(table).analyse, depth: 12 });
    await expect(ex.evaluation(START)).rejects.toThrow('unknown position');
    table[fenKey(START)] = { cp: 30, pv: ['e2e4'] };
    expect(await ex.evaluation(START)).toMatchObject({ evalCp: 30 });
  });

  it('skips the pass search in check', async () => {
    const fake = fakeAnalyse({ [fenKey(IN_CHECK)]: { cp: 0, pv: ['e1e2'] } });
    const v = await createExplainer({ analyse: fake.analyse, depth: 12 }).verdict(IN_CHECK);
    expect(v).toMatchObject({ kind: 'check', passCp: null });
    expect(fake.calls).toHaveLength(1);
  });
});
