"""Command line entry point: `trainer setup|fetch|analyse|update|serve`."""

from __future__ import annotations

import argparse
import functools
import http.server
import socket
import sys
import webbrowser
from collections.abc import Iterable
from datetime import datetime, timezone

import chess.engine

from . import WEB_DIR
from .aggregate import POSITIONS_PATH, aggregate, write_positions
from .analyse import analyse_game
from .engine import Engine, EngineAnalysisError, EngineMissingError
from .fetch import FetchError, fetch, games_path, is_supported, read_games
from .setup_engine import SetupError, find_engine, install, missing_engine_message

DEFAULT_USER = "AngelOgro"
DEFAULT_PERFS = "blitz,rapid,classical"


class Progress:
    """Single-line progress on a terminal, periodic lines otherwise."""

    def __init__(self, every: int = 25):
        self._tty = sys.stdout.isatty()
        self._every = every

    def show(self, n: int, text: str) -> None:
        if self._tty:
            print(f"\r{text}", end="", flush=True)
        elif n % self._every == 0:
            print(text, flush=True)

    def done(self, text: str) -> None:
        print(f"\r{text}" if self._tty else text, flush=True)


def _positive_int(value: str) -> int:
    try:
        n = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"expected a whole number, got {value!r}") from exc
    if n < 1:
        raise argparse.ArgumentTypeError(f"must be at least 1, got {n}")
    return n


def _port(value: str) -> int:
    n = _positive_int(value)
    if n > 65535:
        raise argparse.ArgumentTypeError(f"must be 1-65535, got {n}")
    return n


def _date_ms(value: str) -> int:
    try:
        dt = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"expected YYYY-MM-DD, got {value!r}") from exc
    return int(dt.timestamp() * 1000)


def _perfs(args: argparse.Namespace) -> list[str]:
    return [p.strip() for p in args.perf.split(",") if p.strip()]


def _max_games(args: argparse.Namespace) -> int | None:
    return None if args.all else args.max_games


def cmd_setup(args: argparse.Namespace) -> None:
    install(force=args.force)


def cmd_fetch(args: argparse.Namespace) -> None:
    progress = Progress(every=100)
    added = fetch(
        args.user,
        _perfs(args),
        _max_games(args),
        args.since,
        progress=lambda n: progress.show(n, f"Downloaded {n} new games"),
    )
    progress.done(f"Fetch done: {added} new games stored.")


def select_games(games: Iterable[dict], perfs: set[str], since_ms: int | None, limit: int | None) -> list[dict]:
    """The `limit` most recent games matching the perf / since filters (all of them if limit is None)."""
    selected = [
        g
        for g in games
        if g.get("perf") in perfs and is_supported(g) and (since_ms is None or g["createdAt"] >= since_ms)
    ]
    selected.sort(key=lambda g: g["createdAt"], reverse=True)
    return selected if limit is None else selected[:limit]


def cmd_analyse(args: argparse.Namespace) -> None:
    games = select_games(read_games(games_path(args.user)), set(_perfs(args)), args.since, _max_games(args))
    if not games:
        print("No stored games match the filters. Run `uv run trainer fetch` first.")
        return

    progress = Progress()
    results = []
    with Engine(depth=args.depth) as engine:
        for i, game in enumerate(games, 1):
            res = analyse_game(game, args.user, engine, args.max_moves, args.threshold)
            if res is not None:
                results.append((game, res))
            progress.show(
                i,
                f"Games {i}/{len(games)} | positions: {engine.cache_hits + engine.engine_calls}"
                f" (cache hits {engine.cache_hits}, engine {engine.engine_calls})",
            )
        progress.done(
            f"Analysed {len(games)} games | positions: {engine.cache_hits + engine.engine_calls}"
            f" (cache hits {engine.cache_hits}, engine {engine.engine_calls})"
        )

        # The MultiPV pass is slow at full depth, so it gets its own progress line.
        multipv_progress = Progress(every=10)
        entries = aggregate(
            results,
            engine.top_moves,
            args.threshold,
            on_progress=lambda n, total: multipv_progress.show(
                n, f"Alternatives {n}/{total} mistake positions | engine calls {engine.engine_calls}"
            ),
        )
        multipv_progress.done(f"MultiPV on {len(entries)} mistake positions: engine calls now {engine.engine_calls}")

    if not results:
        print(f"None of the selected games were played by {args.user}; {POSITIONS_PATH.name} left unchanged.")
        return

    clean = sum(1 for _, r in results if r.mistake is None)
    meta = {
        "user": args.user,
        "games": len(results),
        "clean_games": clean,
        "settings": {
            "perf": _perfs(args),
            "max_moves": args.max_moves,
            "threshold": args.threshold,
            "depth": args.depth,
        },
    }
    write_positions(entries, meta)
    print(f"Wrote {len(entries)} positions to {POSITIONS_PATH} ({clean} of {len(results)} games clean).")


def cmd_update(args: argparse.Namespace) -> None:
    if find_engine() is None:  # fail before a long download, not after it
        raise EngineMissingError(missing_engine_message())
    cmd_fetch(args)
    cmd_analyse(args)


class _Server(http.server.ThreadingHTTPServer):
    """Fails with OSError when the port is taken (SO_REUSEADDR on Windows would share it silently)."""

    allow_reuse_address = False

    def server_bind(self) -> None:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def cmd_serve(args: argparse.Namespace) -> None:
    if not POSITIONS_PATH.exists():
        print("Note: web/positions.json is missing. Run `uv run trainer update` first.")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(WEB_DIR))
    with _Server(("127.0.0.1", args.port), handler) as server:
        url = f"http://127.0.0.1:{args.port}/"
        print(f"Serving {WEB_DIR} at {url} (Ctrl+C to stop)")
        if not args.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


def _add_game_options(p: argparse.ArgumentParser, analysis: bool) -> None:
    p.add_argument("--user", default=DEFAULT_USER, help="Lichess user name (default: %(default)s)")
    p.add_argument("--perf", default=DEFAULT_PERFS, help="comma-separated perf types (default: %(default)s)")
    p.add_argument("--max-games", type=_positive_int, default=2000, help="most recent N games (default: %(default)s)")
    p.add_argument("--all", action="store_true", help="use all games, ignoring --max-games")
    p.add_argument("--since", type=_date_ms, help="only games on or after YYYY-MM-DD")
    if analysis:
        p.add_argument("--max-moves", type=_positive_int, default=15, help="scan his first N moves (default: %(default)s)")
        p.add_argument("--threshold", type=_positive_int, default=20, help="mistake threshold in cp (default: %(default)s)")
        p.add_argument("--depth", type=_positive_int, default=18, help="Stockfish depth (default: %(default)s)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="trainer", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("setup", help="download Stockfish for this platform into tools/stockfish/")
    p.add_argument("--force", action="store_true", help="reinstall even if present")
    p.set_defaults(func=cmd_setup)

    p = sub.add_parser("fetch", help="download new games from Lichess")
    _add_game_options(p, analysis=False)
    p.set_defaults(func=cmd_fetch)

    p = sub.add_parser("analyse", help="analyse stored games and write web/positions.json")
    _add_game_options(p, analysis=True)
    p.set_defaults(func=cmd_analyse)

    p = sub.add_parser("update", help="fetch + analyse")
    _add_game_options(p, analysis=True)
    p.set_defaults(func=cmd_update)

    p = sub.add_parser("serve", help="serve the trainer page and open the browser")
    p.add_argument("--port", type=_port, default=8000)
    p.add_argument("--no-browser", action="store_true", help="do not open a browser")
    p.set_defaults(func=cmd_serve)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except (EngineMissingError, EngineAnalysisError, FetchError, SetupError) as exc:
        print(f"\nError: {exc}", file=sys.stderr)
        return 1
    except (chess.engine.EngineError, chess.engine.EngineTerminatedError) as exc:
        print(f"\nError: Stockfish failed ({exc}). Re-run to continue; finished positions are cached.", file=sys.stderr)
        return 1
    except OSError as exc:  # e.g. port already in use, file locked by another program
        print(f"\nError: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted. Downloaded games and engine results so far are kept; re-run to resume.")
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
