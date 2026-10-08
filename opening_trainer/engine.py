"""Stockfish wrapper with an on-disk SQLite cache keyed by engine, position and depth."""

from __future__ import annotations

import json
import os
import sqlite3
from collections.abc import Callable
from pathlib import Path

import chess
import chess.engine

from . import DATA_DIR
from .setup_engine import ENGINE_PATH

CACHE_PATH = DATA_DIR / "evals.sqlite"
SCHEMA_VERSION = 2
MATE_CP = 10_000
HASH_MB = 256
MULTIPV = 5


class EngineMissingError(RuntimeError):
    pass


class EngineAnalysisError(RuntimeError):
    pass


def fen_key(fen: str) -> str:
    """First four FEN fields: placement, side to move, castling, en passant."""
    return " ".join(fen.split()[:4])


def score_to_cp(score: chess.engine.PovScore) -> int:
    """Centipawns for the side to move; mates map to +/-10000."""
    rel = score.relative
    if rel.is_mate():
        return MATE_CP if rel.mate() > 0 else -MATE_CP
    return rel.score()


class EvalCache:
    def __init__(self, path: Path = CACHE_PATH):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path)
        self._db.execute("PRAGMA journal_mode=WAL")
        if self._db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
            # Older layout without the engine column: start over rather than mix evals.
            with self._db:
                self._db.execute("DROP TABLE IF EXISTS evals")
                self._db.execute("DROP TABLE IF EXISTS engines")
                self._db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        with self._db:
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS evals ("
                " engine TEXT NOT NULL, fen TEXT NOT NULL, depth INTEGER NOT NULL, multipv INTEGER NOT NULL,"
                " result TEXT NOT NULL, PRIMARY KEY (engine, fen, depth, multipv))"
            )
            # Engine binary fingerprint -> UCI id name, so a cached run never has to start the engine.
            self._db.execute("CREATE TABLE IF NOT EXISTS engines (binary TEXT PRIMARY KEY, name TEXT NOT NULL)")

    def get(self, engine: str, key: str, depth: int, multipv: int) -> list | None:
        row = self._db.execute(
            "SELECT result FROM evals WHERE engine=? AND fen=? AND depth=? AND multipv=?",
            (engine, key, depth, multipv),
        ).fetchone()
        return json.loads(row[0]) if row else None

    def put(self, engine: str, key: str, depth: int, multipv: int, result: list) -> None:
        # Commit per entry so an interrupted run keeps everything analysed so far.
        with self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO evals VALUES (?, ?, ?, ?, ?)",
                (engine, key, depth, multipv, json.dumps(result)),
            )

    def engine_name(self, binary: str) -> str | None:
        row = self._db.execute("SELECT name FROM engines WHERE binary=?", (binary,)).fetchone()
        return row[0] if row else None

    def set_engine_name(self, binary: str, name: str) -> None:
        with self._db:
            self._db.execute("INSERT OR REPLACE INTO engines VALUES (?, ?)", (binary, name))

    def close(self) -> None:
        self._db.close()


def _popen(path: Path) -> chess.engine.SimpleEngine:
    return chess.engine.SimpleEngine.popen_uci(str(path))


class Engine:
    """Cached Stockfish analysis. The process is only started when the cache cannot answer."""

    def __init__(
        self,
        depth: int,
        engine_path: Path = ENGINE_PATH,
        cache: EvalCache | None = None,
        launcher: Callable[[Path], chess.engine.SimpleEngine] = _popen,
    ):
        if not engine_path.exists():
            raise EngineMissingError(f"Stockfish not found at {engine_path}. Run `uv run trainer setup` first.")
        self.depth = depth
        self._path = engine_path
        self._launcher = launcher
        self._cache = cache or EvalCache()
        self._engine: chess.engine.SimpleEngine | None = None
        stat = engine_path.stat()
        self._binary = f"{engine_path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}"
        self._name: str | None = self._cache.engine_name(self._binary)
        self.cache_hits = 0
        self.engine_calls = 0

    def _uci(self) -> chess.engine.SimpleEngine:
        if self._engine is None:
            self._engine = self._launcher(self._path)
            threads = max(1, (os.cpu_count() or 2) - 1)
            self._engine.configure({"Threads": threads, "Hash": HASH_MB})
        return self._engine

    @property
    def name(self) -> str:
        """UCI id name, e.g. "Stockfish 19"; part of every cache key."""
        if self._name is None:
            self._name = self._uci().id.get("name", "unknown engine")
            self._cache.set_engine_name(self._binary, self._name)
        return self._name

    def _analyse(self, fen: str, multipv: int) -> list[tuple[str | None, int]]:
        key = fen_key(fen)
        cached = self._cache.get(self.name, key, self.depth, multipv)
        if cached is not None:
            self.cache_hits += 1
            return [tuple(x) for x in cached]

        board = chess.Board(fen)
        if board.is_checkmate():
            result = [(None, -MATE_CP)]
        elif board.is_stalemate() or board.is_insufficient_material():
            result = [(None, 0)]
        else:
            self.engine_calls += 1
            infos = self._uci().analyse(board, chess.engine.Limit(depth=self.depth), multipv=multipv)
            result = [(info["pv"][0].uci(), score_to_cp(info["score"])) for info in infos if info.get("pv")]
            if not result:
                raise EngineAnalysisError(f"{self.name} returned no move for {fen}")
        self._cache.put(self.name, key, self.depth, multipv, result)
        return result

    def evaluate(self, fen: str) -> tuple[str | None, int]:
        """(best move in UCI, eval in cp for the side to move)."""
        return self._analyse(fen, 1)[0]

    def top_moves(self, fen: str, n: int = MULTIPV) -> list[tuple[str, int]]:
        """Up to n best moves with their evals, best first (MultiPV)."""
        return [m for m in self._analyse(fen, n) if m[0] is not None]

    def close(self) -> None:
        if self._engine is not None:
            try:
                self._engine.quit()
            except (chess.engine.EngineError, chess.engine.EngineTerminatedError, TimeoutError, OSError):
                pass  # the process is gone or hung; nothing left to save
            self._engine = None
        self._cache.close()

    def __enter__(self) -> "Engine":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
