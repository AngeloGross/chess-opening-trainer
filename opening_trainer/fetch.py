"""Incremental download of a user's games into data/games-<user>.ndjson.

A small state file next to it keeps the back-fill cursor: the oldest (and newest) `createdAt`
seen in any downloaded batch, including games that were skipped as unsupported. Without it a
batch of nothing but skipped games would be requested again on every run.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Iterator
from dataclasses import asdict, dataclass, field
from pathlib import Path

import requests

from . import DATA_DIR, USER_AGENT

API_URL = "https://lichess.org/api/games/user/{user}"
USER_URL = "https://lichess.org/api/user/{user}"


class FetchError(RuntimeError):
    pass


def games_path(user: str, data_dir: Path = DATA_DIR) -> Path:
    return data_dir / f"games-{user.lower()}.ndjson"


def state_path(user: str, data_dir: Path = DATA_DIR) -> Path:
    return data_dir / f"fetch-state-{user.lower()}.json"


def is_supported(game: dict) -> bool:
    """Only standard chess from the normal starting position."""
    return game.get("variant") == "standard" and "initialFen" not in game


def read_games(path: Path) -> Iterator[dict]:
    """Yield stored games, skipping a partially written last line."""
    if not path.exists():
        return
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


@dataclass
class StoreState:
    """Summary of the stored games of the selected perf types."""

    ids: set[str]
    count: int = 0
    newest: int | None = None  # createdAt in ms
    oldest: int | None = None

    @classmethod
    def from_games(cls, games: Iterable[dict], perfs: set[str]) -> "StoreState":
        state = cls(ids=set())
        for g in games:
            state.ids.add(g["id"])
            if g.get("perf") not in perfs:
                continue
            ts = g["createdAt"]
            state.count += 1
            state.newest = ts if state.newest is None else max(state.newest, ts)
            state.oldest = ts if state.oldest is None else min(state.oldest, ts)
        return state


@dataclass
class Cursor:
    """Persisted per user: what has been seen for one perf set, stored or not."""

    perfs: list[str] = field(default_factory=list)
    oldest_seen: int | None = None
    newest_seen: int | None = None
    exhausted: bool = False  # the back-fill reached the user's first game

    def see(self, ts: int) -> None:
        self.oldest_seen = ts if self.oldest_seen is None else min(self.oldest_seen, ts)
        self.newest_seen = ts if self.newest_seen is None else max(self.newest_seen, ts)

    @classmethod
    def load(cls, path: Path, perfs: list[str]) -> "Cursor":
        wanted = sorted(perfs)
        try:
            cursor = cls(**json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError, TypeError):
            return cls(perfs=wanted)
        if cursor.perfs != wanted:
            print(f"Note: perf types changed ({','.join(cursor.perfs)} -> {','.join(wanted)}); "
                  "restarting the back-fill for the new set.")
            return cls(perfs=wanted)
        return cursor

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self)), encoding="utf-8")


def _min(*values: int | None) -> int | None:
    present = [v for v in values if v is not None]
    return min(present) if present else None


def _max(*values: int | None) -> int | None:
    present = [v for v in values if v is not None]
    return max(present) if present else None


def newer_params(state: StoreState, cursor: Cursor, since_ms: int | None = None) -> dict | None:
    """Params for games newer than anything seen, oldest first so an abort leaves no gap."""
    newest = _max(state.newest, cursor.newest_seen)
    if newest is None:
        return None
    return {"since": max(newest + 1, since_ms or 0), "sort": "dateAsc"}


def backfill_params(state: StoreState, cursor: Cursor, max_games: int | None, since_ms: int | None) -> dict | None:
    """Params for older games, newest first, until `max_games` are stored or `since_ms` is reached.

    `max_games=None` means no limit (the --all option).
    """
    if max_games is not None and state.count >= max_games:
        return None
    oldest = _min(state.oldest, cursor.oldest_seen)
    if since_ms is not None and oldest is not None and oldest <= since_ms:
        return None
    if since_ms is None and cursor.exhausted:
        return None
    params: dict = {"sort": "dateDesc"}
    if oldest is not None:
        params["until"] = oldest - 1
    if max_games is not None:
        params["max"] = max_games - state.count
    if since_ms is not None:
        params["since"] = since_ms
    return params


def check_user(user: str) -> str:
    """The user's canonical Lichess name; FetchError if the account does not exist or is closed."""
    try:
        resp = requests.get(USER_URL.format(user=user), headers={"User-Agent": USER_AGENT}, timeout=30)
    except requests.RequestException as exc:
        raise FetchError(f"Could not reach Lichess: {exc}") from exc
    if resp.status_code == 404:
        raise FetchError(f"Lichess user {user!r} not found. Check the spelling of --user.")
    if resp.status_code == 429:
        raise FetchError("Lichess rate limit hit (HTTP 429). Wait a minute and re-run.")
    try:
        resp.raise_for_status()
        info = resp.json()
    except (requests.RequestException, ValueError) as exc:
        raise FetchError(f"Unexpected answer from Lichess for user {user!r}: {exc}") from exc
    if info.get("disabled") or info.get("closed"):
        raise FetchError(f"Lichess account {user!r} is closed.")
    return info.get("username") or user


def _stream(user: str, params: dict) -> Iterator[dict]:
    resp = requests.get(
        API_URL.format(user=user),
        params=params,
        headers={"User-Agent": USER_AGENT, "Accept": "application/x-ndjson"},
        stream=True,
        timeout=(15, 120),
    )
    with resp:
        if resp.status_code == 429:
            raise FetchError("Lichess rate limit hit (HTTP 429). Wait a minute and re-run.")
        resp.raise_for_status()
        for line in resp.iter_lines():
            if line:
                yield json.loads(line)


def _terminate_last_line(path: Path) -> None:
    """After a hard abort, start appending on a fresh line so new games are not glued to a fragment."""
    if not path.exists() or path.stat().st_size == 0:
        return
    with path.open("rb+") as fh:
        fh.seek(-1, 2)
        if fh.read(1) != b"\n":
            fh.write(b"\n")


def fetch(
    user: str,
    perfs: list[str],
    max_games: int | None,
    since_ms: int | None = None,
    data_dir: Path = DATA_DIR,
    progress: Callable[[int], None] | None = None,
) -> int:
    """Download new and, if needed, older games. Returns the number of games added.

    Each game is appended and flushed as it arrives, so an aborted run keeps what it got.
    """
    path, cursor_path = games_path(user, data_dir), state_path(user, data_dir)
    cursor = Cursor.load(cursor_path, perfs)
    state = StoreState.from_games(read_games(path), set(perfs))
    common = {"perfType": ",".join(perfs), "opening": "true", "moves": "true", "evals": "false"}
    added = 0
    path.parent.mkdir(parents=True, exist_ok=True)
    _terminate_last_line(path)

    def run(params: dict) -> int:
        """Stream one request; returns how many objects it delivered (stored or skipped)."""
        nonlocal added
        # Lichess may return more than `max` when perfType is set, so enforce it here too.
        limit = params.get("max")
        seen = stored = 0
        with path.open("a", encoding="utf-8") as out:
            for game in _stream(user, {**common, **params}):
                if limit is not None and stored >= limit:
                    break
                seen += 1
                gid, ts = game.get("id"), game.get("createdAt")
                if not gid or not isinstance(ts, int):
                    continue
                cursor.see(ts)
                if gid in state.ids or not is_supported(game):
                    continue
                out.write(json.dumps(game, separators=(",", ":")) + "\n")
                out.flush()
                state.ids.add(gid)
                stored += 1
                added += 1
                if progress:
                    progress(added)
        return seen

    try:
        if (params := newer_params(state, cursor, since_ms)) is not None:
            run(params)
        # Back-fill in batches: skipped games use up a batch, so ask again until enough are stored.
        while True:
            state = StoreState.from_games(read_games(path), set(perfs))
            if (params := backfill_params(state, cursor, max_games, since_ms)) is None:
                break
            seen = run(params)
            if "max" not in params or seen < params["max"]:
                # The stream ran dry: nothing older is left (within `since`, if given).
                if since_ms is None:
                    cursor.exhausted = True
                break
    except (requests.RequestException, json.JSONDecodeError) as exc:
        raise FetchError(f"Download from Lichess failed: {exc}. {added} new games were kept; re-run to resume.") from exc
    finally:
        cursor.save(cursor_path)
    return added
