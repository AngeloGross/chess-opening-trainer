import hashlib
import json
from pathlib import Path

import chess
from helpers import key_after

from opening_trainer.book import BOOK_ID, Skip, gambit_book, intended_id, line_key, parse_book

GOLDEN = Path(__file__).resolve().parent.parent / "spec" / "golden" / "gambit-book.json"


def test_gambit_book_matches_golden():
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    keys = sorted(gambit_book())
    assert golden["book"] == BOOK_ID
    assert len(keys) == golden["size"]
    assert hashlib.sha256("\n".join(keys).encode()).hexdigest() == golden["sha256"]


def test_known_gambits_are_in_the_book_and_their_prefixes_are_not():
    book = gambit_book()
    for moves in ("d4 e5", "e4 e5 f4", "e4 e5 Nf3 Nf6 Nxe5 Nc6", "e4 e5 Nf3 Nc6 Bc4 Bc5 b4", "d4 Nf6 c4 e5",
                  "e4 c5 d4 cxd4 c3"):
        assert key_after(*moves.split()) in book, moves
    # Prefixes of gambit lines that carry another name: real mistakes stay visible.
    for moves in ("e4 e5 Nf3 f6", "e4 e5 Qh5", "e4", "e4 e5"):
        assert key_after(*moves.split()) not in book, moves


def test_parse_book_reads_only_gambit_lines():
    tsv = "eco\tname\tpgn\nA40\tEnglund Gambit\t1. d4 e5\nC40\tDamiano Defense\t1. e4 e5 2. Nf3 f6\nX\tbad gambit\t1. e9\n"
    assert parse_book([tsv]) == frozenset({key_after("d4", "e5")})
    assert line_key("1. e4 e5 2. f4") == key_after("e4", "e5", "f4")
    assert line_key("") is None


def test_skip_respects_book_moves_and_intended():
    board = chess.Board()
    board.push_san("d4")
    move = board.parse_san("e5")
    key = key_after("d4")
    book = frozenset({key_after("d4", "e5")})
    assert Skip(book=book, book_moves=1).skips(board, move, key)
    assert not Skip(book=book, book_moves=0).skips(board, move, key)
    assert Skip(intended=frozenset({intended_id(key, "e7e5")})).skips(board, move, key)
    assert len(board.move_stack) == 1  # the board is left as it was
