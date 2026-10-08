"""Per-game detection of the player's first opening inaccuracy.

Pure logic: the engine is injected and only needs `evaluate(fen) -> (best_uci, cp)`,
with cp from the side to move's point of view.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import chess

from .engine import fen_key

DECIDED_CP = 300


class Evaluator(Protocol):
    def evaluate(self, fen: str) -> tuple[str | None, int]: ...


@dataclass
class Mistake:
    fen: str
    key: str
    ply: int  # half-moves played before the mistake
    played: str  # UCI
    played_san: str
    best: str
    best_san: str
    loss: int
    eval_best: int


@dataclass
class GameResult:
    color: chess.Color
    reached: list[str] = field(default_factory=list)  # FEN keys where it was his move
    mistake: Mistake | None = None


def analyse_moves(
    sans: list[str],
    color: chess.Color,
    engine: Evaluator,
    max_moves: int = 15,
    threshold: int = 20,
) -> GameResult:
    """Scan the player's first `max_moves` moves for the first loss >= threshold."""
    board = chess.Board()
    result = GameResult(color=color)

    for ply, san in enumerate(sans):
        try:
            move = board.parse_san(san)
        except ValueError:
            break  # corrupt move list: keep what was scanned
        if board.turn != color:
            board.push(move)
            continue
        if board.fullmove_number > max_moves:
            break

        fen = board.fen()
        key = fen_key(fen)
        result.reached.append(key)
        best, eval_best = engine.evaluate(fen)

        if best is not None and abs(eval_best) <= DECIDED_CP and move.uci() != best:
            board.push(move)
            _, eval_after = engine.evaluate(board.fen())
            loss = max(0, eval_best - (-eval_after))
            if loss >= threshold:
                before = chess.Board(fen)
                result.mistake = Mistake(
                    fen=fen,
                    key=key,
                    ply=ply,
                    played=move.uci(),
                    played_san=san,
                    best=best,
                    best_san=before.san(chess.Move.from_uci(best)),
                    loss=loss,
                    eval_best=eval_best,
                )
                break
            continue
        board.push(move)

    return result


def player_color(game: dict, user: str) -> chess.Color | None:
    """The user's colour in a Lichess game JSON, or None if he did not play it."""
    user = user.lower()
    for name, color in (("white", chess.WHITE), ("black", chess.BLACK)):
        player = game.get("players", {}).get(name, {}).get("user", {})
        if player.get("id", "").lower() == user or player.get("name", "").lower() == user:
            return color
    return None


def game_url(game: dict, color: chess.Color, ply: int | None = None) -> str:
    url = f"https://lichess.org/{game['id']}"
    if color == chess.BLACK:
        url += "/black"
    if ply is not None:
        url += f"#{ply}"
    return url


def analyse_game(game: dict, user: str, engine: Evaluator, max_moves: int, threshold: int) -> GameResult | None:
    color = player_color(game, user)
    if color is None or not game.get("moves"):
        return None
    return analyse_moves(game["moves"].split(), color, engine, max_moves, threshold)
