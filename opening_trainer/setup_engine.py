"""Download the official Stockfish Windows build into tools/stockfish/."""

from __future__ import annotations

import os
import sys
import zipfile
from pathlib import Path

import requests

from . import TOOLS_DIR, USER_AGENT

RELEASES_URL = "https://api.github.com/repos/official-stockfish/Stockfish/releases/latest"
# Current releases (e.g. sf_19) ship a "universal" build; older ones had avx2.
ASSET_NAMES = (
    "stockfish-windows-x86-64-universal.zip",
    "stockfish-windows-x86-64-avx2.zip",
)
ENGINE_DIR = TOOLS_DIR / "stockfish"
ENGINE_PATH = ENGINE_DIR / "stockfish.exe"
VERSION_FILE = ENGINE_DIR / "VERSION"


class SetupError(RuntimeError):
    pass


def _pick_asset(release: dict) -> dict:
    assets = {a["name"]: a for a in release.get("assets", [])}
    for name in ASSET_NAMES:
        if name in assets:
            return assets[name]
    raise SetupError(f"Release {release.get('tag_name')} has none of the expected assets: {', '.join(ASSET_NAMES)}")


def _extract_exe(archive: Path, target: Path) -> str:
    """Atomically write the engine executable from the zip to `target`; return its member name."""
    tmp = target.with_suffix(".exe.tmp")
    try:
        with zipfile.ZipFile(archive) as zf:
            exes = [n for n in zf.namelist() if n.lower().endswith(".exe") and "stockfish" in n.lower()]
            if not exes:
                raise SetupError("No stockfish .exe found in the downloaded archive")
            member = min(exes, key=len)  # the engine binary sits at the top of the archive folder
            tmp.write_bytes(zf.read(member))
        os.replace(tmp, target)
        return member
    except (zipfile.BadZipFile, KeyError) as exc:
        raise SetupError(f"The downloaded archive is not usable: {exc}") from exc
    finally:
        tmp.unlink(missing_ok=True)


def _download(url: str, target: Path) -> None:
    with requests.get(url, headers={"User-Agent": USER_AGENT}, stream=True, timeout=(15, 300)) as resp:
        resp.raise_for_status()
        with target.open("wb") as out:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                out.write(chunk)


def install(force: bool = False) -> Path:
    """Install Stockfish to ENGINE_PATH unless it is already there."""
    if sys.platform != "win32":
        raise SetupError("`trainer setup` installs the Windows build only. Put a Stockfish binary at "
                         f"{ENGINE_PATH} yourself on other platforms.")
    if ENGINE_PATH.exists() and not force:
        version = VERSION_FILE.read_text().strip() if VERSION_FILE.exists() else "unknown version"
        print(f"Stockfish already installed ({version}) at {ENGINE_PATH}. Use --force to reinstall.")
        return ENGINE_PATH

    ENGINE_DIR.mkdir(parents=True, exist_ok=True)
    archive = ENGINE_DIR / "download.zip.tmp"
    try:
        resp = requests.get(
            RELEASES_URL, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}, timeout=30
        )
        resp.raise_for_status()
        release = resp.json()
        asset = _pick_asset(release)
        print(f"Downloading {asset['name']} ({release['tag_name']}) ...")
        _download(asset["browser_download_url"], archive)
        member = _extract_exe(archive, ENGINE_PATH)
    except requests.RequestException as exc:
        raise SetupError(f"Could not download Stockfish: {exc}") from exc
    finally:
        archive.unlink(missing_ok=True)

    VERSION_FILE.write_text(f"{release['tag_name']} {asset['name']} {member}\n")
    print(f"Installed {member} -> {ENGINE_PATH}")
    return ENGINE_PATH
