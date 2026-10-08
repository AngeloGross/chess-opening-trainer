"""Opening trainer: find and drill the opening positions where you lose eval."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
WEB_DIR = PROJECT_ROOT / "web"
TOOLS_DIR = PROJECT_ROOT / "tools"

# Lichess asks API clients to identify themselves; its export returns 404 for generic tool UAs such as
# curl's or python-requests' defaults, so always send this one.
USER_AGENT = "opening-trainer/0.2 (+https://github.com/AngeloGross/chess-opening-trainer)"
