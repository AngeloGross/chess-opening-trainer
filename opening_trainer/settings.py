"""Which Lichess user this installation trains: from --user, $LICHESS_USER or the last one used."""

from __future__ import annotations

import json
import os
from pathlib import Path

from . import DATA_DIR

SETTINGS_PATH = DATA_DIR / "settings.json"
ENV_VAR = "LICHESS_USER"


class UserNotSetError(RuntimeError):
    pass


def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def remembered_user(path: Path = SETTINGS_PATH) -> str | None:
    return _load(path).get("user") or None


def remember_user(user: str, path: Path = SETTINGS_PATH) -> None:
    settings = _load(path)
    if settings.get("user") == user:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({**settings, "user": user}, indent=1), encoding="utf-8")


def resolve_user(explicit: str | None, path: Path = SETTINGS_PATH) -> str:
    """--user wins, then $LICHESS_USER, then the user remembered from an earlier run."""
    user = (explicit or os.environ.get(ENV_VAR) or remembered_user(path) or "").strip()
    if not user:
        raise UserNotSetError(
            "No Lichess user given. Run once with your Lichess name, e.g. "
            "`uv run trainer update --user YourName`; it is remembered for later runs."
        )
    return user
