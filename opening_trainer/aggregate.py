"""Group first mistakes by position, rank them and write web/positions.json."""

from __future__ import annotations

import json
import os
import time
from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import chess

from . import DATA_DIR, WEB_DIR
from .analyse import GameResult, game_url

POSITIONS_PATH = WEB_DIR / "positions.json"
MAX_GAME_URLS = 5
# A blunder of several pawns would otherwise drown out a mistake he repeats every week.
LOSS_CAP = 500

TopMoves = Callable[[str], list[tuple[str, int]]]


@dataclass
class _Bucket:
    fen: str
    color: chess.Color
    best: str  # from the single-PV search that detected the first mistake
    losses: list[int] = field(default_factory=list)  # raw, uncapped
    played: Counter = field(default_factory=Counter)  # (uci, san) -> count
    openings: Counter = field(default_factory=Counter)  # (eco, name) -> count
    game_urls: list[str] = field(default_factory=list)


def acceptable_moves(top: list[tuple[str, int]], wrong: set[str], threshold: int) -> list[str]:
    """Moves within `threshold` cp of the top MultiPV line, minus moves recorded as mistakes.

    The top line is always within the window, so it is included unless it is itself a recorded mistake.
    """
    if not top:
        return []
    best_cp = top[0][1]
    return list(dict.fromkeys(uci for uci, cp in top if best_cp - cp < threshold and uci not in wrong))


def _san(fen: str, uci: str) -> str:
    return chess.Board(fen).san(chess.Move.from_uci(uci))


def aggregate(
    results: Iterable[tuple[dict, GameResult]],
    top_moves: TopMoves,
    threshold: int,
) -> list[dict]:
    reached: Counter[str] = Counter()
    buckets: dict[str, _Bucket] = {}

    for game, res in results:
        reached.update(set(res.reached))
        m = res.mistake
        if m is None:
            continue
        b = buckets.get(m.key)
        if b is None:
            b = buckets[m.key] = _Bucket(fen=m.fen, color=res.color, best=m.best)
        b.losses.append(m.loss)
        b.played[(m.played, m.played_san)] += 1
        opening = game.get("opening") or {}
        b.openings[(opening.get("eco", ""), opening.get("name", "Unknown"))] += 1
        if len(b.game_urls) < MAX_GAME_URLS:
            b.game_urls.append(game_url(game, res.color, m.ply))

    entries = []
    for key, b in buckets.items():
        errors = len(b.losses)
        capped = [min(loss, LOSS_CAP) for loss in b.losses]
        avg_loss = sum(capped) / errors
        wrong = {uci for uci, _ in b.played}

        # Best move and accept window come from the same MultiPV search.
        top = top_moves(b.fen)
        best = top[0][0] if top else b.best
        # Depth noise can make the top line one of his "mistakes"; then fall back so the quiz has an answer.
        acceptable = acceptable_moves(top, wrong, threshold) or [b.best if b.best not in wrong else best]
        if best not in acceptable:
            best = acceptable[0]

        (eco, name), _ = b.openings.most_common(1)[0]
        entries.append(
            {
                "key": key,
                "fen": b.fen,
                "orientation": "white" if b.color == chess.WHITE else "black",
                "errors": errors,
                "reached": max(reached[key], errors),
                "avg_loss": round(avg_loss, 1),
                "raw_avg_loss": round(sum(b.losses) / errors, 1),
                "score": round(errors * avg_loss, 1),
                "best": best,
                "best_san": _san(b.fen, best),
                "acceptable": acceptable,
                "played": [{"uci": uci, "san": san, "count": n} for (uci, san), n in b.played.most_common()],
                "eco": eco,
                "opening": name,
                "games": b.game_urls,
            }
        )
    entries.sort(key=lambda e: (-e["score"], -e["errors"], e["key"]))
    return entries


def write_positions(
    entries: list[dict], meta: dict, path: Path = POSITIONS_PATH, tmp_dir: Path = DATA_DIR
) -> None:
    """Write the JSON to a temp file outside web/ and swap it in, so the server never serves half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    doc = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), **meta, "positions": entries}
    tmp = tmp_dir / (path.name + ".tmp")
    tmp.write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            # Windows refuses while another process (e.g. the server) has the file open.
            if attempt == 4:
                raise
            time.sleep(0.2 * (attempt + 1))
