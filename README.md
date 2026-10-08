# Opening Trainer

Finds the opening positions where you most often lose eval in your own Lichess games
(Lichess user `AngelOgro` by default), then lets you drill them on a board in the browser.

A local Python CLI downloads your games, runs Stockfish over your first moves, records the first
inaccuracy of each game, groups those by position and writes `web/positions.json`. A static page
(chessground + chess.js from jsDelivr) quizzes you on them, ranked by errors × average loss.

## Quick start

Requires [uv](https://docs.astral.sh/uv/). Works on Windows, Linux and macOS (see [Stockfish](#stockfish)).

```sh
uv run trainer setup     # download Stockfish for this platform into tools/stockfish/
uv run trainer update    # fetch games + analyse -> web/positions.json
uv run trainer serve     # open the trainer at http://127.0.0.1:8000/
```

The first `update` analyses the 2,000 most recent games at depth 18, which takes a while.
It can be interrupted at any time: downloaded games and engine results are kept, and a re-run
continues where it stopped.

## Stockfish

The engine is looked up in this order:

1. `STOCKFISH_PATH` environment variable, if set (must point to the binary)
2. `tools/stockfish/stockfish.exe` (Windows) or `tools/stockfish/stockfish` (Linux/macOS), installed by `uv run trainer setup`
3. `stockfish` on your `PATH`

`uv run trainer setup` downloads the latest official release for your OS and CPU:

| Platform | Release asset |
|---|---|
| Windows x86-64 / arm64 | `stockfish-windows-x86-64-universal.zip` / `stockfish-windows-arm64-universal.zip` |
| Linux x86-64 / arm64 | `stockfish-linux-x86-64-universal.tar.gz` / `stockfish-linux-arm64-universal.tar.gz` |
| macOS (Intel and Apple Silicon) | `stockfish-macos-universal.tar.gz` |

### Installing it yourself

Any UCI Stockfish works. The cache keys results by engine version, so switching engines never mixes evals.

- **Ubuntu/Debian:** `sudo apt install stockfish` installs `/usr/games/stockfish`. `/usr/games` is
  on `PATH` in a normal login shell; otherwise `export STOCKFISH_PATH=/usr/games/stockfish`.
  The distro package can be a few versions old, which is fine for opening analysis.
- **macOS:** `brew install stockfish`.
- **Manual download (any OS):** get the archive for your platform from
  <https://github.com/official-stockfish/Stockfish/releases/latest>, extract it, and either copy the
  binary to `tools/stockfish/stockfish` (`stockfish.exe` on Windows) or point `STOCKFISH_PATH` at it.
  On Linux/macOS make it executable:
  ```sh
  tar xzf stockfish-linux-x86-64-universal.tar.gz
  mkdir -p tools/stockfish
  cp stockfish/stockfish-linux-x86-64-universal tools/stockfish/stockfish
  chmod +x tools/stockfish/stockfish
  ```

Check it works: `printf 'uci\nquit\n' | tools/stockfish/stockfish` should print `uciok`.

## Options

`fetch`, `analyse` and `update` accept:

| Option | Default | Meaning |
|---|---|---|
| `--user` | `AngelOgro` | Lichess user |
| `--perf` | `blitz,rapid,classical` | perf types (rated and casual) |
| `--max-games N` | `2000` | most recent N games |
| `--all` | off | all games (ignores `--max-games`) |
| `--since YYYY-MM-DD` | none | only games on or after this date |
| `--max-moves N` | `15` | scan your first N moves |
| `--threshold CP` | `20` | loss in centipawns that counts as a mistake |
| `--depth N` | `18` | Stockfish search depth |

`serve` accepts `--port` and `--no-browser`. Running `python -m http.server -d web` works as well.

## How a mistake is found

For each of your moves: loss = eval(best move) − eval(your move), both from your side, clamped at 0.
Positions already decided (|eval| > 300 cp) are skipped. The first move with a loss of at least
the threshold is the game's mistake; the rest of the game is ignored. Positions are grouped by the
first four FEN fields, so move counters don't split them. For ranking, each loss is capped at
500 cp. The accepted answers come from one MultiPV-5 search: its top line plus every move within
the threshold of it, minus the moves you were marked wrong for.

## Data

Everything generated is git-ignored:

- `data/games-<user>.ndjson` - downloaded games
- `data/fetch-state-<user>.json` - back-fill cursor (oldest/newest game seen, incl. skipped ones)
- `data/evals.sqlite` - engine cache, keyed by engine version, position, depth and MultiPV
- `web/positions.json` - trainer input
- `tools/stockfish/` - engine

## Tests

```sh
uv run pytest
```
