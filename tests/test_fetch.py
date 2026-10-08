import json

import pytest
import requests

from opening_trainer import fetch as fetch_mod
from opening_trainer.fetch import (
    Cursor,
    StoreState,
    backfill_params,
    games_path,
    is_supported,
    newer_params,
    read_games,
    state_path,
)

PERFS = {"blitz", "rapid", "classical"}
NO_CURSOR = Cursor()


def _state(*timestamps, perf="blitz"):
    games = [{"id": str(i), "perf": perf, "createdAt": ts} for i, ts in enumerate(timestamps)]
    return StoreState.from_games(games, PERFS)


def _game(i, ts, variant="standard"):
    return {"id": f"g{i}", "variant": variant, "perf": "blitz", "createdAt": ts}


class FakeLichess:
    """Serves `games` like the export API: honours since/until/sort, overshoots max a little (as Lichess does)."""

    def __init__(self, games, overshoot=2):
        self.games = games
        self.overshoot = overshoot
        self.calls = []

    def __call__(self, user, params):
        self.calls.append(params)
        games = [g for g in self.games
                 if params.get("since", 0) <= g["createdAt"] <= params.get("until", 10**15)]
        games.sort(key=lambda g: g["createdAt"], reverse=params["sort"] == "dateDesc")
        if "max" in params:
            games = games[: params["max"] + self.overshoot]
        yield from games


def test_empty_store_fetches_most_recent_max_games():
    s = _state()
    assert newer_params(s, NO_CURSOR) is None
    assert backfill_params(s, NO_CURSOR, 2000, None) == {"sort": "dateDesc", "max": 2000}


def test_newer_games_start_after_newest_stored():
    assert newer_params(_state(1000, 3000, 2000), NO_CURSOR) == {"since": 3001, "sort": "dateAsc"}


def test_newer_games_respect_since():
    assert newer_params(_state(1000), NO_CURSOR, since_ms=5000) == {"since": 5000, "sort": "dateAsc"}
    assert newer_params(_state(9000), NO_CURSOR, since_ms=5000) == {"since": 9001, "sort": "dateAsc"}


def test_backfill_older_games_until_oldest_minus_one():
    assert backfill_params(_state(1000, 3000, 2000), NO_CURSOR, 10, None) == {"sort": "dateDesc", "until": 999, "max": 7}


def test_backfill_continues_below_skipped_games():
    cursor = Cursor(oldest_seen=400, newest_seen=1000)
    assert backfill_params(_state(1000), cursor, 10, None) == {"sort": "dateDesc", "until": 399, "max": 9}
    assert newer_params(_state(), cursor) == {"since": 1001, "sort": "dateAsc"}


def test_no_backfill_when_enough_games_stored_or_exhausted():
    assert backfill_params(_state(1, 2, 3), NO_CURSOR, 3, None) is None
    assert backfill_params(_state(1, 2, 3), NO_CURSOR, 2, None) is None
    assert backfill_params(_state(1), Cursor(exhausted=True), 10, None) is None


def test_all_games_has_no_max():
    assert backfill_params(_state(1000), NO_CURSOR, None, None) == {"sort": "dateDesc", "until": 999}


def test_since_bounds_backfill():
    assert backfill_params(_state(5000), NO_CURSOR, None, 4000) == {"sort": "dateDesc", "until": 4999, "since": 4000}
    assert backfill_params(_state(3000, 5000), NO_CURSOR, None, 4000) is None


def test_other_perfs_do_not_count():
    s = StoreState.from_games(
        [{"id": "a", "perf": "bullet", "createdAt": 9}, {"id": "b", "perf": "blitz", "createdAt": 5}], PERFS
    )
    assert (s.count, s.newest, s.oldest, s.ids) == (1, 5, 5, {"a", "b"})


def test_only_standard_games_without_initial_fen():
    assert is_supported({"variant": "standard"})
    assert not is_supported({"variant": "chess960"})
    assert not is_supported({"variant": "fromPosition"})
    assert not is_supported({"variant": "standard", "initialFen": "8/8/8/8/8/8/8/8 w - - 0 1"})


def test_partially_written_last_line_is_ignored(tmp_path):
    path = tmp_path / "games.ndjson"
    path.write_text(json.dumps({"id": "a"}) + "\n" + '{"id": "b", "creat', encoding="utf-8")
    assert [g["id"] for g in read_games(path)] == ["a"]


def test_store_and_state_are_per_user(tmp_path):
    assert games_path("AngelOgro", tmp_path).name == "games-angelogro.ndjson"
    assert state_path("AngelOgro", tmp_path).name == "fetch-state-angelogro.json"


def test_fetch_enforces_max_and_resumes_with_since(tmp_path, monkeypatch):
    api = FakeLichess([_game(i, 1000 - i) for i in range(12)])
    monkeypatch.setattr(fetch_mod, "_stream", api)

    assert fetch_mod.fetch("u", ["blitz"], 10, data_dir=tmp_path) == 10
    assert api.calls[0]["max"] == 10 and "since" not in api.calls[0]
    assert [g["id"] for g in read_games(games_path("u", tmp_path))][-1] == "g9"

    api.calls.clear()
    assert fetch_mod.fetch("u", ["blitz"], 10, data_dir=tmp_path) == 0  # all known, nothing to back-fill
    assert [(c["sort"], c.get("since")) for c in api.calls] == [("dateAsc", 1001)]


def test_backfill_loops_past_a_batch_of_only_skipped_games(tmp_path, monkeypatch):
    # The 5 newest games are fromPosition, then 5 standard games.
    games = [_game(i, 1000 - i, "fromPosition") for i in range(5)] + [_game(i, 1000 - i) for i in range(5, 10)]
    api = FakeLichess(games, overshoot=0)
    monkeypatch.setattr(fetch_mod, "_stream", api)

    assert fetch_mod.fetch("u", ["blitz"], 5, data_dir=tmp_path) == 5
    # First batch: 5 skipped games; the cursor moves below them and a second batch fetches the rest.
    assert [(c.get("until"), c["max"]) for c in api.calls] == [(None, 5), (995, 5)]

    api.calls.clear()
    assert fetch_mod.fetch("u", ["blitz"], 5, data_dir=tmp_path) == 0
    assert [c["sort"] for c in api.calls] == ["dateAsc"]  # no back-fill re-request


def test_all_skipped_history_is_not_requested_again(tmp_path, monkeypatch):
    api = FakeLichess([_game(i, 1000 - i, "fromPosition") for i in range(3)])
    monkeypatch.setattr(fetch_mod, "_stream", api)

    assert fetch_mod.fetch("u", ["blitz"], 10, data_dir=tmp_path) == 0
    cursor = json.loads(state_path("u", tmp_path).read_text())
    assert (cursor["oldest_seen"], cursor["newest_seen"], cursor["exhausted"]) == (998, 1000, True)

    api.calls.clear()
    fetch_mod.fetch("u", ["blitz"], 10, data_dir=tmp_path)
    assert [(c["sort"], c.get("since")) for c in api.calls] == [("dateAsc", 1001)]


def test_changed_perfs_reset_the_cursor(tmp_path, capsys):
    path = state_path("u", tmp_path)
    Cursor(perfs=["blitz"], oldest_seen=5, exhausted=True).save(path)
    assert Cursor.load(path, ["blitz"]).oldest_seen == 5
    reset = Cursor.load(path, ["rapid", "blitz"])
    assert (reset.perfs, reset.oldest_seen, reset.exhausted) == (["blitz", "rapid"], None, False)
    assert "perf types changed" in capsys.readouterr().out


def test_objects_without_id_are_skipped(tmp_path, monkeypatch):
    api = FakeLichess([_game(1, 1000), {"variant": "standard", "perf": "blitz", "createdAt": 999}])
    monkeypatch.setattr(fetch_mod, "_stream", api)
    assert fetch_mod.fetch("u", ["blitz"], 10, data_dir=tmp_path) == 1


def test_aborted_stream_keeps_received_games(tmp_path, monkeypatch):
    def broken_stream(user, params):
        yield _game(1, 2)
        raise requests.ConnectionError("connection reset")

    monkeypatch.setattr(fetch_mod, "_stream", broken_stream)

    with pytest.raises(fetch_mod.FetchError, match="1 new games were kept"):
        fetch_mod.fetch("u", ["blitz"], 10, data_dir=tmp_path)
    assert [g["id"] for g in read_games(games_path("u", tmp_path))] == ["g1"]
    assert json.loads(state_path("u", tmp_path).read_text())["exhausted"] is False
