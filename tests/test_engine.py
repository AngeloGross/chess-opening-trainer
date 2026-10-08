import chess
import chess.engine
import pytest

from opening_trainer.engine import Engine, EngineAnalysisError, EngineMissingError, EvalCache, MATE_CP


class FakeUci:
    """Stands in for a running Stockfish process."""

    def __init__(self, name="FakeFish 1", empty=False):
        self.id = {"name": name}
        self.empty = empty
        self.analyse_calls = 0
        self.quit_called = False

    def configure(self, options):
        self.options = options

    def analyse(self, board, limit, multipv):
        self.analyse_calls += 1
        if self.empty:
            return [{}]
        moves = list(board.legal_moves)[:multipv]
        return [
            {"pv": [m], "score": chess.engine.PovScore(chess.engine.Cp(50 - 10 * i), board.turn)}
            for i, m in enumerate(moves)
        ]

    def quit(self):
        self.quit_called = True


@pytest.fixture
def engine_file(tmp_path):
    path = tmp_path / "stockfish.exe"
    path.write_bytes(b"fake")
    return path


def _engine(engine_file, tmp_path, uci, depth=10):
    return Engine(depth, engine_file, EvalCache(tmp_path / "evals.sqlite"), launcher=lambda path: uci)


def test_missing_engine_says_to_run_setup(tmp_path):
    with pytest.raises(EngineMissingError, match="uv run trainer setup"):
        Engine(10, tmp_path / "nope.exe", EvalCache(tmp_path / "evals.sqlite"))


def test_results_are_cached_across_runs_and_engine_not_started(engine_file, tmp_path):
    uci = FakeUci()
    with _engine(engine_file, tmp_path, uci) as e:
        best, cp = e.evaluate(chess.STARTING_FEN)
        assert cp == 50 and best is not None
        assert len(e.top_moves(chess.STARTING_FEN, 5)) == 5
        assert (e.engine_calls, e.cache_hits) == (2, 0)

    started = []
    second = FakeUci()

    def launcher(path):
        started.append(path)
        return second

    # Same position with different move counters is a cache hit; the engine never starts.
    fen = chess.STARTING_FEN.replace(" 0 1", " 3 7")
    with Engine(10, engine_file, EvalCache(tmp_path / "evals.sqlite"), launcher=launcher) as e:
        assert e.evaluate(fen) == (best, 50)
        assert (e.engine_calls, e.cache_hits) == (0, 1)
    assert started == [] and second.analyse_calls == 0


def test_cache_is_keyed_by_depth_and_engine_name(engine_file, tmp_path):
    with _engine(engine_file, tmp_path, FakeUci(), depth=10) as e:
        e.evaluate(chess.STARTING_FEN)
    with _engine(engine_file, tmp_path, FakeUci(), depth=12) as e:
        e.evaluate(chess.STARTING_FEN)
        assert e.engine_calls == 1

    # A replaced binary (new size/mtime) reports another engine name and gets its own entries.
    engine_file.write_bytes(b"upgraded engine")
    upgraded = FakeUci(name="FakeFish 2")
    with _engine(engine_file, tmp_path, upgraded, depth=10) as e:
        e.evaluate(chess.STARTING_FEN)
        assert e.engine_calls == 1 and e.name == "FakeFish 2"


def test_empty_engine_result_raises_and_is_not_cached(engine_file, tmp_path):
    with _engine(engine_file, tmp_path, FakeUci(empty=True)) as e:
        with pytest.raises(EngineAnalysisError, match="returned no move"):
            e.evaluate(chess.STARTING_FEN)
    with _engine(engine_file, tmp_path, FakeUci()) as e:
        assert e.evaluate(chess.STARTING_FEN)[1] == 50
        assert e.engine_calls == 1


def test_finished_positions_need_no_engine(engine_file, tmp_path):
    uci = FakeUci()
    mated = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"
    with _engine(engine_file, tmp_path, uci) as e:
        assert e.evaluate(mated) == (None, -MATE_CP)
        assert e.top_moves(mated) == []
    assert uci.analyse_calls == 0


def test_quit_errors_are_swallowed(engine_file, tmp_path):
    class Crashing(FakeUci):
        def quit(self):
            raise chess.engine.EngineTerminatedError("gone")

    e = _engine(engine_file, tmp_path, Crashing())
    e.evaluate(chess.STARTING_FEN)
    e.close()  # must not raise
