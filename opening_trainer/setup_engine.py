"""Locate Stockfish, or download the official build for this platform into tools/stockfish/."""

from __future__ import annotations

import os
import platform
import shutil
import stat
import sys
import tarfile
import zipfile
from pathlib import Path

import requests

from . import TOOLS_DIR, USER_AGENT

RELEASES_URL = "https://api.github.com/repos/official-stockfish/Stockfish/releases/latest"
ENGINE_DIR = TOOLS_DIR / "stockfish"
VERSION_FILE = ENGINE_DIR / "VERSION"
ENV_VAR = "STOCKFISH_PATH"

# Release asset names per (OS, CPU), preferred first. Current releases (sf_19) ship "universal"
# builds; the older names keep setup working against earlier releases.
ASSETS = {
    ("windows", "x86-64"): ("stockfish-windows-x86-64-universal.zip", "stockfish-windows-x86-64-avx2.zip"),
    ("windows", "arm64"): ("stockfish-windows-arm64-universal.zip",),
    ("linux", "x86-64"): ("stockfish-linux-x86-64-universal.tar.gz", "stockfish-ubuntu-x86-64-avx2.tar"),
    ("linux", "arm64"): ("stockfish-linux-arm64-universal.tar.gz",),
    ("macos", "x86-64"): ("stockfish-macos-universal.tar.gz", "stockfish-macos-x86-64-avx2.tar"),
    ("macos", "arm64"): ("stockfish-macos-universal.tar.gz", "stockfish-macos-m1-apple-silicon.tar"),
}
_OS = {"win32": "windows", "linux": "linux", "darwin": "macos"}
_CPU = {"amd64": "x86-64", "x86_64": "x86-64", "arm64": "arm64", "aarch64": "arm64"}


class SetupError(RuntimeError):
    pass


def current_platform() -> tuple[str, str]:
    os_name = next((v for k, v in _OS.items() if sys.platform.startswith(k)), sys.platform)
    cpu = _CPU.get(platform.machine().lower(), platform.machine().lower())
    return os_name, cpu


def installed_path(os_name: str | None = None) -> Path:
    """Where `trainer setup` puts the engine on this platform."""
    os_name = os_name or current_platform()[0]
    return ENGINE_DIR / ("stockfish.exe" if os_name == "windows" else "stockfish")


def find_engine() -> Path | None:
    """$STOCKFISH_PATH, then the engine installed by `trainer setup`, then `stockfish` on PATH."""
    if env := os.environ.get(ENV_VAR):
        path = Path(env).expanduser()
        if not path.is_file():
            raise SetupError(f"{ENV_VAR} points to {path}, which is not a file")
        return path
    if (path := installed_path()).is_file():
        return path
    found = shutil.which("stockfish")
    return Path(found) if found else None


def missing_engine_message() -> str:
    return (
        "Stockfish not found. Run `uv run trainer setup`, install it with your package manager "
        f"(e.g. `sudo apt install stockfish`), or set {ENV_VAR} to the binary. See README, 'Stockfish'."
    )


def _pick_asset(release: dict, plat: tuple[str, str]) -> dict:
    names = ASSETS.get(plat)
    if not names:
        raise SetupError(f"No official Stockfish build known for {plat[0]}/{plat[1]}. " + missing_engine_message())
    assets = {a.get("name"): a for a in release.get("assets", [])}
    for name in names:
        if name in assets and assets[name].get("browser_download_url"):
            return assets[name]
    raise SetupError(f"Release {release.get('tag_name', '?')} has none of: {', '.join(names)}")


def _is_engine_member(name: str) -> bool:
    base = name.rsplit("/", 1)[-1].lower()
    return base.startswith("stockfish") and (base.endswith(".exe") or "." not in base)


def _read_engine(archive: Path) -> tuple[str, bytes]:
    """(member name, bytes) of the engine binary; it sits at the top of the archive folder."""
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as zf:
            names = [n for n in zf.namelist() if not n.endswith("/") and _is_engine_member(n)]
            if not names:
                raise SetupError("No Stockfish binary found in the downloaded archive")
            member = min(names, key=len)
            return member, zf.read(member)
    with tarfile.open(archive) as tf:  # handles .tar and .tar.gz
        members = [m for m in tf.getmembers() if m.isfile() and _is_engine_member(m.name)]
        if not members:
            raise SetupError("No Stockfish binary found in the downloaded archive")
        member = min(members, key=lambda m: len(m.name))
        return member.name, tf.extractfile(member).read()


def _extract_engine(archive: Path, target: Path) -> str:
    """Atomically write the engine binary from the archive to `target`; return its member name."""
    tmp = target.with_name(target.name + ".tmp")
    try:
        member, data = _read_engine(archive)
        tmp.write_bytes(data)
        tmp.chmod(tmp.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        os.replace(tmp, target)
        return member
    except (zipfile.BadZipFile, tarfile.TarError, KeyError) as exc:
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
    """Install the official build for this platform unless it is already there."""
    plat = current_platform()
    target = installed_path(plat[0])
    if target.exists() and not force:
        version = VERSION_FILE.read_text().strip() if VERSION_FILE.exists() else "unknown version"
        print(f"Stockfish already installed ({version}) at {target}. Use --force to reinstall.")
        return target

    ENGINE_DIR.mkdir(parents=True, exist_ok=True)
    archive = ENGINE_DIR / "download.tmp"
    try:
        resp = requests.get(
            RELEASES_URL, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}, timeout=30
        )
        resp.raise_for_status()
        release = resp.json()
        asset = _pick_asset(release, plat)
        tag = release.get("tag_name", "?")
        print(f"Downloading {asset['name']} ({tag}) for {plat[0]}/{plat[1]} ...")
        _download(asset["browser_download_url"], archive)
        member = _extract_engine(archive, target)
    except requests.RequestException as exc:
        raise SetupError(f"Could not download Stockfish: {exc}") from exc
    finally:
        archive.unlink(missing_ok=True)

    VERSION_FILE.write_text(f"{tag} {asset['name']} {member}\n")
    print(f"Installed {member} -> {target}")
    return target
