// "Why am I better?" slice 3: the feature catalogue on hand-built positions, the reasons and their sentences,
// and bestCapture (the threat of the engine's move).
import { describe, expect, it } from 'vitest';
import { MAX_REASONS, features, listing, reasons } from '../web/core/features.js';
import { bestCapture } from '../web/core/material.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const A40 = 'rnbqkbnr/p1pppppp/1p6/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2'; // 1. d4 b6, best 2. e4
// d4 forks the knights on c5 and e5.
const FORK = '4k3/8/8/2n1n3/8/8/3P4/4K3 w - - 0 1';
// White castled; Black's king stuck on e8 with the d- and e-files open and the rook on d1 hitting d7 and d8.
const KING_IN_CENTRE = '4k3/pp3ppp/8/8/8/8/PP3PPP/3R1RK1 w - - 0 1';

describe('features', () => {
  it('counts centre pawns and the attacks on the four centre squares', () => {
    const f = features('rnbqkbnr/p1pppppp/1p6/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2');
    expect(f.w.centre.pawns).toEqual(['d4', 'e4']);
    expect(f.b.centre.pawns).toEqual([]);
    expect(f.w.centre.control).toBeGreaterThan(f.b.centre.control);
  });

  it('finds the minor pieces still at home and a castled king', () => {
    const f = features('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 4');
    expect(f.w.development).toEqual({ home: ['b1', 'c1'], castled: true });
    expect(f.b.development).toEqual({ home: ['c8'], castled: false });
  });

  it('measures king safety: in the centre, open files, no castling, attacked squares next to it', () => {
    const { w, b } = features(KING_IN_CENTRE);
    expect(b.king).toEqual({ square: 'e8', centre: true, canCastle: false, openFiles: ['d', 'e'], shieldMissing: [], zone: ['d7', 'd8'] });
    expect(w.king).toMatchObject({ square: 'g1', centre: false, shieldMissing: [] });
    expect(features('6k1/5p1p/8/8/8/8/5PPP/6K1 w - - 0 1').b.king.shieldMissing).toEqual(['g']);
  });

  it('finds isolated, doubled, backward and pressured pawns', () => {
    expect(features('4k3/8/8/3p4/8/8/2PP4/4K3 w - - 0 1').b.pawns.isolated).toEqual(['d5']);
    expect(features('4k3/8/8/8/8/2P5/2P5/4K3 w - - 0 1').w.pawns.doubled).toEqual(['c3', 'c2']);
    expect(features('4k3/8/3p4/4p3/2P5/8/8/4K3 w - - 0 1').b.pawns.backward).toEqual(['d6']);
    expect(features('4k3/8/8/3p4/8/8/3R4/3RK3 b - - 0 1').b.pawns.pressured).toEqual(['d5']);
  });

  it('measures activity: piece moves for both sides, the bishop pair, outposts, rooks on open files', () => {
    const f = features('4k3/pp4pp/8/4N3/3P4/8/8/4K3 w - - 0 1');
    expect(f.w.activity.outposts).toEqual(['e5']);
    expect(f.w.activity.mobility).toBe(8);
    expect(f.b.activity.mobility).toBe(0);
    expect(features('4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1').w.activity.bishopPair).toBe(true);
    expect(features(KING_IN_CENTRE).w.activity.openRooks).toEqual(['d1']);
  });

  it('does not count piece moves when the side to move is in check', () => {
    const f = features('4k3/8/8/8/8/8/4q3/4K3 w - - 0 1');
    expect([f.w.activity.mobility, f.b.activity.mobility]).toEqual([null, null]);
  });

  it('counts the squares his pawns attack in the opponent half', () => {
    const f = features('4k3/8/8/2pP4/8/8/8/4K3 w - - 0 1');
    expect(f.w.space.squares.sort()).toEqual(['c6', 'e6']);
    expect(f.b.space.squares.sort()).toEqual(['b4', 'd4']);
  });
});

describe('reasons', () => {
  it('finds none in a symmetric position', () => {
    expect(reasons({ fen: START, pv: ['e2e4', 'e7e5'] })).toEqual([]);
  });

  it('describes the position after the plan when the plan gains: 2. e4 takes the centre', () => {
    const [r, ...rest] = reasons({ fen: A40, pv: ['e2e4', 'c8b7'] });
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ id: 'centre', step: 2 });
    expect(r.text).toMatch(/^Centre: after 2\. e4 Bb7, you have 2 pawns in the centre \(d4 and e4\), Black none/);
    expect(r.shapes).toEqual([{ orig: 'd4', brush: 'green' }, { orig: 'e4', brush: 'green' }]);
  });

  it('names a threat of the engine move, shown after that move', () => {
    const [r] = reasons({ fen: FORK, pv: ['d2d4', 'e8d8'] });
    expect(r).toMatchObject({ id: 'threat', step: 1 });
    expect(r.text).toBe('Threat: 1. d4 threatens dxc5, which wins material worth 3 pawns if Black does nothing about it'
      + ' (the knight on c5).');
    expect(r.shapes).toEqual([{ orig: 'd4', dest: 'c5', brush: 'green' }, { orig: 'c5', brush: 'red' }]);
  });

  it('does not call a capture a threat', () => {
    const trade = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    expect(reasons({ fen: trade, pv: ['b5c6', 'd7c6'] }).map((r) => r.id)).not.toContain('threat');
  });

  it('reports a static advantage of the quiz position, strongest first, at most three', () => {
    const rs = reasons({ fen: KING_IN_CENTRE });
    expect(rs.length).toBeLessThanOrEqual(MAX_REASONS);
    expect(rs[0].id).toBe('king');
    expect(rs[0].text).toBe("King safety: Black's king is still in the centre with the d- and e-files open in front of it and"
      + ' can no longer castle; you attack 2 squares next to it; your king is castled.');
    expect(rs.map((r) => r.strength)).toEqual([...rs.map((r) => r.strength)].sort((a, b) => b - a));
  });

  it('is from the side to move: Black with the better pawns', () => {
    const fen = '4k3/ppp5/8/8/8/2P5/P1P5/4K3 b - - 0 1'; // White: doubled and isolated c-pawns, isolated a-pawn
    const [r] = reasons({ fen });
    expect(r.id).toBe('pawns');
    expect(r.text).toBe('Pawns: White has an isolated pawn on a2 and doubled pawns on c3 and c2; you have none.');
  });
});

describe('helpers', () => {
  it('lists squares in words', () => {
    expect([[], ['d5'], ['d5', 'e5'], ['c6', 'c7', 'd5']].map(listing)).toEqual(['', 'd5', 'd5 and e5', 'c6, c7 and d5']);
  });

  it('bestCapture plays out the replies', () => {
    expect(bestCapture('4k3/8/8/4n3/3P4/8/8/4K3 w - - 0 1')).toEqual({ from: 'd4', to: 'e5', piece: 'p', captured: 'n', gain: 3 });
    expect(bestCapture('4k3/8/5p2/4n3/3P4/8/8/4K3 w - - 0 1')).toMatchObject({ to: 'e5', gain: 2 });
    expect(bestCapture(START)).toBeNull();
  });
});
