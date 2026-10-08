import json

import chess

from opening_trainer.aggregate import LOSS_CAP, acceptable_moves, aggregate, write_positions
from opening_trainer.analyse import GameResult, Mistake

FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
KEY = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"
OTHER_KEY = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -"


def _game(i):
    return {"id": f"g{i}", "opening": {"eco": "B00", "name": "King's Pawn Game"}}


def _mistake(played, san, loss, key=KEY, fen=FEN, best="e7e5"):
    return Mistake(fen=fen, key=key, ply=1, played=played, played_san=san,
                   best=best, best_san="?", loss=loss, eval_best=20)


def _result(mistake, color=chess.BLACK):
    return GameResult(color=color, reached=[mistake.key], mistake=mistake)


def test_repeated_position_grouped_with_counts():
    results = []
    for i in range(9):
        res = GameResult(color=chess.BLACK, reached=[KEY])
        if i < 7:
            played = ("a7a6", "a6", 30) if i < 5 else ("h7h6", "h6", 60)
            # Different move counters, same position key.
            res.mistake = _mistake(*played, fen=FEN.replace(" 0 1", f" 0 {i + 1}"))
        results.append((_game(i), res))

    top = [("e7e5", 20), ("c7c5", 10), ("a7a6", 5), ("g8f6", -20)]
    entries = aggregate(results, lambda fen: top, threshold=20)

    assert len(entries) == 1
    e = entries[0]
    assert (e["key"], e["errors"], e["reached"], e["orientation"]) == (KEY, 7, 9, "black")
    assert e["played"] == [{"uci": "a7a6", "san": "a6", "count": 5}, {"uci": "h7h6", "san": "h6", "count": 2}]
    assert e["avg_loss"] == round((5 * 30 + 2 * 60) / 7, 1)
    assert e["score"] == 270.0  # errors x unrounded average loss = total loss
    # a6 is within the threshold in MultiPV, but it is one of his recorded mistakes; Nf6 is 40 cp worse.
    assert e["acceptable"] == ["e7e5", "c7c5"]
    assert (e["best"], e["best_san"]) == ("e7e5", "e5")
    assert len(e["games"]) == 5
    assert e["games"][0] == "https://lichess.org/g0/black#1"
    assert (e["eco"], e["opening"]) == ("B00", "King's Pawn Game")


def test_best_and_window_come_from_the_multipv_top_line():
    # The single-PV search said e5, the MultiPV search prefers c5: both best and window follow MultiPV.
    m = _mistake("a7a6", "a6", 50, best="e7e5")
    top = [("c7c5", 40), ("e7e5", 25), ("d7d5", 15)]
    e = aggregate([(_game(1), _result(m))], lambda fen: top, threshold=20)[0]
    assert (e["best"], e["best_san"]) == ("c7c5", "c5")
    assert e["acceptable"] == ["c7c5", "e7e5"]


def test_top_line_that_is_a_recorded_mistake_is_not_accepted():
    m = _mistake("c7c5", "c5", 50, best="e7e5")
    top = [("c7c5", 40), ("e7e5", 30)]
    e = aggregate([(_game(1), _result(m))], lambda fen: top, threshold=20)[0]
    assert e["acceptable"] == ["e7e5"]
    assert e["best"] == "e7e5"


def test_sorted_by_errors_times_avg_loss():
    single = (_game(1), _result(_mistake("a7a6", "a6", 100)))
    triple = [(_game(10 + i), _result(_mistake("a7a6", "a6", 40, key=OTHER_KEY))) for i in range(3)]
    entries = aggregate([single, *triple], lambda fen: [], threshold=20)
    assert [e["key"] for e in entries] == [OTHER_KEY, KEY]  # 3 * 40 = 120 > 1 * 100


def test_loss_is_capped_for_average_and_ranking():
    blunder = (_game(1), _result(_mistake("a7a6", "a6", 3000)))
    repeated = [(_game(10 + i), _result(_mistake("a7a6", "a6", 200, key=OTHER_KEY))) for i in range(3)]
    entries = aggregate([blunder, *repeated], lambda fen: [], threshold=20)
    by_key = {e["key"]: e for e in entries}
    assert by_key[KEY]["avg_loss"] == LOSS_CAP == by_key[KEY]["score"]
    assert by_key[KEY]["raw_avg_loss"] == 3000
    assert [e["key"] for e in entries] == [OTHER_KEY, KEY]  # 600 > 500, although 3000 > 600 raw


def test_clean_games_produce_no_entries():
    res = GameResult(color=chess.WHITE, reached=[KEY])
    assert aggregate([(_game(1), res)], lambda fen: [], threshold=20) == []


def test_acceptable_moves_window():
    top = [("e2e4", 30), ("d2d4", 15), ("c2c4", 5)]
    assert acceptable_moves(top, set(), 20) == ["e2e4", "d2d4"]
    assert acceptable_moves(top, {"e2e4"}, 20) == ["d2d4"]
    assert acceptable_moves([], set(), 20) == []


def test_write_positions_uses_temp_outside_target_dir(tmp_path):
    web, data = tmp_path / "web", tmp_path / "data"
    path = web / "positions.json"
    write_positions([{"key": KEY}], {"games": 1}, path, tmp_dir=data)
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["games"] == 1 and doc["positions"] == [{"key": KEY}]
    assert sorted(p.name for p in web.iterdir()) == ["positions.json"]
    assert list(data.iterdir()) == []
