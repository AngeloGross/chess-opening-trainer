"""Shared fixtures (spec/fixtures/*.json): the Python reference must reproduce every `expected` block.

vitest runs the same files through web/core/*.js (tests-js/fixtures.test.js). Regenerate with
`uv run python tools/make_fixture.py` after a deliberate rule change.
"""

import json
from pathlib import Path

import pytest
from helpers import run_fixture

SPEC = Path(__file__).resolve().parent.parent / "spec"
FIXTURES = sorted((SPEC / "fixtures").glob("*.json"))


def _load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_fixtures_exist():
    assert len(FIXTURES) >= 10


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.stem)
def test_fixture_matches_python_reference(path):
    fixture = _load(path)
    expected = fixture["expected"]
    actual = run_fixture(fixture)
    assert actual["results"] == expected["results"]
    assert actual["positions"] == expected["positions"]
    assert actual["progress"] == expected["progress"]


def test_round1_golden_matches_python_round():
    for num, den, rounded in _load(SPEC / "golden" / "round1.json")["cases"]:
        assert round(num / den, 1) == rounded, (num, den)
