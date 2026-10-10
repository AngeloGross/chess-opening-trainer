import dataclasses

import chess

from opening_trainer.engine import fen_key


class FakeEngine:
    """Evaluator driven by a {fen_key: (best_uci, cp_for_side_to_move)} table.

    Unknown positions evaluate as (first legal move, 0). Records every evaluated key.
    """

    def __init__(self, table=None):
        self.table = table or {}
        self.calls = []

    def evaluate(self, fen):
        key = fen_key(fen)
        self.calls.append(key)
        if key in self.table:
            return self.table[key]
        return (next(iter(chess.Board(fen).legal_moves)).uci(), 0)


def key_after(*sans):
    board = chess.Board()
    for san in sans:
        board.push_san(san)
    return fen_key(board.fen())


# ---------- shared fixtures (spec/fixtures/*.json), also run by vitest through the JS port ----------


class FixtureEngine:
    """Evaluator driven by a fixture's `fakeEngine` table.

    Unlike FakeEngine, unknown positions evaluate as (None, 0): "no best move" is answered the same
    way by python-chess and chess.js, whereas "first legal move" depends on each library's move order.
    """

    def __init__(self, table):
        self.table = table
        self.calls = []

    def evaluate(self, fen):
        key = fen_key(fen)
        self.calls.append(key)
        best, cp = self.table.get(key, (None, 0))
        return best, cp


def _result_doc(res, calls):
    if res is None:
        return None
    return {
        "color": "white" if res.color == chess.WHITE else "black",
        "reached": res.reached,
        "mistake": dataclasses.asdict(res.mistake) if res.mistake else None,
        "evaluated": calls,
    }


def run_fixture(fixture):
    """The `expected` part of a fixture, computed by the Python reference implementation."""
    from opening_trainer.aggregate import aggregate
    from opening_trainer.analyse import analyse_game
    from opening_trainer.book import NO_SKIP, Skip

    settings = fixture["settings"]
    spec = fixture.get("skip")
    skip = NO_SKIP if spec is None else Skip(book=frozenset(spec["book"]), book_moves=spec["book_moves"])
    docs, analysed = [], []
    for game in fixture["games"]:
        engine = FixtureEngine(fixture.get("fakeEngine", {}))
        res = analyse_game(game, fixture["user"], engine, settings["max_moves"], settings["threshold"], skip)
        docs.append(_result_doc(res, engine.calls))
        if res is not None:
            analysed.append((game, res))

    top = fixture.get("topMoves", {})
    progress = []
    positions = aggregate(
        analysed,
        lambda fen: [tuple(m) for m in top.get(fen_key(fen), [])],
        settings["threshold"],
        on_progress=lambda done, total: progress.append([done, total]),
    )
    return {"results": docs, "positions": positions, "progress": progress}
