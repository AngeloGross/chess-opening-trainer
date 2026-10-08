# Shared fixtures

Each `*.json` file here is one scenario. Both the Python reference and the JS port in `web/core/` run every file:

- **Python:** `tests/test_fixtures.py` (pytest)
- **JS:** `tests-js/fixtures.test.js` (vitest)

Both suites compare against the same `expected` block. If a rule changes, update the fixtures. Both suites then fail until the two implementations agree again (design §6, §9, §10).

## Shape

```jsonc
{
  "name": "repeated-position",          // = file stem
  "scenarios": ["…", "…"],              // what the fixture pins down, for humans
  "user": "AngelOgro",                  // Lichess name, matched case-insensitively against id or name
  "settings": {"max_moves": 15, "threshold": 20},
  "games": [ /* Lichess /api/games/user ndjson objects, most recent first:
                id, rated, variant, speed, perf, createdAt, status, players, opening?, moves (SAN string) */ ],
  "fakeEngine": {"<fenKey>": ["<bestUci>" | null, <cp for side to move>]},
  "topMoves":   {"<fenKey>": [["<uci>", <cp>], …]},   // MultiPV result, best first
  "expected": {
    "results":   [ /* one per game, in game order */
      null,                             // analyse_game returned None (not his game, or no moves)
      {"color": "white" | "black",
       "reached": ["<fenKey>", …],      // in scan order, duplicates kept
       "mistake": null | {"fen", "key", "ply", "played", "played_san", "best", "best_san", "loss", "eval_best"},
       "evaluated": ["<fenKey>", …]}    // every evaluate() call, in order
    ],
    "positions": [ /* aggregate() output: the positions.json entries, exact key order */ ],
    "progress":  [[1, n], [2, n], …]    // on_progress / onProgress calls
  }
}
```

## Fake engine rules

Both languages implement these rules identically.

- **`evaluate(fen)`** looks up `fenKey(fen)` in `fakeEngine`. An unknown position answers `[null, 0]`, which means "no best move", so the position is not judged. This differs from `tests/helpers.py` `FakeEngine`, which answers "first legal move". python-chess and chess.js order legal moves differently, so that answer would not be the same in both languages.
- **`topMoves(fen)`** looks up `fenKey(fen)` in `topMoves`. An unknown position answers `[]`.
- **`aggregate`** gets only the games whose result is not `null`, in game order.

Every key in `fakeEngine` and `topMoves` was computed by python-chess. If chess.js produced a different key for the same position (for example, a different en-passant field), the lookups would miss and the JS results would differ.

## Regenerating

```
uv run python tools/make_fixture.py           # write the scripted fixtures, refresh `expected` of any others
uv run python tools/make_fixture.py --check   # exit 1 if a file is out of date
```

- **Scripted fixtures.** Most fixtures are defined as SAN move lists in `tools/make_fixture.py`, which writes the whole file.
- **Hand-written fixtures.** Any other `*.json` you drop in here keeps its inputs; only its `expected` block is recomputed from Python. Never edit `expected` by hand.
- **`spec/golden/round1.json`.** The script also writes this file: Python `round(num / den, 1)` for averages around `.x5`, including exact binary ties. It backs the JS `round1` helper.
