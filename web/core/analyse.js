// Per-game detection of the player's first opening inaccuracy (port of opening_trainer/analyse.py).
// Pure logic: the evaluator is injected and only needs `evaluate(fen) -> Promise<[bestUci|null, cp]>`,
// with cp from the side to move's point of view.
import { Chess } from '../vendor/chess.js@1.4.0/dist/esm/chess.js';
import { fenKey } from './fen.js';

export const DECIDED_CP = 300;

/** @typedef {'white'|'black'} Color */

/**
 * @typedef {object} Evaluator
 * @property {(fen: string) => Promise<[string|null, number]>} evaluate
 */

/**
 * @typedef {object} Mistake
 * @property {string} fen
 * @property {string} key
 * @property {number} ply  half-moves played before the mistake
 * @property {string} played  UCI
 * @property {string} playedSan
 * @property {string} best
 * @property {string} bestSan
 * @property {number} loss
 * @property {number} evalBest
 */

/**
 * @typedef {object} GameResult
 * @property {Color} color
 * @property {string[]} reached  FEN keys where it was the player's move
 * @property {Mistake|null} mistake
 */

/** @param {{from: string, to: string, promotion?: string}} move */
const uciOf = (move) => move.from + move.to + (move.promotion ?? '');

/**
 * SAN of a UCI move in `fen` (python-chess `board.san(Move.from_uci(uci))`).
 * @param {string} fen
 * @param {string} uci
 * @returns {string}
 */
export function sanOf(fen, uci) {
  const move = new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
  return move.san;
}

/**
 * Scan the player's first `maxMoves` moves for the first loss >= threshold.
 * @param {string[]} sans
 * @param {Color} color
 * @param {Evaluator} engine
 * @param {number} [maxMoves]
 * @param {number} [threshold]
 * @returns {Promise<GameResult>}
 */
export async function analyseMoves(sans, color, engine, maxMoves = 15, threshold = 20) {
  const board = new Chess();
  const turn = color === 'white' ? 'w' : 'b';
  /** @type {GameResult} */
  const result = { color, reached: [], mistake: null };

  for (const [ply, san] of sans.entries()) {
    // State before the move; chess.js has no parse-without-push, so read it first.
    const fen = board.fen();
    const mover = board.turn();
    const fullmove = board.moveNumber();
    let move;
    try {
      move = board.move(san); // chess.js 1.x throws on an illegal or unparsable SAN
    } catch {
      break; // corrupt move list: keep what was scanned
    }
    if (mover !== turn) continue;
    if (fullmove > maxMoves) break;

    const key = fenKey(fen);
    result.reached.push(key);
    const [best, evalBest] = await engine.evaluate(fen);
    const played = uciOf(move);

    if (best !== null && Math.abs(evalBest) <= DECIDED_CP && played !== best) {
      const [, evalAfter] = await engine.evaluate(board.fen()); // the move is already on the board
      const loss = Math.max(0, evalBest - -evalAfter);
      if (loss >= threshold) {
        result.mistake = {
          fen, key, ply, played, playedSan: san, best, bestSan: sanOf(fen, best), loss, evalBest,
        };
        break;
      }
    }
  }
  return result;
}

/**
 * The user's colour in a Lichess game JSON, or null if he did not play it.
 * @param {any} game
 * @param {string} user
 * @returns {Color|null}
 */
export function playerColor(game, user) {
  user = user.toLowerCase();
  for (const name of /** @type {Color[]} */ (['white', 'black'])) {
    const player = game.players?.[name]?.user ?? {};
    if ((player.id ?? '').toLowerCase() === user || (player.name ?? '').toLowerCase() === user) return name;
  }
  return null;
}

/**
 * Lichess link to the game from the player's side, optionally at a ply.
 * @param {{id: string}} game
 * @param {Color} color
 * @param {number|null} [ply]
 * @returns {string}
 */
export function gameUrl(game, color, ply = null) {
  let url = `https://lichess.org/${game.id}`;
  if (color === 'black') url += '/black';
  if (ply !== null && ply !== undefined) url += `#${ply}`;
  return url;
}

/**
 * Analyse one Lichess game for `user`; null if he did not play it or it has no moves.
 * @param {any} game  a Lichess export object (`moves` is a space-separated SAN string)
 * @param {string} user
 * @param {Evaluator} engine
 * @param {number} maxMoves
 * @param {number} threshold
 * @returns {Promise<GameResult|null>}
 */
export async function analyseGame(game, user, engine, maxMoves, threshold) {
  const color = playerColor(game, user);
  if (color === null || !game.moves) return null;
  return analyseMoves(game.moves.split(/\s+/).filter(Boolean), color, engine, maxMoves, threshold);
}
