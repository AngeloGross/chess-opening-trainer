import chess
import chess.engine
from helpers import FakeEngine, key_after

from opening_trainer.analyse import analyse_moves, game_url, player_color
from opening_trainer.engine import MATE_CP, fen_key, score_to_cp

OPENING = "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O".split()


def test_mistake_found_records_first_inaccuracy():
    # White, move 6: +30 before, +8 after his move -> loss 22.
    before = key_after(*OPENING[:10])  # before 6. Re1
    after = key_after(*OPENING[:11])
    engine = FakeEngine({before: ("d2d4", 30), after: ("b7b5", -8)})

    res = analyse_moves(OPENING, chess.WHITE, engine)

    m = res.mistake
    assert m is not None
    assert (m.played, m.played_san, m.best, m.best_san, m.loss) == ("f1e1", "Re1", "d2d4", "d4", 22)
    assert m.key == before and m.ply == 10
    assert len(res.reached) == 6  # moves 1..6 were his to play


def test_only_first_mistake_counts():
    first = key_after(*OPENING[:2])
    second = key_after(*OPENING[:4])
    engine = FakeEngine({
        first: ("d2d4", 50), key_after(*OPENING[:3]): ("a7a6", 0),
        second: ("d2d4", 90), key_after(*OPENING[:5]): ("a7a6", 0),
    })
    res = analyse_moves(OPENING, chess.WHITE, engine)
    assert res.mistake.key == first and res.mistake.loss == 50
    assert second not in engine.calls


def test_best_move_played_does_not_analyse_position_after():
    engine = FakeEngine({key_after(): ("e2e4", 30)})

    res = analyse_moves(["e4", "e5"], chess.WHITE, engine)

    assert res.mistake is None
    assert key_after("e4") not in engine.calls


def test_decided_position_is_skipped_and_scan_continues():
    later_before = key_after("e4", "e5")
    engine = FakeEngine({
        key_after(): ("d2d4", 350),
        later_before: ("d2d4", 40),
        key_after("e4", "e5", "Nf3"): ("a7a6", 0),
    })

    res = analyse_moves(["e4", "e5", "Nf3"], chess.WHITE, engine)

    assert key_after("e4") not in engine.calls  # move 1 not judged
    assert res.mistake.key == later_before and res.mistake.loss == 40


def test_no_mistake_within_max_moves_is_clean():
    res = analyse_moves(OPENING, chess.WHITE, FakeEngine())  # everything 0 cp
    assert res.mistake is None
    assert len(res.reached) == 8


def test_moves_beyond_max_moves_are_not_scanned():
    engine = FakeEngine({key_after(*OPENING[:4]): ("d2d4", 100), key_after(*OPENING[:5]): ("a7a6", 0)})
    res = analyse_moves(OPENING, chess.WHITE, engine, max_moves=2)
    assert res.mistake is None
    assert len(res.reached) == 2


def test_short_game_scans_available_moves_only():
    res = analyse_moves(["e4", "e5", "Qh5"], chess.WHITE, FakeEngine())
    assert res.mistake is None
    assert len(res.reached) == 2


def test_loss_is_clamped_at_zero():
    # Black: best is +10 for black, but after c5 white stands at -50 -> "gain" of 40, clamped to 0.
    engine = FakeEngine({key_after("e4"): ("e7e5", 10), key_after("e4", "c5"): ("g1f3", -50)})
    assert analyse_moves(["e4", "c5"], chess.BLACK, engine).mistake is None


def test_black_mistake_from_his_side():
    engine = FakeEngine({key_after("e4"): ("e7e5", 15), key_after("e4", "a5"): ("d2d4", 45)})
    m = analyse_moves(["e4", "a5"], chess.BLACK, engine).mistake
    assert (m.played, m.best_san, m.loss) == ("a7a5", "e5", 60)


def test_mate_score_mapping_then_rules_apply():
    assert score_to_cp(chess.engine.PovScore(chess.engine.Mate(3), chess.WHITE)) == MATE_CP
    assert score_to_cp(chess.engine.PovScore(chess.engine.Mate(-2), chess.WHITE)) == -MATE_CP
    assert score_to_cp(chess.engine.PovScore(chess.engine.Cp(37), chess.BLACK)) == 37
    # A mate eval is beyond 300 cp, so the position counts as decided and is skipped.
    engine = FakeEngine({key_after(): ("e2e4", MATE_CP), key_after("d4"): ("e7e5", 0)})
    assert analyse_moves(["d4"], chess.WHITE, engine).mistake is None


def test_fen_key_ignores_move_counters():
    a = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    b = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 4 9"
    assert fen_key(a) == fen_key(b) == "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"


def test_player_color_and_game_url():
    game = {
        "id": "abc",
        "players": {"white": {"user": {"id": "x"}}, "black": {"user": {"name": "AngelOgro", "id": "angelogro"}}},
    }
    assert player_color(game, "AngelOgro") == chess.BLACK
    assert player_color(game, "someone") is None
    assert game_url(game, chess.BLACK, 7) == "https://lichess.org/abc/black#7"
    assert game_url(game, chess.WHITE) == "https://lichess.org/abc"
