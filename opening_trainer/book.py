"""Moves that are played on purpose: the gambit book and moves the player marked as intended.

A gambit gives up material or eval deliberately, so the engine calls its key move an inaccuracy. The
book is the final position of every Lichess opening line whose name contains "Gambit" (vendored data in
web/vendor/chess-openings@*/): the position that carries the gambit's name. Only final positions, because
a line's earlier moves belong to other names ("Damiano Defense, Damiano Gambit" passes 2...f6, which is
just the Damiano Defense). A player's move that reaches a book position within his first `book_moves`
moves is not judged; the scan goes on to the next move.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import chess

from . import WEB_DIR
from .engine import fen_key

BOOK_ID = "chess-openings@a6189a3/gambits"
BOOK_DIR = WEB_DIR / "vendor" / "chess-openings@a6189a3"
BOOK_FILES = ("a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv")
DEFAULT_BOOK_MOVES = 5


def is_gambit_line(name: str) -> bool:
    return "gambit" in name.lower()


def line_key(pgn: str) -> str | None:
    """FEN key after the last move of a TSV `pgn` column ("1. e4 e5 2. f4"); None if a move does not parse."""
    board = chess.Board()
    for token in pgn.split():
        if token.rstrip(".").isdigit():
            continue
        try:
            board.push_san(token)
        except ValueError:
            return None
    return fen_key(board.fen()) if board.move_stack else None


def parse_book(texts: list[str]) -> frozenset[str]:
    """The gambit book from the TSV files' contents."""
    keys: set[str] = set()
    for text in texts:
        for line in text.splitlines()[1:]:  # header: eco, name, pgn
            cols = line.split("\t")
            if len(cols) >= 3 and is_gambit_line(cols[1]):
                key = line_key(cols[2])
                if key is not None:
                    keys.add(key)
    return frozenset(keys)


def gambit_book(directory: Path = BOOK_DIR) -> frozenset[str]:
    return parse_book([(directory / name).read_text(encoding="utf-8") for name in BOOK_FILES])


def intended_id(key: str, uci: str) -> str:
    """How a move marked as intended is stored: FEN key of the position before it, then the UCI move."""
    return f"{key}|{uci}"


@dataclass(frozen=True)
class Skip:
    book: frozenset[str] = frozenset()
    book_moves: int = DEFAULT_BOOK_MOVES
    intended: frozenset[str] = field(default_factory=frozenset)

    def skips(self, board: chess.Board, move: chess.Move, key: str) -> bool:
        """Whether the player's `move` in `board` (not yet pushed; `key` is its FEN key) is played on purpose."""
        if intended_id(key, move.uci()) in self.intended:
            return True
        if not self.book or board.fullmove_number > self.book_moves:
            return False
        board.push(move)
        try:
            return fen_key(board.fen()) in self.book
        finally:
            board.pop()


NO_SKIP = Skip()
