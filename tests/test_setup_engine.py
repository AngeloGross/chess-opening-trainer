import io
import os
import tarfile
import zipfile

import pytest

from opening_trainer import setup_engine
from opening_trainer.setup_engine import SetupError, _extract_engine, _pick_asset, find_engine

RELEASE = {
    "tag_name": "sf_19",
    "assets": [
        {"name": n, "browser_download_url": f"https://example.invalid/{n}"}
        for n in (
            "stockfish-windows-x86-64-universal.zip",
            "stockfish-linux-x86-64-universal.tar.gz",
            "stockfish-linux-arm64-universal.tar.gz",
            "stockfish-macos-universal.tar.gz",
        )
    ],
}


@pytest.mark.parametrize(
    ("plat", "expected"),
    [
        (("windows", "x86-64"), "stockfish-windows-x86-64-universal.zip"),
        (("linux", "x86-64"), "stockfish-linux-x86-64-universal.tar.gz"),
        (("linux", "arm64"), "stockfish-linux-arm64-universal.tar.gz"),
        (("macos", "arm64"), "stockfish-macos-universal.tar.gz"),
    ],
)
def test_pick_asset_per_platform(plat, expected):
    assert _pick_asset(RELEASE, plat)["name"] == expected


def test_pick_asset_unknown_platform_points_to_manual_install():
    with pytest.raises(SetupError, match="STOCKFISH_PATH"):
        _pick_asset(RELEASE, ("freebsd", "x86-64"))


def _tar(path, files):
    with tarfile.open(path, "w:gz") as tf:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))


def test_extract_linux_tar_picks_binary_and_makes_it_executable(tmp_path):
    archive = tmp_path / "a.tar.gz"
    _tar(archive, {
        "stockfish/README.md": b"readme",
        "stockfish/scripts/net.sh": b"#!/bin/sh",
        "stockfish/stockfish-linux-x86-64-universal": b"ELF-engine",
    })
    target = tmp_path / "stockfish"
    assert _extract_engine(archive, target) == "stockfish/stockfish-linux-x86-64-universal"
    assert target.read_bytes() == b"ELF-engine"
    if os.name == "posix":  # Windows has no executable bit
        assert target.stat().st_mode & 0o100


def test_extract_windows_zip(tmp_path):
    archive = tmp_path / "a.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("stockfish/Copying.txt", "gpl")
        zf.writestr("stockfish/stockfish-windows-x86-64-universal.exe", b"MZ-engine")
    target = tmp_path / "stockfish.exe"
    _extract_engine(archive, target)
    assert target.read_bytes() == b"MZ-engine"


def test_extract_rejects_archive_without_engine(tmp_path):
    archive = tmp_path / "a.tar.gz"
    _tar(archive, {"stockfish/README.md": b"readme"})
    with pytest.raises(SetupError, match="No Stockfish binary"):
        _extract_engine(archive, tmp_path / "stockfish")
    assert not (tmp_path / "stockfish").exists()


def test_find_engine_order(tmp_path, monkeypatch):
    installed = tmp_path / "installed"
    on_path = tmp_path / "on_path"
    env = tmp_path / "env"
    for p in (installed, on_path, env):
        p.write_bytes(b"x")
    monkeypatch.setattr(setup_engine, "installed_path", lambda os_name=None: installed)
    monkeypatch.setattr(setup_engine.shutil, "which", lambda name: str(on_path))

    monkeypatch.setenv("STOCKFISH_PATH", str(env))
    assert find_engine() == env
    monkeypatch.delenv("STOCKFISH_PATH")
    assert find_engine() == installed
    installed.unlink()
    assert find_engine() == on_path
    monkeypatch.setattr(setup_engine.shutil, "which", lambda name: None)
    assert find_engine() is None


def test_find_engine_rejects_bad_env_path(tmp_path, monkeypatch):
    monkeypatch.setenv("STOCKFISH_PATH", str(tmp_path / "missing"))
    with pytest.raises(SetupError, match="not a file"):
        find_engine()
