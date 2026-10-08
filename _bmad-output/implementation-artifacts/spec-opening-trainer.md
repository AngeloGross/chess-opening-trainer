---
title: 'Opening trainer from own Lichess games'
type: 'feature'
created: '2026-10-08'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'NO_HEAD (empty repo, all files new)'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Angelo (Lichess `AngelOgro`, ~20k blitz games) keeps losing small amounts of eval in the openings he plays most, but has no way to find and drill the positions where he goes wrong repeatedly.

**Approach:** A local Python CLI downloads his games, uses local Stockfish to find his first opening inaccuracy per game, groups them by position, and writes `positions.json`. A static HTML trainer (chessground + chess.js) then quizzes him on those positions, most frequent × most costly first, with a Lichess analysis-board link for each.

## Boundaries & Constraints

**Always:**
- Defaults: perf types `blitz,rapid,classical` (rated and casual), the **2,000 most recent** games, his first **15 moves**, threshold **20 cp**, depth **18**. Every default can be overridden on the CLI (`--max-games`, `--all`, `--since YYYY-MM-DD`, `--perf`, `--max-moves`, `--threshold`, `--depth`).
- Lichess requests send a descriptive `User-Agent`; without one, `/api/games/user/{name}` returns 404. Stream ndjson with `opening=true`.
- Loss = eval(best) − eval(played), both from Angelo's side, clamped at ≥ 0. Positions where |eval(best)| > 300 cp are skipped. Only the **first** qualifying move per game counts.
- Engine results are cached on disk, keyed by FEN + depth, so re-runs and interrupted runs never re-analyse a position.
- Fetching is incremental: games already stored are not downloaded again.
- Generated data (`data/`, `web/positions.json`, `tools/stockfish/`) is git-ignored.

**Ask First:** Adding any Python dependency beyond `chess`, `requests`, `pytest`. Using a Lichess OAuth token or any write API.

**Never:** Lichess cloud-eval / opening-explorer APIs (keep to one engine source). Variants, Chess960, or games starting from a custom FEN. A build step or bundler for the web page. Any backend beyond a static file server.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mistake found | White, move 6 eval +0.30 → +0.08 after his move | Record: FEN before, his move, best move, loss 22, ECO/name, game URL | N/A |
| Best move played | His move == engine best | loss 0, position after it not analysed | N/A |
| Already decided | eval(best) = +3.50 | Skipped, continue scanning | N/A |
| No mistake | No qualifying move in first 15 | Game counted as clean, no record | N/A |
| Mate score | Engine returns mate | Mapped to ±10000 cp, then normal rules apply | N/A |
| Short game | Game ends before move 15 | Scan the available moves only | N/A |
| Repeated position | Same FEN (first 4 fields) erred in 7 of 9 games | One entry: errors 7, reached 9, moves played with counts | N/A |
| Missing engine | `tools/stockfish/` empty | CLI says to run `uv run trainer setup` | Exit code 1 |
| Network failure | Lichess stream aborts | Games received so far are kept; re-run resumes | Clear error message |

</frozen-after-approval>

## Code Map

- `pyproject.toml` -- uv project, Python ≥ 3.11, script entry point `trainer`
- `opening_trainer/cli.py` -- subcommands `setup`, `fetch`, `analyse`, `update` (fetch + analyse), `serve`
- `opening_trainer/setup_engine.py` -- downloads the latest official Stockfish Windows x86-64 zip (`universal`, falling back to `avx2` for older releases) from GitHub releases into `tools/stockfish/`
- `opening_trainer/fetch.py` -- incremental ndjson download into `data/games-<user>.ndjson`, back-fill cursor in `data/fetch-state-<user>.json`
- `opening_trainer/engine.py` -- `python-chess` UCI wrapper plus SQLite cache `data/evals.sqlite` (keyed by engine name, FEN key, depth, MultiPV)
- `opening_trainer/analyse.py` -- per-game first-mistake detection (pure logic, engine injected)
- `opening_trainer/aggregate.py` -- groups by position, ranks, writes `web/positions.json`
- `web/index.html`, `web/trainer.js`, `web/style.css` -- the trainer page
- `tests/` -- pytest

## Tasks & Acceptance

**Execution:**
- [x] `pyproject.toml`, `.gitignore`, `README.md` -- project scaffold; the README gives the three-command quick start (`setup`, `update`, `serve`)
- [x] `opening_trainer/setup_engine.py` -- fetches the release asset and extracts the exe to a fixed path -- needed for a reproducible engine location
- [x] `opening_trainer/fetch.py` -- fetches newer games with `since`=newest stored+1; if fewer than `--max-games` are stored, back-fills older ones with `until`=oldest stored−1; keeps only standard-variant games with no `initialFen`
- [x] `opening_trainer/engine.py` -- `evaluate(fen) -> (best_uci, cp_for_side_to_move)` and `top_moves(fen, n=5)`; threads = CPU count − 1, hash 256 MB; cached
- [x] `opening_trainer/analyse.py` -- applies the matrix rules; also counts "reached" per FEN key for every analysed game where it is his move
- [x] `opening_trainer/aggregate.py` -- per FEN key: errors, reached, average loss (each loss capped at 500 cp), rank score = errors × average loss, played moves with counts, best move, `acceptable` moves (best move and accept window both from the MultiPV-5 run on mistake positions: the top line plus moves within threshold of it, excluding his recorded mistake moves), opening name/ECO, up to 5 game URLs, orientation; sorted by rank score
- [x] `opening_trainer/cli.py` -- wires up the options; shows progress (games / positions analysed); `serve` runs `http.server` on `web/` and opens the browser
- [x] `web/*` -- chessground and chess.js loaded as ESM from jsDelivr at pinned exact versions; position list with filters (opening, colour); quiz: drag a move → correct if in `acceptable`, otherwise show "not quite" with Retry / Reveal; Reveal shows the best move as an arrow plus his usual move; each position has a Lichess analysis link `https://lichess.org/analysis/<FEN with spaces→_>?color=white|black` and its game links; Next / Previous; per-browser solved stats in `localStorage` (wrapped in try/catch)
- [x] `tests/test_analyse.py`, `tests/test_aggregate.py`, `tests/test_fetch.py` -- the matrix scenarios with a fake engine; FEN key normalisation; since/until parameter calculation

**Acceptance Criteria:**
- Given a fresh clone, when he runs `uv run trainer setup`, then `uv run trainer update`, then `uv run trainer serve`, then the browser shows ranked positions from his own games.
- Given `update` was stopped halfway, when it is re-run, then cached positions are not sent to the engine again.
- Given a position in the trainer, when he plays the engine's best move, then the page marks it solved and offers Next.
- Given any position, when he clicks the Lichess link, then the Lichess analysis board opens on that exact position from his side.

## Design Notes

The loss needs no extra engine calls: `eval(played) = −evaluate(fen_after_move).cp`, and that position is only analysed when his move ≠ the best move. Small depth noise between the two searches is accepted, and the loss is clamped at 0. The FEN key is the first four FEN fields, so move counters don't split identical positions. MultiPV 5 is run only for positions that end up in the output, so it costs little; the trainer's best move and accept window both come from that one search, so they cannot disagree. Losses are capped at 500 cp for averages and ranking, so one blunder does not outrank a mistake repeated many times.

## Verification

**Commands:**
- `uv run pytest` -- expected: all pass
- `uv run trainer update --max-games 50 --depth 12` -- expected: completes, and `web/positions.json` is non-empty and valid JSON

**Manual checks:**
- `uv run trainer serve`: the board renders, a move can be made, Reveal shows an arrow, the Lichess link opens the correct position.

## Suggested Review Order

**Mistake detection (the core rule)**

- Entry point: first qualifying move per game, eval window, loss clamp and cap.
  [`analyse.py:43`](../../opening_trainer/analyse.py#L43)

- Wires the user's colour, ply limit and game URL into the pure rule.
  [`analyse.py:113`](../../opening_trainer/analyse.py#L113)

**Engine and cache**

- One search per position; empty results raise and are never cached.
  [`engine.py:134`](../../opening_trainer/engine.py#L134)

- Cache keyed by 4-field FEN, depth and engine name, so upgrades never mix evals.
  [`engine.py:45`](../../opening_trainer/engine.py#L45)

**Ranking and accepted moves**

- Groups by position; rank = errors × capped average loss.
  [`aggregate.py:53`](../../opening_trainer/aggregate.py#L53)

- MultiPV-5 window around the top line; his own mistake moves are never accepted.
  [`aggregate.py:38`](../../opening_trainer/aggregate.py#L38)

**Fetching games**

- Incremental download, plus a cursor-driven back-fill that survives batches of only skipped games.
  [`fetch.py:175`](../../opening_trainer/fetch.py#L175)

- How the since/until parameters are derived for both directions.
  [`fetch.py:118`](../../opening_trainer/fetch.py#L118)

**Trainer page**

- Move check, promotion handling, a single recorded result per visit.
  [`trainer.js:109`](../../web/trainer.js#L109)

- Reveal counts as a failure; stats keep the latest result.
  [`trainer.js:132`](../../web/trainer.js#L132)

- Empty filter locks the board so no stale move can be played.
  [`trainer.js:213`](../../web/trainer.js#L213)

**CLI, setup and peripherals**

- Option validation and friendly errors for engine, OS and network failures.
  [`cli.py:222`](../../opening_trainer/cli.py#L222)

- Atomic Stockfish install; prefers the universal build.
  [`setup_engine.py:63`](../../opening_trainer/setup_engine.py#L63)

- Fake-engine tests for every row of the I/O matrix.
  [`test_analyse.py:1`](../../tests/test_analyse.py#L1)
