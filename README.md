# Opening Trainer

Finds the opening positions where you most often lose eval in **your own Lichess games**,
then lets you drill them on a board in the browser: "find the best move" in exactly the
positions where you keep going wrong.

A local Python CLI downloads your games, runs Stockfish over your first moves, records the first
inaccuracy of each game, groups those by position and writes `web/positions.json`. A static page
(chessground + chess.js, vendored in `web/vendor/`) quizzes you on them, ranked by errors × average loss.
Everything runs on your own computer; no Lichess login is needed.

## Use it in the browser

The page can also do the whole job itself: download, Stockfish analysis (a WebAssembly build) and
training all run in the browser. **Open <https://angelogross.github.io/chess-opening-trainer/>**;
nothing to install. Every push to `main` that touches `web/` runs the JS tests and republishes the
site (`.github/workflows/pages.yml`). To run it locally instead, serve the `web/` folder:

```sh
uv run trainer serve                   # or any static file server for web/, e.g. python -m http.server -d web
```

Enter a Lichess name and press **Start**. The positions appear while the analysis is still running
(defaults: depth 14 and the 500 most recent games on a computer, depth 12 and 150 games on a phone;
change them under *Settings*). Everything is stored in the browser: the next visit shows the
positions at once, and **Update** fetches and analyses only new games. If `web/positions.json` from
the CLI exists, the start page offers it with one click ("Use analysis from the command line").
Browser and CLI evals differ slightly (the browser uses Stockfish's small network), so borderline
mistakes can differ between the two.

Before the first run the page measures the device with a few engine searches at the chosen depth and
shows the expected time ("About 12 min for 150 games at depth 12 on this device"); the estimate follows
changes to the game count and depth, is kept per device and depth, and *Settings → Re-measure* repeats
the test. During the run the time left comes from the real speed. On a phone where two engines are no
faster than one, only one is used. Phones keep the screen on during the analysis where the browser
supports it; keep the tab in front, because background tabs are slowed down or paused. On a phone only the
top 30 positions get their alternative answers checked during the run; any other position is checked
the first time it is opened ("Checking alternatives…", a few seconds) and the result is stored.
If Lichess cannot be reached or asks to slow down, the page waits a minute with a visible countdown
(Cancel stops it) and tries once more; already downloaded games are kept.

### Backups and moving to your phone

The **Data** button (or "Load a backup or analysis file" on the start page) shows whether the browser
keeps the data permanently. Browsers may clear site data when space runs short, and Safari does so after
7 days without a visit. From the same panel:

- **Export backup** saves `opening-trainer-<user>-<date>.json`. *Positions + stats* is small (about
  25-200 KB). *Full backup* adds the downloaded games and the engine cache, so **Update** can continue on
  the other browser without analysing again.
- **Load a file** (picker or drag-and-drop) reads a backup or the CLI's `positions.json`. If the browser
  already has that player, you choose between *Merge*, which keeps the newer analysis and, per position,
  the stats with more tries, and *Replace*.
- **Send to phone** analyses on the computer for training on the phone, with no server involved. The
  analysis and your stats are compressed into the link itself (`#import=…`). A QR code holds about 3 KB,
  so it carries the top ~40 positions. The link carries everything (about 23 KB for 400 positions);
  send it to yourself by e-mail or messenger and open it on the phone. Use the published site for this:
  a link to `127.0.0.1` only works on the same computer.

## Getting started

### 1. Install the tools (once)

You need **git** and **[uv](https://docs.astral.sh/uv/)** (uv installs the right Python by itself).

| System | git | uv |
|---|---|---|
| Windows (PowerShell) | `winget install Git.Git` | `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 \| iex"` |
| Ubuntu/Debian | `sudo apt install git` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| macOS | `xcode-select --install` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |

Open a new terminal afterwards so `uv` is found.

### 2. Get the trainer

```sh
git clone https://github.com/AngeloGross/chess-opening-trainer.git
cd chess-opening-trainer
uv run trainer setup                   # downloads Stockfish for your system into tools/stockfish/
```

### 3. Analyse your games

```sh
uv run trainer update --user YourLichessName --max-games 300
```

Your Lichess name is remembered, so later runs only need `uv run trainer update`.
Alternatively set the `LICHESS_USER` environment variable.

How long it takes depends on your CPU: roughly an hour for 500 games at the default depth 18.
Start small (`--max-games 300`, or `--depth 14` for a quicker, slightly less precise run) and
raise it later; the analysis can be stopped with Ctrl+C at any time and continues where it
stopped, because downloaded games and engine results are kept. Re-runs only analyse new games.

### 4. Train

```sh
uv run trainer serve                   # opens http://127.0.0.1:8000/ in your browser
```

On the first visit, click "Use analysis from the command line"; the browser remembers the choice.

Play the move you think is best. A move counts as correct if it is within the mistake threshold
(20 cp) of the engine's best move. "Reveal" shows the answer and the move you usually played;
every position links to the Lichess analysis board and to the games it came from.

### Testing on your phone

`uv run trainer serve --host 0.0.0.0` makes the pages reachable from other devices on the same
Wi-Fi; it prints the addresses to open on the phone (e.g. `http://192.168.1.23:8000/`). On Windows,
allow Python through the firewall for **private** networks only when asked. Everyone on that network
can open the pages while it runs, so use it at home, not on public or company networks. Plain
HTTP is enough for the trainer, `spike/lichess.html` and `spike/engine.html`.

### Several people on one computer

Games are stored per user, so switching with `--user OtherName` is fine, but `web/positions.json`
always holds the positions of the last analysed user. Re-run `uv run trainer analyse --user Name`
to switch back (fast, everything is cached).

### Troubleshooting

- **"Stockfish not found"**: run `uv run trainer setup`, or see [Stockfish](#stockfish) below.
- **"Lichess user ... not found"**: check the spelling of `--user` (it's your lichess.org name).
- **"Lichess rate limit hit"**: wait a minute, then run the same command again.
- **Port 8000 in use**: `uv run trainer serve --port 8001`.

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
| `--user` | remembered from the last run | your Lichess user name (or `$LICHESS_USER`) |
| `--perf` | `blitz,rapid,classical` | perf types (rated and casual) |
| `--max-games N` | `2000` | most recent N games |
| `--all` | off | all games (ignores `--max-games`) |
| `--since YYYY-MM-DD` | none | only games on or after this date |
| `--max-moves N` | `15` | scan your first N moves |
| `--threshold CP` | `20` | loss in centipawns that counts as a mistake |
| `--depth N` | `18` | Stockfish search depth |

`serve` accepts `--host` (default `127.0.0.1`; `0.0.0.0` for your phone), `--port` and `--no-browser`. Running `python -m http.server -d web` works as well.

## How a mistake is found

For each of your moves: loss = eval(best move) − eval(your move), both from your side, clamped at 0.
Positions already decided (|eval| > 300 cp) are skipped. The first move with a loss of at least
the threshold is the game's mistake; the rest of the game is ignored. Positions are grouped by the
first four FEN fields, so move counters don't split them. For ranking, each loss is capped at
500 cp. The accepted answers come from one MultiPV-5 search: its top line plus every move within
the threshold of it, minus the moves you were marked wrong for.

## Data

Everything generated is git-ignored:

- `data/settings.json` - remembered Lichess user
- `data/games-<user>.ndjson` - downloaded games
- `data/fetch-state-<user>.json` - back-fill cursor (oldest/newest game seen, incl. skipped ones)
- `data/evals.sqlite` - engine cache, keyed by engine version, position, depth and MultiPV
- `web/positions.json` - trainer input
- `tools/stockfish/` - engine

## Tests

```sh
uv run pytest            # Python CLI, including the shared fixtures
npm install              # once; dev-only, the site itself has no build step
npm test                 # JS port in web/core/ against the same fixtures
```

`spec/fixtures/*.json` are shared by both suites, so the Python CLI and the browser port must
agree on every mistake and every ranking. Python is the reference: after changing a rule there,
run `uv run python tools/make_fixture.py` to regenerate the expected values, then make the JS
port pass again (`--check` only reports stale fixtures).

## License

GPL-3.0-or-later, see [LICENSE](LICENSE). The project builds on python-chess (GPL-3.0) and
Stockfish (GPL-3.0). chessground 9.2.1 (GPL-3.0-or-later) and chess.js 1.4.0 (BSD-2-Clause) are
vendored unchanged in `web/vendor/` with their licenses, so the page loads nothing from third-party CDNs.

The browser port vendors the Stockfish.js 19 "lite single-threaded" WASM build (npm
`stockfish@19.0.0`, GPL-3.0) unchanged in `web/vendor/stockfish@19.0.0/`, with its license
(`Copying.txt`) and links to the corresponding source (`SOURCE.txt`). `web/spike/engine.html`
(served by `uv run trainer serve`) runs it in a pool of workers and benchmarks it.
