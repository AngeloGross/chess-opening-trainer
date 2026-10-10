import chess
import pytest
from helpers import key_after

from opening_trainer.book import BOOK_ID, BOOK_PATH, Skip, book_document, line_book_keys, load_book, settled_material


@pytest.fixture(scope="module")
def book():
    return load_book()


def test_book_file_is_current():
    import json

    assert json.loads(BOOK_PATH.read_text(encoding="utf-8")) == book_document(), "run tools/make_fixture.py"


@pytest.mark.parametrize("moves", [
    "d4 e5",  # Englund Gambit
    "e4 e5 f4",  # King's Gambit
    "e4 e5 Nf3 Nf6 Nxe5 Nc6",  # Stafford Gambit
    "e4 e5 Nf3 Nc6 Bc4 Bc5 b4",  # Evans Gambit
    "e4 c5 d4 cxd4 c3",  # Smith-Morra Gambit
    "d4 Nf6 c4 e5",  # Budapest Gambit
    "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Nxd5 Nxf7",  # Fried Liver Attack: no "Gambit" in the name
    "e4 e5 Nf3 Nc6 Nc3 Nf6 Nxe5",  # Halloween
    "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 Bc5",  # Traxler Counterattack
    "e4 e5 Nf3 Nc6 Bc4 Bc5 Bxf7+",  # Jerome Gambit
    "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 O-O c3 d5",  # Marshall Attack
])
def test_gambits_are_in_the_book(book, moves):
    assert key_after(*moves.split()) in book


@pytest.mark.parametrize("moves", [
    "e4 e5 Nf3 f6",  # Damiano Defense: a mistake, not a gambit
    "e4 e5 Qh5",  # Wayward Queen Attack
    "e4", "e4 e5", "d4 d5", "e4 c5 Nf3 d6",
])
def test_ordinary_and_bad_moves_are_not(book, moves):
    assert key_after(*moves.split()) not in book


def test_settled_material_plays_out_hanging_captures():
    board = chess.Board()
    for san in "e4 e5 f4".split():
        board.push_san(san)
    assert settled_material(board) == -1  # ...exf4 wins the pawn
    for san in "Nf6 fxe5".split():
        board.push_san(san)
    assert settled_material(board) == 0  # ...Nxe4 takes the pawn back


def test_line_book_keys():
    assert line_book_keys("Englund Gambit", "1. d4 e5") == [key_after("d4", "e5")]
    assert line_book_keys("Damiano Defense", "1. e4 e5 2. Nf3 f6") == []
    assert line_book_keys("Fried Liver", "1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Nxd5 6. Nxf7") == [
        key_after(*"e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Nxd5 Nxf7".split())
    ]
    assert line_book_keys("Fool's Mate", "1. f3 e5 2. g4 Qh4#") == []  # a trap ends in mate
    assert line_book_keys("Bad Gambit", "1. e9") == []


def test_skip_respects_book_moves():
    board = chess.Board()
    board.push_san("d4")
    move = board.parse_san("e5")
    book = frozenset({key_after("d4", "e5")})
    assert Skip(book=book, book_moves=1).skips(board, move)
    assert not Skip(book=book, book_moves=0).skips(board, move)
    assert not Skip().skips(board, move)
    assert len(board.move_stack) == 1  # the board is left as it was


def test_book_id_is_checked(tmp_path):
    path = tmp_path / "gambits.json"
    path.write_text('{"book": "old", "keys": []}', encoding="utf-8")
    with pytest.raises(ValueError, match="make_fixture"):
        load_book(path)
    assert BOOK_ID in BOOK_PATH.read_text(encoding="utf-8")


def test_opening_choice_floor_per_colour():
    skip = Skip(opening_moves=3, opening_floor=20)
    assert skip.opening_choice(2, chess.WHITE, -20)
    assert not skip.opening_choice(2, chess.WHITE, -21)
    assert skip.opening_choice(3, chess.BLACK, -50)  # Black starts about 30 cp behind
    assert not skip.opening_choice(3, chess.BLACK, -51)
    assert not skip.opening_choice(4, chess.WHITE, 100)  # beyond opening_moves
    assert not Skip().opening_choice(1, chess.WHITE, 100)  # off by default
