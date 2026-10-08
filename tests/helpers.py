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
