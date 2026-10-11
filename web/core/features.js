// "Why am I better?" slice 3 (design-position-explanation.md §4.3): likely reasons in plain words. Pure,
// chess.js only.
//
// `features(fen)` measures a fixed catalogue of chess concepts for both sides: centre, development, king
// safety, pawn weaknesses, piece activity and space. `reasons({fen, pv})` compares the player (the side to
// move) with the opponent in the quiz position and after the engine's move and the opponent's best reply
// (PV ply 2), and adds the threat of the engine's move (what it wins if the opponent ignores it). A concept is
// reported only if the difference favours the player by at least its threshold; at most MAX_REASONS,
// strongest first. The scores are rough centipawns, only for the threshold and the ranking (tuned on the
// positions that offer "Why?", tools/probe_explanations.py).
import { Chess } from '../vendor/chess.js@1.4.0/dist/esm/chess.js';
import { passFen } from './explain.js';
import { bestCapture, settledMaterial } from './material.js';

export const MAX_REASONS = 3;
/** Plies of the engine's line after which the position is compared (his move and the opponent's reply). */
export const AFTER_PLIES = 2;

const FILES = 'abcdefgh';
const CENTRE = ['d4', 'e4', 'd5', 'e5'];
const MINOR_HOMES = { w: ['b1', 'c1', 'f1', 'g1'], b: ['b8', 'c8', 'f8', 'g8'] };
const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

const other = (c) => (c === 'w' ? 'b' : 'w');
const sideName = (c) => (c === 'w' ? 'White' : 'Black');
const sq = (f, r) => FILES[f] + (r + 1);
/** Rank 0..7 seen from `color` (0 = his back rank). */
const rel = (r, color) => (color === 'w' ? r : 7 - r);

/** "d5", "d5 and e5", "c6, c7 and d5" */
export function listing(items) {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
const count = (n, one, many = `${one}s`) => `${n === 0 ? 'no' : n} ${n === 1 ? one : many}`;
/** "the e-file", "the d- and e-files" */
const fileNames = (files) => (files.length === 1 ? `the ${files[0]}-file` : `the ${listing(files.map((f) => `${f}-`)).replace(/-$/, '')}-files`);

/**
 * @typedef {object} SideFeatures
 * @property {{pawns: string[], control: number}} centre  his pawns on d4 e4 d5 e5; attacks on those squares
 * @property {{home: string[], castled: boolean}} development  minor pieces still on their first squares
 * @property {{square: string, centre: boolean, canCastle: boolean, openFiles: string[], shieldMissing: string[],
 *   zone: string[]}} king  zone: squares next to his king the opponent attacks
 * @property {{isolated: string[], doubled: string[], backward: string[], pressured: string[]}} pawns
 * @property {{mobility: number|null, bishopPair: boolean, outposts: string[], openRooks: string[]}} activity
 *   mobility: legal moves of his knights, bishops, rooks and queens (null when it cannot be counted: in check)
 * @property {{squares: string[]}} space  squares in the opponent's half his pawns attack
 */

/**
 * The catalogue for both sides.
 * @param {string} fen
 * @returns {{w: SideFeatures, b: SideFeatures, turn: 'w'|'b'}}
 */
export function features(fen) {
  const board = new Chess(fen);
  const pieces = [];
  for (const row of board.board()) {
    for (const p of row) if (p) pieces.push({ ...p, f: FILES.indexOf(p.square[0]), r: Number(p.square[1]) - 1 });
  }
  const turn = board.turn();
  const passed = passFen(fen);
  const mobility = {
    [turn]: passed ? pieceMoves(board) : null,
    [other(turn)]: passed ? pieceMoves(new Chess(passed)) : null,
  };
  const castling = fen.split(/\s+/)[2] ?? '-';
  const side = (color) => measure(board, pieces, color, mobility[color], castling);
  return { w: side('w'), b: side('b'), turn };
}

function pieceMoves(board) {
  return board.moves({ verbose: true }).filter((m) => 'nbrq'.includes(m.piece)).length;
}

function measure(board, pieces, color, mobility, castling) {
  const them = other(color);
  const mine = pieces.filter((p) => p.color === color);
  const pawns = mine.filter((p) => p.type === 'p');
  const theirPawns = pieces.filter((p) => p.color === them && p.type === 'p');
  const pawnFiles = (list) => list.map((p) => p.f);
  const ownFiles = pawnFiles(pawns);

  // Centre
  const centre = {
    pawns: pawns.filter((p) => CENTRE.includes(p.square)).map((p) => p.square),
    control: CENTRE.reduce((n, s) => n + board.attackers(s, color).length, 0),
  };

  // Development
  const king = mine.find((p) => p.type === 'k');
  const homes = MINOR_HOMES[color];
  const home = mine.filter((p) => 'nb'.includes(p.type) && homes.includes(p.square)
    && (p.type === 'n' ? 'bg' : 'cf').includes(p.square[0])).map((p) => p.square);
  const backRank = color === 'w' ? 0 : 7;
  const castled = !!king && king.r === backRank && (king.f >= 6 || king.f <= 2);

  // King safety
  const canCastle = color === 'w' ? /[KQ]/.test(castling) : /[kq]/.test(castling);
  const kingFiles = king ? [king.f - 1, king.f, king.f + 1].filter((f) => f >= 0 && f < 8) : [];
  const inCentre = !!king && king.f >= 3 && king.f <= 5;
  const openFiles = inCentre ? kingFiles.filter((f) => f >= 3 && f <= 5 && !ownFiles.includes(f)).map((f) => FILES[f]) : [];
  const shieldMissing = castled
    ? kingFiles.filter((f) => !pawns.some((p) => p.f === f && rel(p.r, color) >= 1 && rel(p.r, color) <= 2)).map((f) => FILES[f])
    : [];
  const zone = [];
  if (king) {
    for (let df = -1; df <= 1; df++) {
      for (let dr = -1; dr <= 1; dr++) {
        const f = king.f + df;
        const r = king.r + dr;
        if (f >= 0 && f < 8 && r >= 0 && r < 8 && board.isAttacked(sq(f, r), them)) zone.push(sq(f, r));
      }
    }
  }

  // Pawn weaknesses
  const isolated = pawns.filter((p) => !ownFiles.includes(p.f - 1) && !ownFiles.includes(p.f + 1));
  const doubled = pawns.filter((p) => pawns.some((q) => q !== p && q.f === p.f));
  const ahead = color === 'w' ? 1 : -1;
  const backward = pawns.filter((p) => {
    if (isolated.includes(p)) return false;
    const supported = pawns.some((q) => Math.abs(q.f - p.f) === 1 && rel(q.r, color) <= rel(p.r, color));
    const stop = p.r + ahead;
    if (supported || stop < 0 || stop > 7) return false;
    return theirPawns.some((q) => Math.abs(q.f - p.f) === 1 && q.r === stop + ahead);
  });
  const pressured = pawns.filter((p) => {
    const attackers = board.attackers(p.square, them).length;
    return attackers > 0 && attackers > board.attackers(p.square, color).length;
  });

  // Piece activity
  const bishops = mine.filter((p) => p.type === 'b');
  const theirBishops = pieces.filter((p) => p.color === them && p.type === 'b');
  const outposts = mine.filter((p) => p.type === 'n' && rel(p.r, color) >= 3 && rel(p.r, color) <= 5
    && pawns.some((q) => Math.abs(q.f - p.f) === 1 && q.r === p.r - ahead)
    && !theirPawns.some((q) => Math.abs(q.f - p.f) === 1 && (color === 'w' ? q.r > p.r : q.r < p.r)));
  const openRooks = mine.filter((p) => p.type === 'r' && !ownFiles.includes(p.f));

  // Space
  const squares = new Set();
  for (const p of pawns) {
    for (const df of [-1, 1]) {
      const f = p.f + df;
      const r = p.r + ahead;
      if (f >= 0 && f < 8 && r >= 0 && r < 8 && rel(r, color) >= 4) squares.add(sq(f, r));
    }
  }

  const names = (list) => list.map((p) => p.square);
  return {
    centre,
    development: { home, castled },
    king: { square: king?.square ?? '', centre: inCentre && !castled, canCastle, openFiles, shieldMissing, zone },
    pawns: { isolated: names(isolated), doubled: names(doubled), backward: names(backward), pressured: names(pressured) },
    activity: {
      mobility,
      bishopPair: bishops.length >= 2 && theirBishops.length < 2,
      outposts: names(outposts),
      openRooks: names(openRooks),
    },
    space: { squares: [...squares] },
  };
}

// ---------- the concepts: score (higher = better for that side), threshold, sentence, highlights ----------

const circle = (orig, brush) => ({ orig, brush });

/**
 * @typedef {object} Concept
 * @property {string} id
 * @property {number} min  the difference (cp-like) from which it is reported
 * @property {(s: SideFeatures, o: SideFeatures) => number} score  for side `s` against `o`
 * @property {(me: SideFeatures, them: SideFeatures, names: {them: string}) => {text: string, shapes: object[]}} describe
 */

/** @type {Concept[]} */
export const CONCEPTS = [
  {
    id: 'centre',
    min: 45,
    score: (s) => 35 * s.centre.pawns.length + 6 * s.centre.control,
    describe(me, them, { them: name }) {
      const mp = me.centre.pawns;
      const tp = them.centre.pawns;
      const parts = [];
      if (mp.length > tp.length) parts.push(`you have ${count(mp.length, 'pawn')} in the centre (${listing(mp)}), ${name} ${tp.length || 'none'}`);
      if (me.centre.control > them.centre.control) {
        parts.push(`your pieces and pawns hit the four centre squares ${me.centre.control} times, ${name}'s ${them.centre.control}`);
      }
      const text = `${parts.join('; ')}.`;
      return { text: `Centre: ${text}`, shapes: [...mp.map((s) => circle(s, 'green')), ...tp.map((s) => circle(s, 'red'))] };
    },
  },
  {
    id: 'development',
    min: 45,
    score: (s) => -30 * s.development.home.length + 25 * (s.development.castled ? 1 : 0),
    describe(me, them, { them: name }) {
      const th = them.development.home;
      const mh = me.development.home;
      const parts = [];
      if (th.length !== mh.length) {
        parts.push(`${name} still has ${count(th.length, 'minor piece')} at home${th.length ? ` (${listing(th)})` : ''}, you ${mh.length || 'none'}`);
      }
      if (me.development.castled && !them.development.castled) parts.push(`you have castled, ${name} has not`);
      return { text: `Development: ${parts.join('; ')}.`, shapes: th.map((s) => circle(s, 'red')) };
    },
  },
  {
    id: 'king',
    min: 50,
    score: (s) => -kingDanger(s.king),
    describe(me, them, { them: name }) {
      const k = them.king;
      const parts = [];
      if (k.centre) {
        const files = k.openFiles.length ? ` with ${fileNames(k.openFiles)} open in front of it` : '';
        parts.push(`${name}'s king is still in the centre${files}${k.canCastle ? '' : ' and can no longer castle'}`);
      } else if (k.shieldMissing.length) {
        parts.push(`${name}'s king has no pawn cover on ${fileNames(k.shieldMissing)}`);
      }
      if (k.zone.length >= 2) parts.push(`you attack ${k.zone.length} squares next to it`);
      if (me.king.centre === false && k.centre && me.development.castled) parts.push('your king is castled');
      return { text: `King safety: ${parts.join('; ')}.`, shapes: [circle(k.square, 'red'), ...k.zone.filter((s) => s !== k.square).map((s) => circle(s, 'paleRed'))] };
    },
  },
  {
    id: 'pawns',
    min: 30,
    score: (s) => -pawnWeakness(s.pawns),
    describe(me, them, { them: name }) {
      const t = them.pawns;
      const parts = [];
      const isolated = t.isolated.filter((s) => !t.doubled.includes(s));
      if (isolated.length) parts.push(`${isolated.length > 1 ? 'isolated pawns' : 'an isolated pawn'} on ${listing(isolated)}`);
      if (t.doubled.length) parts.push(`doubled pawns on ${listing(t.doubled)}`);
      if (t.backward.length) parts.push(`${t.backward.length > 1 ? 'backward pawns' : 'a backward pawn'} on ${listing(t.backward)}`);
      const pressured = t.pressured.filter((s) => !t.isolated.includes(s));
      if (pressured.length) parts.push(`${pressured.length > 1 ? 'pawns' : 'a pawn'} on ${listing(pressured)} attacked more often than defended`);
      const weak = [...new Set([...t.isolated, ...t.doubled, ...t.backward, ...t.pressured])];
      const mine = pawnWeakness(me.pawns) === 0 ? '; you have none' : '';
      return { text: `Pawns: ${name} has ${listing(parts)}${mine}.`,
        shapes: weak.map((s) => circle(s, 'red')) };
    },
  },
  {
    id: 'activity',
    min: 50,
    score: (s, o) => activityScore(s.activity, o.activity),
    describe(me, them, { them: name }) {
      const m = me.activity;
      const t = them.activity;
      const parts = [];
      if (m.mobility !== null && t.mobility !== null && m.mobility - t.mobility >= 5) {
        parts.push(`your pieces have ${m.mobility} moves, ${name}'s ${t.mobility}`);
      }
      if (m.bishopPair) parts.push('you have the bishop pair');
      for (const s of m.outposts) parts.push(`your knight on ${s} is on an outpost no pawn can chase it from`);
      const rooks = m.openRooks.filter((s) => !t.openRooks.some((r) => r[0] === s[0]));
      if (rooks.length) parts.push(`your rook${rooks.length > 1 ? 's' : ''} on ${listing(rooks)} use${rooks.length > 1 ? '' : 's'} an open file`);
      return { text: `Activity: ${parts.join('; ')}.`, shapes: [...m.outposts, ...rooks].map((s) => circle(s, 'green')) };
    },
  },
  {
    id: 'space',
    min: 60,
    score: (s) => 10 * s.space.squares.length,
    describe(me, them, { them: name }) {
      return { text: `Space: your pawns control ${count(me.space.squares.length, 'square')} in ${name}'s half, ${name}'s pawns`
        + ` ${them.space.squares.length} in yours.`, shapes: me.space.squares.map((s) => circle(s, 'paleGreen')) };
    },
  },
];

function kingDanger(k) {
  let d = 0;
  if (k.centre) d += 15 + 25 * k.openFiles.length + (k.canCastle ? 0 : 30);
  d += 15 * k.shieldMissing.length;
  d += 8 * k.zone.length;
  return d;
}

function pawnWeakness(p) {
  return 20 * p.isolated.length + 12 * p.doubled.length + 15 * p.backward.length
    + 15 * p.pressured.filter((s) => !p.isolated.includes(s)).length;
}

function activityScore(m, t) {
  const mobility = m.mobility !== null && t.mobility !== null ? 4 * m.mobility : 0;
  return mobility + (m.bishopPair ? 50 : 0) + 25 * m.outposts.length
    + 12 * m.openRooks.filter((s) => !t.openRooks.some((r) => r[0] === s[0])).length;
}

// ---------- reasons ----------

/**
 * @typedef {object} Reason
 * @property {string} id  a concept id or 'threat'
 * @property {string} text
 * @property {object[]} shapes  chessground auto shapes
 * @property {number} step  the plan step the shapes belong to: 0 the quiz position, 1 after his move (a threat),
 *   AFTER_PLIES after the opponent's reply
 * @property {number} strength  for the ranking
 */

/** "2. e4 Bb7" / "11... Nd4 12. Qe2": the first plies of `pv` from `fen` as SAN, with the positions. */
function playLine(fen, pv, plies) {
  const board = new Chess(fen);
  const fens = [];
  const sans = [];
  for (const uci of pv.slice(0, plies)) {
    const number = board.moveNumber();
    const white = board.turn() === 'w';
    try {
      const m = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      sans.push(white ? `${number}. ${m.san}` : sans.length ? m.san : `${number}... ${m.san}`);
    } catch {
      break;
    }
    fens.push(board.fen());
  }
  return { fens, label: sans.join(' ') };
}

/** What the engine's move threatens: the capture it wins if the opponent passes. */
function threatReason(fen, pv, me) {
  const { fens, label } = playLine(fen, pv, 1);
  if (!fens.length || new Chess(fen).get(pv[0].slice(2, 4))) return null; // a capture is a trade, not a threat
  const after = fens[0];
  const passed = passFen(after);
  if (!passed) return null; // a check: the opponent cannot ignore it
  const mine = (f) => (me === 'w' ? settledMaterial(f) : -settledMaterial(f));
  const gain = mine(passed) - mine(after);
  if (gain < 1) return null;
  const capture = bestCapture(passed);
  if (!capture) return null;
  const board = new Chess(passed);
  const san = board.move({ from: capture.from, to: capture.to, promotion: 'q' }).san;
  const wins = gain === 1 ? 'a pawn' : `material worth ${gain} pawns`;
  return {
    id: 'threat',
    text: `Threat: ${label} threatens ${san}, which wins ${wins} if ${sideName(other(me))} does nothing about it`
      + ` (the ${PIECE_NAMES[capture.captured]} on ${capture.to}).`,
    shapes: [{ orig: capture.from, dest: capture.to, brush: 'green' }, circle(capture.to, 'red')],
    step: 1,
    strength: 60 * gain + 40,
  };
}

/**
 * Up to MAX_REASONS likely reasons why the side to move in `fen` is better, strongest first.
 * @param {{fen: string, pv?: string[]}} p  pv: the engine's line in UCI, the player's move first
 * @returns {Reason[]}
 */
export function reasons({ fen, pv = [] }) {
  const me = new Chess(fen).turn();
  const them = other(me);
  const names = { them: sideName(them) };
  const before = features(fen);
  const line = playLine(fen, pv, AFTER_PLIES);
  const after = line.fens.length === AFTER_PLIES ? features(line.fens[AFTER_PLIES - 1]) : null;
  const diff = (c, f) => c.score(f[me], f[them]) - c.score(f[them], f[me]);

  const found = [];
  for (const c of CONCEPTS) {
    const b = diff(c, before);
    const a = after ? diff(c, after) : null;
    // The state after the plan when the plan improves it (most advantages are in the next move, design §2),
    // else the quiz position if the advantage there survives the reply.
    let best = null;
    if (a !== null && a >= c.min && a > b) best = { strength: a, step: AFTER_PLIES, f: after, prefix: `after ${line.label}, ` };
    else if (b >= c.min && (a === null || a >= c.min / 2)) best = { strength: b, step: 0, f: before, prefix: '' };
    if (!best) continue;
    const { text, shapes } = c.describe(best.f[me], best.f[them], names);
    found.push({ id: c.id, text: withPrefix(text, best.prefix), shapes, step: best.step, strength: best.strength });
  }
  const threat = threatReason(fen, pv, me);
  if (threat) found.push(threat);
  return found.sort((x, y) => y.strength - x.strength).slice(0, MAX_REASONS);
}

/** "Centre: after 2. e4 Bb7, you have …" */
function withPrefix(text, prefix) {
  if (!prefix) return text;
  const colon = text.indexOf(': ');
  return `${text.slice(0, colon + 2)}${prefix}${text.slice(colon + 2)}`;
}

/** The sentence when no concept passes its threshold. */
export const NO_REASON = 'No simple reason found: the engine sees it deeper than these checks. Follow its plan.';
