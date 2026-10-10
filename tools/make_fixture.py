"""(Re)generate the shared fixtures in spec/fixtures/ from the Python reference implementation.

Every fixture's `expected` block is computed by opening_trainer (analyse_game + aggregate) with the
FixtureEngine from tests/helpers.py; vitest runs the same files through web/core/*.js.

    uv run python tools/make_fixture.py           # write the scripted fixtures, refresh `expected` of any others
    uv run python tools/make_fixture.py --check   # exit 1 if a file on disk is out of date

Scripted scenarios are defined below with SAN move lists, so FEN keys are always computed by
python-chess. A hand-written fixture (any other *.json in spec/fixtures/) keeps its inputs and only
gets its `expected` block recomputed. spec/golden/round1.json holds Python round(x, 1) golden values,
spec/golden/gambit-book.json the size and digest of the gambit book.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "spec" / "fixtures"
GOLDEN = ROOT / "spec" / "golden"
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT))

from helpers import key_after as key, run_fixture  # noqa: E402

from opening_trainer.book import BOOK_ID, gambit_book  # noqa: E402
from opening_trainer.engine import MATE_CP  # noqa: E402

USER = "AngelOgro"
DEFAULT_SETTINGS = {"max_moves": 15, "threshold": 20}
RUY = "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O"
RUY_SANS = RUY.split()
T0 = 1791444724876  # createdAt of the most recent game; older games count down from here


class Games:
    """Builds Lichess-export-shaped games, most recent first, as `/api/games/user` returns them."""

    def __init__(self, prefix: str):
        self.prefix = prefix
        self.items: list[dict] = []

    def add(self, moves: str, *, white=USER, black="opponent", opening=("B00", "King's Pawn Game"),
            perf="blitz", players=None) -> dict:
        n = len(self.items) + 1
        game = {
            "id": f"{self.prefix[:6]:x<6}{n:02d}",  # 8 characters, like Lichess ids
            "rated": True,
            "variant": "standard",
            "speed": perf,
            "perf": perf,
            "createdAt": T0 - n * 600_000,
            "status": "resign",
            "players": players or {
                "white": _player(white),
                "black": _player(black),
            },
            "moves": moves,
        }
        if opening is not None:
            game["opening"] = {"eco": opening[0], "name": opening[1], "ply": 2}
        self.items.append(game)
        return game


def _player(name):
    if name is None:
        return {"aiLevel": 3}
    return {"user": {"name": name, "id": name.lower()}, "rating": 2000}


def fixture(name, scenarios, games, fake_engine, top_moves=None, user=USER, settings=None, skip=None):
    doc = {
        "name": name,
        "scenarios": scenarios,
        "user": user,
        "settings": settings or DEFAULT_SETTINGS,
        "games": games.items,
        "fakeEngine": {k: list(v) for k, v in fake_engine.items()},
        "topMoves": {k: [list(m) for m in v] for k, v in (top_moves or {}).items()},
    }
    if skip is not None:
        doc["skip"] = skip
    return doc


# ---------- scenarios ----------


def mistake_found():
    g = Games("mfound")
    g.add(RUY)
    g.add("e4 e5 Nf3 Nc6 Bc4 Bc5 d3 Nf6")
    g.add("e4 e5 Nf3 Nc6 Bc4 Nd4 Nc3 Nxf3+")
    before_re1 = key(*RUY_SANS[:10])
    engine = {
        key(*RUY_SANS[:8]): ("e1g1", 25),  # 5. O-O is the best move: the position after is not evaluated
        before_re1: ("d2d4", 30),
        key(*RUY_SANS[:11]): ("b7b5", -8),  # loss 30 - 8 = 22
        key("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"): ("e1g1", 30),
        key("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "d3"): ("g8f6", 5),  # loss 35, best_san O-O
        key("e4", "e5", "Nf3", "Nc6", "Bc4", "Nd4"): ("c4f7", 50),
        key("e4", "e5", "Nf3", "Nc6", "Bc4", "Nd4", "Nc3"): ("d4f3", 0),  # loss 50, best_san Bxf7+
    }
    top = {before_re1: [("d2d4", 30), ("c2c3", 15), ("d2d3", 12), ("f1e1", 8)]}
    return fixture("mistake-found", [
        "first inaccuracy found: 6. Re1, loss 22, ply 10, reached = his 6 moves",
        "best move played (5. O-O = e1g1) does not evaluate the position after",
        "best_san of castling (O-O) and of a checking capture (Bxf7+)",
        "accept window from MultiPV: within 20 cp, minus the played mistake",
    ], g, engine, top)


def only_first_mistake():
    g = Games("first")
    g.add(RUY)
    engine = {
        key(*RUY_SANS[:2]): ("d2d4", 50), key(*RUY_SANS[:3]): ("a7a6", 0),
        key(*RUY_SANS[:4]): ("d2d4", 90), key(*RUY_SANS[:5]): ("a7a6", 0),
    }
    return fixture("only-first-mistake", [
        "only the first mistake of a game counts; the second position is never evaluated",
    ], g, engine)


def decided_position():
    g = Games("decided")
    g.add("e4 e5 Nf3")
    engine = {
        key(): ("d2d4", 350),
        key("e4", "e5"): ("d2d4", 40),
        key("e4", "e5", "Nf3"): ("a7a6", 0),
    }
    return fixture("decided-position", [
        "|eval| > 300 cp: move 1 is not judged and the scan continues",
        "the later mistake (loss 40) is found",
    ], g, engine)


def clean_games():
    g = Games("clean")
    g.add(RUY)
    g.add("e4 e5 Qh5", opening=("C20", "King's Pawn Game: Wayward Queen Attack"))
    g.add("e4 e5 Nf3 Nc6", black=USER, white="opponent")
    return fixture("clean-games", [
        "no mistake within max_moves: clean, reached = all 8 own moves",
        "short game: only the available own moves are scanned",
        "clean games produce no positions and no progress calls",
    ], g, {key(): ("e2e4", 0), key("e4"): ("e7e5", 10)})


def max_moves():
    g = Games("maxmv")
    g.add(RUY)
    g.add(RUY, white="opponent", black=USER)
    engine = {
        key(*RUY_SANS[:3]): ("g8f6", 10),  # black move 2: Nc6 loses 10 + 100 = 110
        key(*RUY_SANS[:4]): ("d2d4", 100),  # white move 3: Bb5 would lose 100, but is beyond max_moves
        key(*RUY_SANS[:5]): ("a7a6", 0),
    }
    return fixture("max-moves", [
        "max_moves 2: white's losing move 3 is not scanned",
        "black's move 2 is still scanned (fullmove number before his move) and is a mistake",
    ], g, engine, settings={"max_moves": 2, "threshold": 20})


def black_side():
    g = Games("black")
    g.add("e4 c5 Nf3", white="opponent", black=USER, opening=("B27", "Sicilian Defense"))
    g.add("e4 a5 d4", white="opponent", black=USER, opening=("B00", "Corn Stalk Defense"))
    engine = {
        key("e4"): ("e7e5", 15),
        key("e4", "c5"): ("g1f3", -50),  # a "gain" of 35: clamped to 0, no mistake
        key("e4", "a5"): ("d2d4", 45),  # loss 15 + 45 = 60
    }
    return fixture("black-side", [
        "loss is clamped at zero when the move gains eval",
        "black's mistake measured from his side (loss 60), URL /black#1, orientation black",
    ], g, engine)


def mate_scores():
    g = Games("mate")
    g.add("d4 d5 c4", opening=("D06", "Queen's Gambit"))
    g.add("f3 e5 g4 Qh4#", opening=("A00", "Barnes Opening: Fool's Mate"))
    engine = {
        key(): ("e2e4", MATE_CP),  # mate for him: decided, skipped
        key("d4", "d5"): ("c2c4", -MATE_CP),  # mated: decided, skipped
        key("f3", "e5"): ("b1c3", -40),
        key("f3", "e5", "g4"): ("d8h4", MATE_CP),  # loss -40 + 10000 = 9960
    }
    return fixture("mate-scores", [
        "a mate eval (+/-10000) is beyond 300 cp: decided, skipped",
        "blundering into mate: loss 9960, capped at 500 for avg_loss and score, raw_avg_loss uncapped",
        "empty MultiPV: best and acceptable fall back to the single-PV best (Nc3)",
    ], g, engine)


def repeated_position():
    g = Games("repeat")
    b = {"white": "opponent", "black": USER}
    st_george = ("B00", "St. George Defense")
    # Transposition to 1. e4 with other move counters; first in game order, so its FEN is the bucket's.
    g.add("Nf3 Nf6 Ng1 Ng8 e4 h6 d4", **b, opening=("A04", "Zukertort Opening"))
    g.add("e4 a6 d4", **b, opening=st_george)
    g.add("e4 a6 d4", **b, opening=st_george)
    g.add("e4 h6 d4", **b, opening=("B00", "Carr Defense"))
    g.add("e4 a6 d4", **b, opening=st_george)
    g.add("e4 a6 d4", **b, opening=st_george)
    g.add("e4 a6 d4", **b, opening=st_george)
    g.add("e4 e5 Nf3", **b, opening=("C40", "King's Knight Opening"))  # best move: clean
    g.add("e4 c5 Nf3", **b, opening=("B27", "Sicilian Defense"))  # inside the window: clean
    g.add("e4 e5 Nf3", white=USER, black="opponent")  # same opening as white: never reaches the key as black
    g.add("e4 e5 Nf3", white="someone", black="else")  # not his game
    # Reaches the key twice (1. e4 Nf6 2. Nf3 Ng8 3. Ng1): counts once for reached.
    g.add("e4 Nf6 Nf3 Ng8 Ng1 e5", **b, opening=("B02", "Alekhine Defense"))
    engine = {
        key("e4"): ("e7e5", 20),
        key("e4", "a6"): ("d2d4", 10),  # loss 30
        key("e4", "h6"): ("d2d4", 40),  # loss 60
        key("e4", "c5"): ("g1f3", -5),  # loss 15 < 20
        key("e4", "Nf6"): ("e4e5", -10),  # loss 10 < 20
    }
    top = {key("e4"): [("e7e5", 20), ("c7c5", 10), ("a7a6", 5), ("g8f6", -20)]}
    return fixture("repeated-position", [
        "repeated position across games: errors 7, reached 10 (clean games that reached it count)",
        "transposed game (different move counters) shares the key; its FEN is the bucket's",
        "played ordered by count (a6 x5, h6 x2); opening = most common",
        "at most 5 game URLs, in game order; #ply follows the real ply (5 for the transposition)",
        "a position reached twice in one game counts once for reached",
        "games he did not play give no result",
    ], g, engine, top)


def tie_breaks():
    g = Games("ties")
    b = {"white": "opponent", "black": USER}
    g.add("d4 g5 c4", **b, opening=("A40", "Borg Defense"))  # B: errors 1, score 60
    g.add("e4 h6 d4", **b, opening=("B00", "Carr Defense"))  # A: h6 first ...
    g.add("e4 a6 d4", **b, opening=("B00", "St. George Defense"))  # ... a6 second, equal counts
    g.add("Nf3 g5 d4", **b, opening=None)  # D: no opening field -> ("", "Unknown"), score 50
    g.add("c4 g5 d4", **b, opening=("A10", "English Opening"))  # C: score 50, key sorts before D
    engine = {
        key("e4"): ("e7e5", 20), key("e4", "h6"): ("d2d4", 10), key("e4", "a6"): ("d2d4", 10),
        key("d4"): ("d7d5", 20), key("d4", "g5"): ("c1g5", 40),
        key("c4"): ("e7e5", 20), key("c4", "g5"): ("d2d4", 30),
        key("Nf3"): ("d7d5", 20), key("Nf3", "g5"): ("d2d4", 30),
    }
    return fixture("tie-breaks", [
        "played ties keep first-inserted order (h6 before a6), as Counter.most_common",
        "opening ties pick the first-inserted opening",
        "equal score: more errors first; equal score and errors: key ascending",
        "missing opening -> eco '' and opening 'Unknown'",
    ], g, engine)


def loss_cap_ranking():
    g = Games("losscap")
    b = {"white": "opponent", "black": USER}
    g.add("e4 f6 d4", **b, opening=("B00", "Barnes Defense"))
    for _ in range(3):
        g.add("d4 g5 Bxg5", **b, opening=("A40", "Borg Defense"))
    engine = {
        key("e4"): ("e7e5", 20), key("e4", "f6"): ("d2d4", 2980),  # loss 3000
        key("d4"): ("d7d5", 20), key("d4", "g5"): ("c1g5", 180),  # loss 200, three times
    }
    return fixture("loss-cap-ranking", [
        "a 3000 cp blunder is capped at 500: avg_loss and score 500, raw_avg_loss 3000",
        "3 x 200 = 600 ranks above the single capped blunder",
    ], g, engine)


def accept_window():
    g = Games("accept")
    b = {"white": "opponent", "black": USER}
    g.add("e4 a6 d4", **b)
    g.add("d4 c5 d5", **b, opening=("A43", "Benoni Defense"))
    g.add("c4 a6 d4", **b, opening=("A10", "English Opening"))
    g.add("Nf3 d5 d4", **b, opening=("A06", "Zukertort Opening"))
    g.add("b3 a6 Bb2", **b, opening=("A01", "Nimzo-Larsen Attack"))
    engine = {
        key("e4"): ("e7e5", 20), key("e4", "a6"): ("d2d4", 30),
        key("d4"): ("d7d5", 20), key("d4", "c5"): ("d4d5", 30),
        key("c4"): ("e7e5", 20), key("c4", "a6"): ("d2d4", 30),
        key("Nf3"): ("g8f6", 20), key("Nf3", "d5"): ("d2d4", 30),
        key("b3"): ("e7e5", 20), key("b3", "a6"): ("c1b2", 30),
    }
    top = {
        key("e4"): [("c7c5", 40), ("e7e5", 25), ("d7d5", 20)],  # MultiPV beats single-PV; 20 cp off is outside
        key("d4"): [("c7c5", 40), ("d7d5", 30)],  # top line is his recorded mistake
        key("c4"): [("e7e5", 20), ("e7e5", 20), ("c7c5", 10)],  # duplicate line: deduped, order kept
        key("Nf3"): [("d7d5", 30)],  # every line is a mistake: fall back to the single-PV best
    }
    return fixture("accept-window", [
        "best and window come from the MultiPV top line, not the single-PV best",
        "window is strict: exactly threshold cp worse is excluded",
        "top line that is a recorded mistake is excluded; best moves to the next accepted move",
        "duplicate MultiPV moves are deduped in order (dict.fromkeys)",
        "empty window falls back to the single-PV best; empty MultiPV likewise",
    ], g, engine, top)


def colour_and_urls():
    g = Games("colour")
    g.add("e4 e5 Nf3", white=USER, black="opponent", opening=("C20", "King's Pawn Game"))
    g.add("e4 a6 d4", players={"white": {"aiLevel": 3}, "black": {"user": {"name": "AngelOgro"}}},
          opening=("B00", "St. George Defense"))
    g.add("e4 e5 Nf3", white="someone", black="else")
    g.add("", white=USER, black="opponent")
    engine = {
        key(): ("d2d4", 30), key("e4"): ("e7e5", 20),  # white's first move: loss 30 + 20 at ply 0
        key("e4", "a6"): ("d2d4", 30),
    }
    return fixture("colour-and-urls", [
        "user matched case-insensitively by id or by name only; AI opponent has no user",
        "white URL without suffix and with #0 for a first-move mistake",
        "black URL with /black#1",
        "a game he did not play and a game without moves give no result",
    ], g, engine, user="ANGELOGRO")


def en_passant():
    g = Games("enpass")
    w = {"white": USER, "black": "opponent"}
    legal = "e4 Nf6 e5 d5"
    pinned = "e4 g6 e5 Bg7 Ke2 Nc6 Kd3 Nb8 Kc3 d5"
    g.add(legal + " exd6", **w, opening=("B02", "Alekhine Defense"))
    g.add(pinned + " Kd3", **w, opening=("B06", "Modern Defense"))
    g.add("Nf3 d5 Nc3 d4 e4 dxe3", white="opponent", black=USER, opening=("A06", "Zukertort Opening"))
    g.add("e4 e6 d4", white="opponent", black=USER, opening=("C00", "French Defense"))
    s = str.split
    engine = {
        key(*s(legal)): ("d2d4", 20), key(*s(legal + " exd6")): ("c7d6", 10),  # loss 30 at "... d6"
        key(*s(pinned)): ("c3b3", 0), key(*s(pinned + " Kd3")): ("g8f6", 25),  # loss 25 at "... -"
        key("Nf3", "d5", "Nc3", "d4", "e4"): ("c7c5", 10),
        key("Nf3", "d5", "Nc3", "d4", "e4", "dxe3"): ("d2e3", 30),  # loss 40 at "... e3"
        key("e4"): ("e7e5", 20), key("e4", "e6"): ("d2d4", 30),  # loss 50 at "... -" (no adjacent pawn)
    }
    return fixture("en-passant", [
        "ep capture legal after a double push: FEN key carries the ep square (d6 / e3)",
        "ep capture pseudo-legal but pinned (Kc3, Bg7 on the diagonal): key has '-'",
        "double push without an adjacent enemy pawn: key has '-'",
    ], g, engine)


def corrupt_moves():
    g = Games("corrupt")
    g.add("e4 e5 Nf3 Zz9 Bc4")
    g.add("e4 e5 Ke3 Nc6")
    g.add("d4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O a3 Bxc3+ Qxc3 b6 Bg5 Bb7 f3 h6 Bh4 d5 e3 Nbd7 cxd5 Nxd5",
          opening=("E38", "Nimzo-Indian Defense: Classical Variation"))
    engine = {key("d4", "Nf6", "c4", "e6", "Nc3", "Bb4", "Qc2", "O-O", "a3", "Bxc3+"): ("b2c3", 25),
              key("d4", "Nf6", "c4", "e6", "Nc3", "Bb4", "Qc2", "O-O", "a3", "Bxc3+", "Qxc3"): ("c7c5", 0)}
    return fixture("corrupt-moves", [
        "an unparsable SAN stops the scan, keeping what was scanned",
        "an illegal SAN stops the scan the same way",
        "a real Lichess move string with check suffixes and castling parses fully",
    ], g, engine)


def rounding_ties():
    g = Games("round")
    b = {"white": "opponent", "black": USER}
    # After 1. e4: losses 20, 21, 20, 20 -> avg 20.25 (exact binary tie) -> round half even 20.2
    for m in ("a6", "h6", "a5", "h5"):
        g.add(f"e4 {m} d4", **b)
    # After 1. d4: losses 21, 21, 21, 20 -> avg 20.75 -> 20.8
    for m in ("a6", "h6", "a5", "h5"):
        g.add(f"d4 {m} e4", **b, opening=("A40", "Queen's Pawn Game"))
    # After 1. c4: losses 20, 21, 515 -> capped avg 541/3 -> 180.3, raw 556/3 -> 185.3
    for m in ("a6", "a5"):
        g.add(f"c4 {m} d4", **b, opening=("A10", "English Opening"))
    g.add("c4 g5 d4", **b, opening=("A10", "English Opening"))
    engine = {
        key("e4"): ("e7e5", 20),
        key("e4", "a6"): ("d2d4", 0), key("e4", "h6"): ("d2d4", 1),
        key("e4", "a5"): ("d2d4", 0), key("e4", "h5"): ("d2d4", 0),
        key("d4"): ("d7d5", 20),
        key("d4", "a6"): ("e2e4", 1), key("d4", "h6"): ("e2e4", 1),
        key("d4", "a5"): ("e2e4", 1), key("d4", "h5"): ("e2e4", 0),
        key("c4"): ("e7e5", 20),
        key("c4", "a6"): ("d2d4", 0),
        key("c4", "a5"): ("d2d4", 1), key("c4", "g5"): ("d2d4", 495),
    }
    return fixture("rounding-ties", [
        "avg_loss 20.25 rounds to 20.2 and 20.75 to 20.8 (Python round half even)",
        "non-terminating averages (thirds) round like Python",
        "raw_avg_loss uncapped vs avg_loss capped, both rounded",
    ], g, engine)


def deliberate_moves():
    g = Games("deliber")
    w = {"white": USER, "black": "opponent"}
    b = {"white": "opponent", "black": USER}
    englund = ("A40", "Englund Gambit")
    g.add("d4 e5 dxe5 Nc6 Nf3 Qe7", **b, opening=englund)  # 1...e5 is book: the later 2...Nc6 is the mistake
    g.add("e4 e5 f4 exf4 Nf3 g5", **w, opening=("C33", "King's Gambit Accepted"))  # 2.f4 is book, 3.Nf3 is fine
    g.add("e4 e5 Nf3 Nc6 Bc4 Bc5 b4", **w, opening=("C51", "Italian Game: Evans Gambit"))  # 4.b4 beyond book_moves 3
    g.add("e4 e5 Nf3 f6 Nxe5", white="opponent", black=USER, opening=("C40", "Damiano Defense"))  # not book
    g.add("e4 e5 Qh5 Nc6 Bc4", **w, opening=("C20", "Wayward Queen Attack"))  # marked as intended
    g.add("e4 c5 Qh5", **w, opening=("B20", "Sicilian Defense"))  # intended only after 1...e5: still a mistake
    engine = {
        key("d4"): ("d7d5", 20), key("d4", "e5"): ("d4e5", -150),  # 1...e5 would lose 170: not judged
        key("d4", "e5", "dxe5"): ("d8e7", -120), key("d4", "e5", "dxe5", "Nc6"): ("g1f3", 150),  # 2...Nc6 loses 30
        key("e4", "e5"): ("g1f3", 40), key("e4", "e5", "f4"): ("e5f4", 20),  # 2.f4 would lose 60: not judged
        key("e4", "e5", "f4", "exf4"): ("g1f3", 30),
        key("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"): ("c2c3", 40),
        key("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "b4"): ("c5b4", 0),  # 4.b4 loses 40: judged (move 4 > 3)
        key("e4", "e5", "Nf3"): ("b8c6", -30), key("e4", "e5", "Nf3", "f6"): ("f3e5", 120),  # 2...f6 loses 90
        key("e4", "e5", "Qh5"): ("b8c6", -10),  # 2.Qh5 marked: not judged
        key("e4", "e5", "Qh5", "Nc6"): ("f1c4", 30),
        key("e4", "c5"): ("g1f3", 30), key("e4", "c5", "Qh5"): ("g8f6", 20),  # 2.Qh5 here: loss 50
        key(): ("e2e4", 30), key("e4"): ("e7e5", 25),
    }
    skip = {
        "book": sorted({key("d4", "e5"), key("e4", "e5", "f4"), key("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "b4")}),
        "book_moves": 3,
        "intended": [f"{key('e4', 'e5')}|d1h5"],
    }
    return fixture("deliberate-moves", [
        "a move that reaches a book position within book_moves is not evaluated; the scan goes on",
        "the next real mistake of that game is found (Englund: 2...Nc6? after the book 1...e5)",
        "a book move beyond book_moves is judged like any other (Evans 4.b4 with book_moves 3)",
        "a move not in the book is judged (Damiano 2...f6)",
        "a move marked as intended is not judged at any move number; skipped positions still count as reached",
        "an intended mark is per position: the same move elsewhere is judged",
    ], g, engine, skip=skip)


SCENARIOS = [
    mistake_found, only_first_mistake, decided_position, clean_games, max_moves, black_side,
    mate_scores, repeated_position, tie_breaks, loss_cap_ranking, accept_window, colour_and_urls,
    en_passant, corrupt_moves, rounding_ties, deliberate_moves,
]


def round1_golden() -> dict:
    """Python round(x, 1) for averages that occur (int / int), incl. exact .x5 ties and near-ties."""
    cases = set()
    for den in range(1, 21):
        for num in range(0, 30 * den, 1):
            x = Fraction(num, den)
            if (x * 20).denominator == 1 and (x * 20).numerator % 2 == 1:  # x.x5 in decimal
                cases.add((num, den))
    cases |= {(81, 4), (83, 4), (1, 4), (3, 4), (5, 4), (61, 3), (10015, 1), (2675, 1000), (1005, 100)}
    rows = sorted({(Fraction(n, d).numerator, Fraction(n, d).denominator) for n, d in cases},
                  key=lambda nd: (Fraction(*nd), nd))
    return {
        "about": "Python round(num / den, 1); regenerate with tools/make_fixture.py",
        "cases": [[n, d, round(n / d, 1)] for n, d in rows],
    }


def gambit_book_golden() -> dict:
    """Size and digest of the gambit book as python-chess builds it; core/book.js must build the same set."""
    keys = sorted(gambit_book())
    return {
        "about": "opening_trainer/book.py gambit_book(); regenerate with tools/make_fixture.py",
        "book": BOOK_ID,
        "size": len(keys),
        "sha256": hashlib.sha256("\n".join(keys).encode()).hexdigest(),
    }


def dump(doc) -> str:
    return json.dumps(doc, indent=1, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="only verify that the files are up to date")
    args = parser.parse_args()

    outputs: dict[Path, str] = {}
    scripted = set()
    for make in SCENARIOS:
        fx = make()
        fx["expected"] = run_fixture(fx)
        path = FIXTURES / f"{fx['name']}.json"
        scripted.add(path)
        outputs[path] = dump(fx)
    for path in sorted(FIXTURES.glob("*.json")):
        if path not in scripted:
            fx = json.loads(path.read_text(encoding="utf-8"))
            fx["expected"] = run_fixture(fx)
            outputs[path] = dump(fx)
    outputs[GOLDEN / "round1.json"] = dump(round1_golden())
    outputs[GOLDEN / "gambit-book.json"] = dump(gambit_book_golden())

    stale = [p for p, text in outputs.items() if not p.is_file() or p.read_text(encoding="utf-8") != text]
    if args.check:
        for p in stale:
            print(f"out of date: {p.relative_to(ROOT)}")
        return 1 if stale else 0
    for p in stale:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(outputs[p], encoding="utf-8", newline="\n")
        print(f"wrote {p.relative_to(ROOT)}")
    print(f"{len(outputs) - 2} fixtures, {len(stale)} written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
