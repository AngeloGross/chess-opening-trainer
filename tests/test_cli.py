import pytest

from opening_trainer.cli import build_parser, select_games

PERFS = {"blitz", "rapid", "classical"}


def _g(i, ts, perf="blitz", variant="standard"):
    return {"id": str(i), "createdAt": ts, "perf": perf, "variant": variant}


GAMES = [_g(1, 100), _g(2, 300), _g(3, 200), _g(4, 400, perf="bullet"), _g(5, 500, variant="chess960"), _g(6, 50)]


def test_select_most_recent_matching_games():
    assert [g["id"] for g in select_games(GAMES, PERFS, None, 2)] == ["2", "3"]


def test_select_all():
    assert [g["id"] for g in select_games(GAMES, PERFS, None, None)] == ["2", "3", "1", "6"]


def test_select_since():
    assert [g["id"] for g in select_games(GAMES, PERFS, 150, None)] == ["2", "3"]
    assert [g["id"] for g in select_games(GAMES, PERFS, 150, 1)] == ["2"]


@pytest.mark.parametrize(
    "argv",
    [
        ["analyse", "--depth", "0"],
        ["analyse", "--max-moves", "0"],
        ["analyse", "--threshold", "-5"],
        ["fetch", "--max-games", "0"],
        ["fetch", "--since", "2024-13-01"],
        ["serve", "--port", "70000"],
        ["serve", "--port", "0"],
    ],
)
def test_invalid_options_are_rejected(argv):
    with pytest.raises(SystemExit):
        build_parser().parse_args(argv)


def test_valid_options_parse():
    args = build_parser().parse_args(["update", "--depth", "12", "--max-games", "50", "--since", "2024-01-01"])
    assert (args.depth, args.max_games, args.since) == (12, 50, 1704067200000)
