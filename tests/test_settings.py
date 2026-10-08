import pytest

from opening_trainer import fetch as fetch_mod
from opening_trainer.fetch import FetchError, check_user
from opening_trainer.settings import UserNotSetError, remember_user, remembered_user, resolve_user


@pytest.fixture(autouse=True)
def no_env_user(monkeypatch):
    monkeypatch.delenv("LICHESS_USER", raising=False)


def test_explicit_user_wins_over_env_and_remembered(tmp_path, monkeypatch):
    path = tmp_path / "settings.json"
    remember_user("Remembered", path)
    monkeypatch.setenv("LICHESS_USER", "FromEnv")
    assert resolve_user("Explicit", path) == "Explicit"
    assert resolve_user(None, path) == "FromEnv"
    monkeypatch.delenv("LICHESS_USER")
    assert resolve_user(None, path) == "Remembered"


def test_no_user_anywhere_explains_what_to_do(tmp_path):
    with pytest.raises(UserNotSetError, match="--user YourName"):
        resolve_user(None, tmp_path / "settings.json")


def test_corrupt_settings_file_is_treated_as_empty(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text("{not json", encoding="utf-8")
    assert remembered_user(path) is None
    remember_user("Friend", path)
    assert remembered_user(path) == "Friend"


class _Resp:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise fetch_mod.requests.HTTPError(str(self.status_code))

    def json(self):
        return self._body


@pytest.mark.parametrize(
    ("resp", "expected"),
    [
        (_Resp(200, {"username": "AngelOgro"}), "AngelOgro"),
        (_Resp(200, {}), "angelogro"),
    ],
)
def test_check_user_returns_canonical_name(monkeypatch, resp, expected):
    monkeypatch.setattr(fetch_mod.requests, "get", lambda *a, **kw: resp)
    assert check_user("angelogro") == expected


@pytest.mark.parametrize(
    ("resp", "message"),
    [
        (_Resp(404), "not found"),
        (_Resp(429), "rate limit"),
        (_Resp(200, {"username": "Gone", "disabled": True}), "closed"),
    ],
)
def test_check_user_errors(monkeypatch, resp, message):
    monkeypatch.setattr(fetch_mod.requests, "get", lambda *a, **kw: resp)
    with pytest.raises(FetchError, match=message):
        check_user("someone")
