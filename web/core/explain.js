// "Why am I better?" (design-position-explanation.md, slice 1): the engine line under a solved or revealed
// position and the verdict on what kind of advantage the player has. Pure: the engine results come in.
//
// - Eval line: "Engine: +1.0 for you · material equal", from one search of the quiz position.
// - Verdict, for positions at WHY_THRESHOLD or more without extra material: the pass test. The engine also
//   searches the position with the opponent to move (the player passes). If the player keeps at least
//   STATIC_SHARE of his advantage, the position itself is better; otherwise the advantage is in his next move.
//   If best play wins material within the engine's line, the verdict says when.
import { Chess } from '../vendor/chess.js@1.4.0/dist/esm/chess.js';
import { MATE_CP } from './fen.js';
import { settledMaterial } from './material.js';

/** "Why am I better?" is offered from this eval on (cp for the player). */
export const WHY_THRESHOLD = 80;
/** Share of the advantage kept after passing above which the advantage counts as static. */
export const STATIC_SHARE = 0.6;
/** Plies of the engine's line that are searched for a material gain. */
export const PLAN_PLIES = 12;
/** Evals at least this far from 0 are forced mates (MATE_CP, as engine.py maps them). */
const MATE_LIMIT = MATE_CP - 1000;

const sideName = (color) => (color === 'w' ? 'White' : 'Black');

/** "+1.0", "-0.3", "0.0" (cp to pawns, one decimal). @param {number} cp */
export function formatEval(cp) {
  const pawns = (Math.round(Math.abs(cp) / 10) / 10).toFixed(1);
  if (pawns === '0.0') return '0.0';
  return `${cp < 0 ? '−' : '+'}${pawns}`;
}

const isMate = (cp) => Math.abs(cp) >= MATE_LIMIT;

/** "a pawn", "2 pawns", ... @param {number} n */
function pawns(n) {
  return n === 1 ? 'a pawn' : `${n} pawns`;
}

/** "a pawn", "material worth 3 pawns" @param {number} n */
function gained(n) {
  return n === 1 ? 'a pawn' : `material worth ${n} pawns`;
}

/**
 * Settled material for the side to move in `fen` (positive: he is up).
 * @param {string} fen @returns {number}
 */
export function playerMaterial(fen) {
  const m = settledMaterial(fen);
  return new Chess(fen).turn() === 'w' ? m : -m;
}

/**
 * The line under the answer: "Engine: +1.0 for you · material equal".
 * @param {{evalCp: number, material: number}} p  both for the player (the side to move)
 * @returns {string}
 */
export function engineLine({ evalCp, material }) {
  const value = isMate(evalCp) ? (evalCp > 0 ? 'a forced mate for you' : 'a forced mate against you') : `${formatEval(evalCp)} for you`;
  const mat = material === 0 ? 'material equal' : material > 0 ? `you are ${pawns(material)} up` : `you are ${pawns(-material)} down`;
  return `Engine: ${value} · ${mat}`;
}

/**
 * Whether to offer "Why am I better?": clearly better, no mate, and not simply material up.
 * @param {{evalCp: number, material: number}} p
 */
export function offersWhy({ evalCp, material }) {
  return evalCp >= WHY_THRESHOLD && !isMate(evalCp) && material <= 0;
}

/**
 * The FEN with the other side to move (the player passes): en passant cleared, the move counters kept
 * sensible. Null when the side to move is in check (passing would be illegal).
 * @param {string} fen @returns {string|null}
 */
export function passFen(fen) {
  if (new Chess(fen).inCheck()) return null;
  const [placement, turn, castling, , half = '0', full = '1'] = fen.trim().split(/\s+/);
  const next = turn === 'w' ? 'b' : 'w';
  const fullmove = turn === 'b' ? Number(full) + 1 : Number(full);
  return `${placement} ${next} ${castling} - ${Number(half) + 1} ${fullmove}`;
}

/**
 * Where the engine's line wins material for the player and keeps it to the end of the line (at most
 * PLAN_PLIES plies): the gain in pawns, the number of his moves until he takes it and that move's number.
 * Settled material already counts a capture the side to move can make, so a gain that shows after the
 * opponent's reply is taken with the player's next move.
 * @param {string} fen @param {string[]} pv  UCI, the player's move first
 * @returns {{gain: number, moves: number, moveNumber: number}|null}
 */
export function planGain(fen, pv) {
  const board = new Chess(fen);
  const me = board.turn();
  const mine = (f) => (me === 'w' ? settledMaterial(f) : -settledMaterial(f));
  const start = mine(fen);
  const startMove = board.moveNumber();
  const steps = [];
  for (const uci of pv.slice(0, PLAN_PLIES)) {
    try {
      board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      break; // an illegal PV move: use the line up to here
    }
    steps.push(mine(board.fen()) - start);
  }
  if (!steps.length) return null;
  const end = steps[steps.length - 1];
  if (end < 1) return null;
  // The earliest ply from which he stays at least a pawn up; his plies are the even ones.
  let first = steps.length - 1;
  while (first > 0 && steps[first - 1] >= 1) first -= 1;
  const moves = Math.ceil(first / 2) + 1;
  return { gain: end, moves, moveNumber: startMove + moves - 1 };
}

/**
 * @typedef {object} Verdict
 * @property {'material'|'mate'|'static'|'dynamic'|'check'} kind
 * @property {string} text
 * @property {{gain: number, moves: number, moveNumber: number}|null} plan
 */

/**
 * The verdict sentence(s) for a position the player is to move in.
 * @param {object} p
 * @param {string} p.fen
 * @param {number} p.evalCp  engine eval for the player
 * @param {number|null} p.passCp  engine eval for the player if he passes (opponent to move); null in check
 * @param {number} p.material  settled material for the player
 * @param {string[]} [p.pv]  the engine's line, the player's move first
 * @returns {Verdict}
 */
export function verdict({ fen, evalCp, passCp, material, pv = [] }) {
  const board = new Chess(fen);
  const them = sideName(board.turn() === 'w' ? 'b' : 'w');
  const plan = pv.length ? planGain(fen, pv) : null;
  const best = pv.length ? sanOrUci(fen, pv[0]) : null;
  const tail = [];
  if (plan) {
    tail.push(`With best play you win ${gained(plan.gain)} within ${plan.moves === 1 ? 'this move' : `${plan.moves} moves`}`
      + ` (by move ${plan.moveNumber}).`);
  }
  const done = (kind, text) => ({ kind, text: [text, ...tail].join(' '), plan });

  if (isMate(evalCp)) return { kind: 'mate', text: evalCp > 0 ? 'You have a forced mate.' : 'You are getting mated.', plan: null };
  if (material >= 1) return done('material', `You are ${pawns(material)} up (once the captures on the board are played out).`);
  const now = formatEval(evalCp);
  if (passCp === null) {
    return done('check', `You are in check, so there is nothing to compare: your advantage (${now}) is in how you answer it`
      + `${best ? `, with ${best}` : ''}.`);
  }
  if (passCp >= STATIC_SHARE * evalCp) {
    return done('static', `Your position itself is better (${now}): even if it were ${them}'s move, you would keep`
      + ` ${formatEval(passCp)}.`);
  }
  const ifPass = isMate(passCp) ? (passCp > 0 ? 'still a forced mate' : `a forced mate for ${them}`) : `about ${formatEval(passCp)}`;
  return done('dynamic', `Your advantage is in your next move${best ? `, ${best}` : ''} (${now} now, ${ifPass} if you did nothing).`);
}

function sanOrUci(fen, uci) {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return uci;
  }
}
