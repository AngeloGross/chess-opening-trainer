import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Chess } from '../web/vendor/chess.js@1.4.0/dist/esm/chess.js';
import { acceptableMoves } from '../web/core/aggregate.js';
import { gameUrl, playerColor } from '../web/core/analyse.js';
import { MATE_CP, fenKey, round1, scoreToCp } from '../web/core/fen.js';

const keyAfter = (...sans) => {
  const board = new Chess();
  for (const san of sans) board.move(san);
  return fenKey(board.fen());
};

describe('fenKey', () => {
  it('ignores move counters', () => {
    const a = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const b = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 4 9';
    expect(fenKey(a)).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -');
    expect(fenKey(b)).toBe(fenKey(a));
  });

  // Expected strings are python-chess board.fen() output (en_passant="legal").
  it('writes the ep square only when an ep capture is legal, like python-chess', () => {
    expect(keyAfter('e4')).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -');
    expect(keyAfter('e4', 'Nf6', 'e5', 'd5')).toBe('rnbqkb1r/ppp1pppp/5n2/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6');
    expect(keyAfter('Nf3', 'd5', 'Nc3', 'd4', 'e4')).toBe('rnbqkbnr/ppp1pppp/8/8/3pP3/2N2N2/PPPP1PPP/R1BQKB1R b KQkq e3');
    // exd6 e.p. would expose Kc3 to Bg7: pseudo-legal only, so no ep square.
    expect(keyAfter('e4', 'g6', 'e5', 'Bg7', 'Ke2', 'Nc6', 'Kd3', 'Nb8', 'Kc3', 'd5'))
      .toBe('rnbqk1nr/ppp1ppbp/6p1/3pP3/8/2K5/PPPP1PPP/RNBQ1BNR w kq -');
  });
});

describe('scoreToCp', () => {
  it('maps mates to +/-10000 for the side to move', () => {
    expect(scoreToCp({ mate: 3 })).toBe(MATE_CP);
    expect(scoreToCp({ mate: -2 })).toBe(-MATE_CP);
    expect(scoreToCp({ mate: 0 })).toBe(-MATE_CP);
    expect(scoreToCp({ cp: 37 })).toBe(37);
  });
});

describe('round1', () => {
  it('rounds exact ties half to even', () => {
    expect([0.25, 0.75, 20.25, 20.75, 140.25, -0.25, -0.75].map(round1)).toEqual([0.2, 0.8, 20.2, 20.8, 140.2, -0.2, -0.8]);
  });

  it('rounds the binary value of decimal near-ties like Python', () => {
    // 0.35 is 0.34999..., 0.45 is 0.45000...01, 20.15 is 20.149999...
    expect([0.35, 0.45, 20.15, 20.05, 2.675].map(round1)).toEqual([0.3, 0.5, 20.1, 20.1, 2.7]);
  });

  it('matches Python round(x, 1) on every golden value', () => {
    const { cases } = JSON.parse(readFileSync(new URL('../spec/golden/round1.json', import.meta.url), 'utf8'));
    expect(cases.length).toBeGreaterThan(100);
    for (const [num, den, expected] of cases) expect([num, den, round1(num / den)]).toEqual([num, den, expected]);
  });
});

describe('helpers', () => {
  it('acceptableMoves keeps the strict window minus recorded mistakes', () => {
    const top = [['e2e4', 30], ['d2d4', 15], ['c2c4', 5]];
    expect(acceptableMoves(top, new Set(), 20)).toEqual(['e2e4', 'd2d4']);
    expect(acceptableMoves(top, new Set(['e2e4']), 20)).toEqual(['d2d4']);
    expect(acceptableMoves([], new Set(), 20)).toEqual([]);
  });

  it('playerColor and gameUrl', () => {
    const game = {
      id: 'abc',
      players: { white: { user: { id: 'x' } }, black: { user: { name: 'AngelOgro', id: 'angelogro' } } },
    };
    expect(playerColor(game, 'AngelOgro')).toBe('black');
    expect(playerColor(game, 'someone')).toBeNull();
    expect(gameUrl(game, 'black', 7)).toBe('https://lichess.org/abc/black#7');
    expect(gameUrl(game, 'white')).toBe('https://lichess.org/abc');
    expect(gameUrl(game, 'white', 0)).toBe('https://lichess.org/abc#0');
  });
});
