"""Engine data for tuning and reviewing "Why am I better?" (design-position-explanation.md §2, slices 3-4).

For every position of a positions.json, one search of the quiz position (eval + PV) and one of the position
with the opponent to move (the pass test), like web/analysis/explainer.js does in the browser. Writes the
positions the trainer offers "Why?" for (>= +0.8 for the player, no mate, settled material <= 0) as JSON;
tools/explain_report.mjs turns them into explanations.

    uv run python tools/probe_explanations.py [web/positions.json] [data/why-positions.json] [--depth 14]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import chess
import chess.engine

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from opening_trainer.book import settled_material  # noqa: E402
from opening_trainer.engine import score_to_cp  # noqa: E402
from opening_trainer.setup_engine import find_engine  # noqa: E402

WHY_THRESHOLD = 80
MATE_LIMIT = 9000


def search(engine: chess.engine.SimpleEngine, board: chess.Board, depth: int) -> tuple[int, list[str]]:
    info = engine.analyse(board, chess.engine.Limit(depth=depth))
    return score_to_cp(info["score"]), [m.uci() for m in info.get("pv", [])]


def pass_board(board: chess.Board) -> chess.Board | None:
    if board.is_check():
        return None
    passed = chess.Board(board.fen())
    passed.turn = not passed.turn
    passed.ep_square = None
    return passed


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("positions", nargs="?", default=str(ROOT / "web" / "positions.json"))
    ap.add_argument("out", nargs="?", default=str(ROOT / "data" / "why-positions.json"))
    ap.add_argument("--depth", type=int, default=14)
    args = ap.parse_args()

    positions = json.loads(Path(args.positions).read_text(encoding="utf-8"))["positions"]
    path = find_engine()
    if path is None:
        sys.exit("Stockfish not found: run `uv run trainer setup`.")
    out = []
    with chess.engine.SimpleEngine.popen_uci(str(path)) as engine:
        engine.configure({"Hash": 128})
        for i, pos in enumerate(positions, 1):
            board = chess.Board(pos["fen"])
            material = settled_material(board) * (1 if board.turn == chess.WHITE else -1)
            if material > 0:
                continue
            cp, pv = search(engine, board, args.depth)
            if cp < WHY_THRESHOLD or cp >= MATE_LIMIT:
                continue
            passed = pass_board(board)
            pass_cp = None if passed is None else -search(engine, passed, args.depth)[0]
            out.append({"key": pos["key"], "fen": pos["fen"], "eco": pos.get("eco"), "opening": pos.get("opening"),
                        "best_san": pos.get("best_san"), "evalCp": cp, "passCp": pass_cp, "material": material, "pv": pv})
            print(f"{i}/{len(positions)}  {len(out)} qualify", end="\r", file=sys.stderr)
    print(file=sys.stderr)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps({"depth": args.depth, "positions": out}, indent=1), encoding="utf-8")
    print(f"{len(out)} of {len(positions)} positions offer \"Why?\" -> {args.out}")


if __name__ == "__main__":
    main()
