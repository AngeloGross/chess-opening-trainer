"""Opening trainer: find and drill the opening positions where you lose eval."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
WEB_DIR = PROJECT_ROOT / "web"
TOOLS_DIR = PROJECT_ROOT / "tools"

USER_AGENT = "opening-trainer/0.1 (lichess: AngelOgro)"
