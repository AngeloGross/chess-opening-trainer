---
title: 'Opening trainer in the browser (Option C): architecture'
type: 'architecture'
created: '2026-10-08'
author: 'Angelo Groß'
status: 'draft'
related:
  - '../implementation-artifacts/spec-opening-trainer.md'
---

# Opening trainer in the browser (Option C)

## 1. Goal and non-goals

**Goal.** A fully static website (GitHub Pages by default; any static host works, see §13) that a non-technical friend opens, types a Lichess name into, and gets the same training set that `uv run trainer update` produces today. Downloading, Stockfish analysis and the quiz all run in the visitor's browser. There is no backend and no hosting cost.

**Non-goals for v1:**

- No accounts, no server, no analytics, no shared database. Everything stays in the visitor's browser.
- No Lichess OAuth. Anonymous export is enough (20 games/s, see §3.1). OAuth with PKCE is a later option: it raises the export rate to 30 games/s, or 60 games/s for the user's own games. It also adds a redirect flow and token storage, which v1 does not need.
- No variants, no Chess960, no custom start positions. This is the same boundary as the CLI.
- No Lichess cloud-eval or opening-explorer APIs. As in the CLI, one engine is the only source of evals.
- No identical numbers to the CLI. The browser uses the Stockfish *lite* network, so evals differ slightly. What must be identical are the **rules** (§6).

## 2. User flow

1. **Enter name.** A text field plus "Start". The last name is remembered. Several names can live side by side because every store is keyed by user (§5).
2. **Check user.** `GET /api/user/{name}` resolves the canonical name, or shows "not found" or "account closed".
3. **Download.** A progress bar ("312 / 500 games"). Games are streamed and stored one at a time, so a closed tab loses nothing. A re-visit only downloads newer games.
4. **Analyse.** A progress bar showing games done, positions analysed, cache hits and an ETA. It has **Pause** and **Resume** buttons. Closing the tab counts as a pause, and the next visit offers "Continue analysis (212 of 500 left)". Positions found so far can already be trained during the run (§8).
5. **Train.** The existing quiz UI: board, filters, Retry and Reveal, Lichess links.
6. **Settings (collapsed by default).** Number of games, depth ("Quick 14", "Thorough 18"), perf types, max moves and threshold. These are the CLI options with the same defaults, except depth and game count (§8).

## 3. Research findings

### 3.1 Lichess from a browser: CORS and User-Agent

All tests were run with curl on 2026-10-08 against `AngelOgro`.

| Request | Result |
|---|---|
| `GET /api/user/AngelOgro` with `Origin: https://example.github.io` | **200**, `Access-Control-Allow-Origin: *` (verified) |
| Preflight `OPTIONS` on the same URL | **204**, ACAO `*`, `Access-Control-Max-Age: 86400` (verified) |
| Export with `Origin` and `User-Agent: test` | **200** `application/x-ndjson`, ACAO `*` (verified) |
| Export with `Origin` and **no** UA header (`curl -A ""`) | **200** ndjson, ACAO `*` (verified) |
| Export with **no** UA and no Origin | **200**, but PGN because no `Accept` was sent (verified) |
| Export with curl's default UA (`curl/8.x`), with or without Origin | **404** (verified) |
| Export with UA `python-requests/2.32.3` | **404** (verified) |
| Export with a Chrome, Firefox or iOS-Safari UA, plus `Origin`, `Accept: application/x-ndjson` and `Sec-Fetch-*` | **200** ndjson, ACAO `*` (verified with curl imitating the browsers; **not yet run from a real browser page**) |
| Unknown user, on both `/api/user` and the export | **404** `{"error":"Not found"}` **with** ACAO `*`, so a page can read it (verified) |

**Conclusion.** The 404 is not caused by a *missing* User-Agent. Lichess rejects **known tool UAs** such as `curl/…` and `python-requests/…`. A browser always sends its own UA, and that UA is accepted. The comment in `opening_trainer/__init__.py` ("without a User-Agent the game export returns 404") should be read as "with the default `requests` UA". The browser page does not need to set a UA, and it cannot.

**Slice 1 result (2026-10-08, real browser engine).** `web/spike/lichess.html` with `web/lichess/client.js` was run in Microsoft Edge 141 (Chromium), driven headless over the DevTools protocol from `http://127.0.0.1:8765`:

- `checkUser` returns the canonical name, and an unknown user gives a readable `not_found` (verified).
- `streamGames` streams ndjson live through `fetch()` + `ReadableStream`: 4 → 44 → 50 games, 50 in 2.3 s (about 20 games/s, the documented anonymous rate). `AbortController` stops a 300-game stream cleanly mid-way (verified).
- **New finding: Lichess returns 404 for the `HeadlessChrome` User-Agent** (curl with the same UA confirms: 404 with `HeadlessChrome/141`, 200 with `Chrome/141`). Real visitors are unaffected. **Any automated browser test (Playwright, CI) must override the UA** with a normal browser string, or point at a fake Lichess route.
- **Still open:** Firefox and Safari/iOS (not installed here), and a public HTTPS origin. Run the spike page there once it is deployed.

`Accept: application/x-ndjson` is a CORS-safelisted request header, so the export is a *simple* request with no preflight. The preflight answer is fine anyway.

**Rate limits.** Lichess asks for "only one request at a time" and, after a 429, a wait of "a full minute" ([api-tips](https://lichess.org/page/api-tips)). The export is throttled to 20 games/s when anonymous ([OpenAPI spec](https://github.com/lichess-org/api/blob/master/doc/specs/tags/games/api-games-user-username.yaml)), so 500 games take about 25 s and 2,000 about 100 s. My own probing triggered one 429. **Unverified:** whether a 429 response carries ACAO. If it does not, `fetch()` rejects with an opaque `TypeError` and the status cannot be read. The design therefore treats a network-level failure of the export like a 429: keep what was stored, wait 60 s and retry once (§10).

**Streaming.** `fetch()` exposes `response.body` as a `ReadableStream`. Piping it through `TextDecoderStream` and a newline splitter gives one game per line as it arrives, with `AbortController` to cancel. This is standard Fetch/Streams API (MDN) and works in all evergreen browsers. Not yet exercised against Lichess from a page (unverified).

### 3.2 Stockfish in the browser

| Option | License | Download | Threads | Verdict |
|---|---|---|---|---|
| **nmrugg/stockfish.js, npm `stockfish@19.0.0`, "lite single"** | GPL-3.0 | `stockfish-19-lite-single.wasm` **1.79 MB** + 21 KB JS. The small NNUE net (`nn-61e7af4bb97d`) is embedded. | 1, no SharedArrayBuffer needed | **Recommended** |
| same package, "lite" multi-threaded | GPL-3.0 | 1.64 MB + 33 KB | needs cross-origin isolation (COOP/COEP) | not needed, see the measurements below |
| same package, full net, single or MT | GPL-3.0 | **~99 MB** `.wasm` each | 1 or MT | too large for phones and friends; close to GitHub's 100 MB file limit |
| same package, asm.js | GPL-3.0 | 3.1 MB | 1 | "very slow and weak", last resort only |
| lichess-org/stockfish-web (`@lichess-org/stockfish-web@0.5.0`) | GitHub says GPL-3.0; **npm metadata says AGPL-3.0-or-later** | builds `sf_19`, `sf_19_smallnet`, `fsf_14`; nets loaded separately | pthreads | README itself says it "is not straight-forward to load and use" and points to stockfish.js |

The sizes come from the unpkg file listing of `stockfish@19.0.0`. jsDelivr **refuses** this package ("Package size exceeded the configured limit of 150 MB"), and Worker scripts must be same-origin anyway, so the engine files are **vendored** into the site.

**COOP/COEP on GitHub Pages.** Pages cannot set custom response headers, and these headers do not work as `<meta>` tags. GitHub has acknowledged the request but given no ETA ([community discussion #13309](https://github.com/orgs/community/discussions/13309)). The workaround is [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker). It must be self-hosted, it reloads the page once on the first visit, and every cross-origin subresource must then be CORS- or CORP-clean.

**Measured speed** (this machine, 24 logical cores; Node 24 running the same `.js`/`.wasm` the browser would load; 20 real mistake positions from `web/positions.json`; time to a fixed depth; Hash 64 MB; cold hash per position):

| Depth | Native SF19 full net, 1 thread | Native, 8 threads | WASM lite, single | WASM lite MT, 4 threads |
|---|---|---|---|---|
| 12 | 31 ms | 26 ms | 39 ms | 185 ms |
| 14 | 60 ms | 70 ms | **100 ms** | 237 ms |
| 16 | 147 ms | 225 ms | 290 ms | 400 ms |
| 18 | 331 ms | 498 ms | **661 ms** | 711 ms |
| MultiPV 5, depth 14 | — | — | **704 ms** | — |

Single-threaded WASM ran at about 650–680 kn/s against about 1,000–1,080 kn/s native. Time to depth was about **1.7–2× native single-thread**, even though the WASM build uses the smaller, faster net. **At these depths, extra threads per search do not shorten time to depth**, natively or in WASM: Lazy SMP spends the extra nodes on breadth. Throughput therefore comes from **several single-threaded engines analysing different games in parallel**. That needs no SharedArrayBuffer, so it needs no COOP/COEP and no service worker.

Caveats: Node's V8 is a good proxy for Chrome's but not identical. Mobile CPUs are **unmeasured**; I estimate 3–5× slower per core (unverified). I found no published, rigorous native-versus-WASM benchmark. Lichess and talkchess sources only say "near native" anecdotally.

**Recommendation:** vendor `stockfish-19-lite-single.{js,wasm}` and run a pool of N engine workers. N is `min(hardwareConcurrency − 1, 4)` on desktop and 2 when the user agent is mobile. coi-serviceworker stays an option for v2 (§10).

**GPL.** Serving the `.wasm` file to visitors is distribution, so the site must ship the license text (`Copying.txt`) and offer the corresponding source, which a link to the exact upstream tag satisfies. The repository is already `GPL-3.0-or-later` (`pyproject.toml`, `LICENSE`), and chessground, already used by the trainer, is GPL-3.0-or-later too. So publishing the whole site source under the repo's GPL is the simple, compliant answer. chess.js is BSD-2-Clause and compatible with it.

### 3.3 Persistence

IndexedDB holds the games and the eval cache. Quotas are generous: Chrome allows up to 60 % of disk, Firefox min(10 % of disk, 10 GiB) best-effort, and Safari about 60 % ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)). The real data volume is small. The CLI's 2,006 stored games are 1.6 MB of ndjson (about 800 B per game). A 500-game run at depth 14 produced 2,122 single-PV and 400 MultiPV cache rows, well under 1 MB. **Eviction** is the real risk:

- Storage is best-effort by default, so call `navigator.storage.persist()`. Chromium and Safari grant or deny it silently; Firefox prompts.
- Safari deletes script-written storage after **7 days without interaction** when tracking prevention is on.
- Mitigation: losing data only costs a re-download and re-analysis. An "Export / Import backup" button (one JSON file holding the positions document and quiz stats) protects the valuable part.

## 4. Architecture overview

```mermaid
flowchart LR
  subgraph Main["Main thread (UI)"]
    UI["App shell<br/>name form · progress · settings"]
    TR["Trainer view<br/>(existing trainer.js, data injected)"]
    CO["Analysis coordinator<br/>queue · in-flight dedupe · checkpoints"]
    AG["aggregate.js<br/>(pure)"]
    AN["analyse.js<br/>(pure, async evaluator)"]
  end
  subgraph FW["Fetch worker (1)"]
    LF["lichess.js<br/>check user · stream ndjson · since/until cursor"]
  end
  subgraph EP["Engine pool (N workers)"]
    E1["engine worker 1<br/>stockfish-19-lite-single.wasm"]
    E2["engine worker …N"]
  end
  subgraph DB["IndexedDB (store.js)"]
    G[("games")]
    FS[("fetchState")]
    EV[("evals")]
    RS[("results")]
    PS[("positions")]
    ST[("settings")]
  end
  LICHESS["lichess.org API<br/>CORS *"]

  UI -- "start(user, settings)" --> LF
  LF -- "GET (1 request at a time)" --> LICHESS
  LF -- put --> G
  LF -- put --> FS
  LF -- progress --> UI
  UI -- "analyse / pause" --> CO
  CO -- reads --> G
  CO --> AN
  AN -- "evaluate(fen) / topMoves(fen)" --> CO
  CO -- "cache get/put" --> EV
  CO -- "UCI job" --> E1
  CO -- "UCI job" --> E2
  CO -- "per-game result" --> RS
  CO -- checkpoint --> AG
  AG -- "positions doc" --> PS
  PS --> TR
  ST --> UI
```

The **coordinator runs on the main thread**. Its work is tiny: SAN parsing with chess.js, a few IndexedDB writes, and message routing. Keeping it there avoids nested workers and keeps pause/resume simple. All CPU-heavy work runs in the engine workers. The fetch worker exists so that a long stream and JSON parsing never block the board.

## 5. Module boundaries and data model

Repository layout, all plain ES modules with no build step:

```
web/
  index.html            app shell + trainer markup
  app.js                flow: name → download → analyse → train
  trainer.js            existing quiz, changed to start from a doc object instead of fetch('positions.json')
  core/fen.js           fenKey, scoreToCp           (pure)
  core/analyse.js       analyseMoves, playerColor, gameUrl (pure, async evaluator)
  core/aggregate.js     aggregate, acceptableMoves  (pure)
  core/fetchPlan.js     newerParams, backfillParams, isSupported, Cursor (pure)
  lichess/client.js     checkUser, streamGames (fetch + ReadableStream)
  lichess/fetch.worker.js
  engine/uci.js         UCI line parser → [(uci|null, cp)] + one PV per line (pure)
  engine/engine.worker.js  wraps vendor stockfish, one job at a time
  engine/pool.js        N workers, job queue, stop/terminate
  analysis/coordinator.js
  analysis/explainer.js  eval line + "Why am I better?" searches, per page view (design-position-explanation.md)
  core/material.js      settledMaterial (port of book.py settled_material, pure)
  core/explain.js       engine line, pass FEN, verdict (pure)
  store/db.js           IndexedDB schema + typed accessors
  vendor/chess.js@1.4.0/…, vendor/chessground@9.2.1/…, vendor/stockfish@19.0.0/{stockfish-19-lite-single.js,.wasm,Copying.txt}
```

The pure modules import chess.js by a **relative path** (`../vendor/…`). The same file therefore loads in the page, in a module worker and in Node/vitest, with no import map, which module workers do not support everywhere.

**IndexedDB `opening-trainer`, version 1:**

| Store | Key | Value | Notes |
|---|---|---|---|
| `settings` | `name` | any | `lastUser`, UI prefs |
| `games` | `[userId, gameId]` | the Lichess game object, slimmed to `id, createdAt, perf, variant, players, opening, moves` | index `byUserCreated` `[userId, createdAt]` |
| `fetchState` | `userId` | `{perfs[], oldestSeen, newestSeen, exhausted}` | same fields as `Cursor` in `fetch.py` |
| `evals` | `[engineId, fenKey, depth, multipv]` | `[[uci\|null, cp], …]` | same key as `evals.sqlite`; `engineId` = UCI `id name` + vendored version |
| `results` | `[userId, runKey, gameId]` | `{color, reached[], mistake\|null}` | `runKey` = hash of `{engineId, depth, maxMoves, threshold, bookId, bookMoves, openingMoves, openingFloor}` (runKey/3, 2026-10-10); enables resume and progressive aggregation |
| `positions` | `userId` | the full `positions.json` document | what the trainer reads |

`userId` is the lower-cased Lichess id. Quiz stats stay in `localStorage` as today, under the key `opening-trainer:stats:<userId>` (today it is not per user).

**The positions document keeps today's shape exactly:** `{generated, user, games, clean_games, settings:{perf, max_moves, threshold, depth}, positions:[…]}`. Each entry has `key, fen, orientation, errors, reached, avg_loss, raw_avg_loss, score, best, best_san, acceptable[], played[{uci,san,count}], eco, opening, games[]`. The only additions are `settings.engine` and, since 2026-10-10, `settings.book_moves` and `settings.book` (both CLI and browser): optional fields the trainer ignores. As a result, `trainer.js` can show a document from the CLI or from the browser unchanged.

## 6. Porting plan and invariants

| Python | JS module | Notes |
|---|---|---|
| `engine.fen_key`, `score_to_cp`, `MATE_CP` | `core/fen.js`, `engine/uci.js` | UCI `score mate n` → ±10000; take the last `info` line at the target depth per `multipv` index |
| `engine.Engine._analyse` (terminal-position short cut, cache) | `analysis/coordinator.js` | checkmate → `[(null, −10000)]`; stalemate or insufficient material → `[(null, 0)]`, without calling the engine |
| `analyse.analyse_moves`, `player_color`, `game_url`, `analyse_game` | `core/analyse.js` | the evaluator becomes `async`; otherwise a line-by-line port |
| `aggregate.acceptable_moves`, `aggregate` | `core/aggregate.js` | `top_moves` is passed in as a lookup of already-cached MultiPV results |
| `fetch.is_supported`, `StoreState`, `Cursor`, `newer_params`, `backfill_params` | `core/fetchPlan.js` | pure; the I/O moves to `lichess/client.js` |
| `fetch._stream`, `check_user` | `lichess/client.js` | no UA header; `Accept: application/x-ndjson` |
| `cli.select_games` | `analysis/coordinator.js` | most recent first, filtered by perf, `isSupported` and since |
| `settings.py`, `setup_engine.py`, `cmd_serve` | none | replaced by the `settings` store, the vendored engine and GitHub Pages |

**Invariants that must stay identical.** These are covered by the shared fixtures (§9).

1. **FEN key** = the first four FEN fields. **Risk to verify first:** python-chess `board.fen()` writes the en-passant square only if a *legal* en-passant capture exists. chess.js must produce the same field, or keys split. A fixture with a double pawn push with and without an adjacent enemy pawn pins this down. If chess.js differs, `fenKey` normalises the field itself.
2. **Scan:** only the player's moves; stop when `fullmoveNumber > maxMoves`; stop at an unparsable SAN; record `reached` for every own move scanned. **Gambit moves (2026-10-10)** are recorded in `reached` but never evaluated, and the scan goes on: while `fullmoveNumber ≤ bookMoves`, a move whose resulting key is in the gambit book `web/book/gambits.json`. `book.py` builds it from `chess-openings` (via `tools/make_fixture.py`): the last position of every line named "Gambit", plus the sacrificing side's moves in any named line that ends 1 to 3 points of settled material down (capture-only search), not mate. CLI and browser read the same file; `spec/fixtures/deliberate-moves.json` pins the skip rule. **Opening choices:** while `fullmoveNumber ≤ openingMoves` (3), a loss ≥ threshold is not a mistake if the player's eval after the move is ≥ −openingFloor (20) as White or ≥ −(openingFloor + 30) as Black (`spec/fixtures/opening-choices.json`).
3. **Mistake:** analyse only if `best ≠ null`, `|evalBest| ≤ 300` and `played ≠ best`. Then `loss = max(0, evalBest − (−evalAfter))`, and it is a mistake if `loss ≥ threshold`. The **first** mistake ends the game.
4. **Mate** = ±10000 cp, and the normal rules then apply.
5. **Aggregation:** per key, `errors`; `reached = max(reached[key], errors)`; `avg_loss` uses each loss **capped at 500**; `raw_avg_loss` is uncapped; `score = errors × avg_loss`; sort by `(−score, −errors, key)`; at most 5 game URLs in game order (most recent first); `/black` suffix and `#ply`.
6. **Accept window** from one MultiPV-5 search: moves with `bestCp − cp < threshold` (strict), minus the player's recorded mistake moves; same fallback chain as `aggregate.py`. `best` must be in `acceptable`.
7. **Tie-breaks** follow `Counter.most_common`: count descending, then first-inserted. This applies to `played` and to the chosen opening.
8. **Rounding:** Python `round(x, 1)` is round-half-even on the binary float. The JS port uses one helper, `round1`, whose output is asserted against Python-generated golden values. Plain `Math.round(x*10)/10` is not used.
9. **Defaults:** perf `blitz,rapid,classical`, max moves 12 (15 until 2026-10-10), book moves 10, opening moves 3, opening floor 20, threshold 20.

## 7. Engine worker protocol

Each worker owns one engine instance with `Hash 16` and `Threads 1` and handles one job at a time: `{id, fen, depth, multipv}` → `{id, lines:[[uci, cp]…], engine:"Stockfish 19 Lite WASM"}`. It sends `setoption MultiPV` only when the value changes. **Pause** sends `stop` to busy workers and discards their answers; the jobs are re-queued on resume. **Terminate** happens when the run finishes or the tab is hidden for a long time on mobile.

The coordinator keeps an **in-flight map** `cacheKey → Promise`. Many games share opening positions, so two games reaching the same position wait for one search. This is the browser equivalent of the SQLite cache hit.

## 8. Performance budget and chunking

Real numbers from the CLI cache: 500 games at depth 14 needed **about 4.2 single-PV evals per game** (2,122 distinct) and **0.8 MultiPV-5 searches per game** (400). Scans are short because the first mistake ends them, and openings repeat.

Worker-time per game ≈ 4.2 × 100 ms + 0.8 × 700 ms ≈ **1.0 s at depth 14**. At depth 18 it is about 4.2 × 660 ms + 0.8 × ~4 s ≈ **6 s**; the MultiPV figure at 18 is extrapolated, not measured.

| Device (assumed) | Workers | 500 games @ d14 | 500 games @ d18 |
|---|---|---|---|
| Desktop or laptop | 4 | **~2 min** | ~13 min |
| Phone, **measured** (see below) | 2 | **~1.5–2 h** | many hours; not offered |

**Phone measurement (2026-10-08).** Angelo's phone on home Wi-Fi with `spike/engine.html`, benchmark of 20 positions at depth 14, MultiPV 1, 2 workers: **25.8 s, 0.78 positions/s**, so about 2.6 s per search per worker. The desktop runs 94 ms per search (§3.2), so this phone is **about 27× slower per engine**, far beyond the 3–5× assumed earlier. The phone model was not recorded; thermal throttling, a power-saving mode or effectively one usable core may contribute. Per game that is 4.2 × 2.6 s + 0.8 × ~18 s ≈ 25 s of worker time, about 12 s wall-clock with 2 workers. **500 games take roughly 1.5–2 h on this phone.**

**Consequences for the design:**

1. **Mobile defaults:** depth **12** and the **150 most recent games**, about 2× cheaper per search than depth 14. That's an estimated 10–15 min, and the ETA comes from a 5-position calibration run on the device before starting (slice 7), never from a fixed table.
2. **Lazy MultiPV on mobile.** Run the expensive MultiPV-5 search only for the top 30 positions by score, and the rest when a position is first opened in the trainer. MultiPV is roughly 60 % of the per-game cost on the phone. Desktop keeps eager MultiPV (§8 chunking).
3. **"Analyse on the computer, train on the phone" is the primary mobile story.** A friend runs the analysis in a desktop browser (or the CLI) and moves the positions document to the phone with the export/import of slice 8 (a file or a QR/link with a compressed document). Phone-only analysis stays possible with the reduced defaults.
4. **Re-measure** on 2–3 more phones (one iPhone, one mid-range Android) when the release candidate is deployed, and record the model next time.

**Defaults:** **depth 14 and the 500 most recent games**. Download takes about 25 s and analysis a few minutes on a laptop. That is short enough that a friend sees results in one sitting. Depth 14 is also what the current `positions.json` was generated with. "Thorough (18)" and up to 2,000 games are opt-in, with the ETA shown before starting. The other defaults (perfs, 15 moves, 20 cp) stay as in the CLI.

**Chunking and resume:**

- Unit of work = one game. The coordinator keeps `2 × N` games in flight and pulls the next game id from `games` (most recent first) that has no `results` row for the current `runKey`.
- Every engine answer is written to `evals` immediately, in batched transactions about every 250 ms. Every finished game writes its `results` row. Nothing is ever recomputed after a pause, crash or reload.
- **MultiPV is eager.** As soon as a game yields a mistake, the MultiPV-5 search for that key is queued. Every mistake key ends up in the output anyway (`aggregate` runs MultiPV for every bucket), so this costs nothing extra. It also lets **aggregation be a cheap pure function** over `results` plus cached MultiPV rows.
- **Checkpoint** every 25 games or 10 s: aggregate, write `positions[userId]`, and refresh the trainer list. The user can train on partial results.
- Re-visit: new games are fetched, and only games without a `results` row are analysed. A changed depth or threshold yields a new `runKey`, and cached evals still apply wherever depth matches.

## 9. Tech choices

**Plain ES modules plus JSDoc types, checked by `tsc --noEmit --checkJs` in CI, with no bundler.** This is recommended over Vite+TypeScript because:

- The existing spec forbids a build step for the page, and the trainer already works that way.
- GitHub Pages can publish `web/` as is, and `uv run trainer serve` keeps working on the same folder.
- The pure-logic modules are small, so JSDoc gives enough type safety.
- Vite's real benefits (HMR, bundling, hashing) matter little for about 10 modules plus vendored files.

Revisit this only if the UI grows into a component framework.

**Testing:**

- **vitest** (dev-only `package.json`) on `core/*`, `engine/uci.js` and `store/db.js` (with `fake-indexeddb`). The coordinator is tested with a fake pool.
- **Shared fixtures:** `spec/fixtures/*.json` each hold `{games, user, fakeEngine: {fenKey: [best, cp]}, topMoves: {fenKey: [[uci,cp]…]}, settings, expected: {results, positions}}`. Pytest gains one parametrised test that feeds every fixture through `analyse_game` and `aggregate` with the existing `FakeEngine`. Vitest does the same through the JS port. **Both compare against the same `expected`.** The current pytest matrix scenarios (mistake found, best move played, decided position, mate, short game, repeated position, colour and URL) become the first fixtures. A small `tools/make_fixture.py` can regenerate `expected` from the Python implementation, which stays the reference.
- One **Playwright smoke test** (optional): the page loads, the engine worker answers `uciok`, and a fixture-backed fake Lichess route runs to a trained position.

**Deployment:** a GitHub Actions workflow (`actions/upload-pages-artifact` plus `actions/deploy-pages`) publishes `web/` minus `positions.json`. **No COOP/COEP is needed** because the engines are single-threaded. The vendored engine (about 1.8 MB) is cached by the browser after the first visit. The page footer links to the source, the license, and the upstream Stockfish and stockfish.js tags, which covers the GPL source offer.

## 10. Relationship to the existing Python CLI

**Recommendation: keep both, with Python as the reference implementation.**

- **CLI:** for power users and huge histories (20k games, full net, depth 18+, all cores natively). It stays the reference for the rules.
- **Web app:** for friends. It shares the trainer UI, the positions document shape and the fixtures.
- The web app gets **"Load analysis file"** (a `positions.json` from the CLI) for free, since the shape is identical. When served by `trainer serve` it can still pick up `web/positions.json` automatically.
- A change to a rule must update the fixtures, and both test suites then fail until both ports agree. That is the single mechanism that keeps them aligned.

## 11. Risks and open questions

| Risk | Status | Mitigation |
|---|---|---|
| Lichess rejects browser requests (UA or CORS) | Chromium (Edge 141) real-page run: OK (verified, slice 1); Firefox/Safari: **unverified**; `HeadlessChrome` UA is blocked | Story 1 is a throwaway page that streams 50 games from GitHub Pages in Chrome, Firefox and iOS Safari before anything else is built |
| 429 without CORS headers (unreadable status) | **unverified** | Strictly one request at a time; on 429 or opaque `TypeError`, keep stored games, show "Lichess asked us to slow down", auto-retry after 60 s, once |
| Lichess ToS / API etiquette | Anonymous public export is the documented use; no scraping | Throttle to one request; never refetch stored games; `evals=false`; link back to Lichess for each game |
| Browser speed lower than estimated | Desktop measured in Node; phones not measured | Depth 14 default; ETA shown before start; progressive training; worker count adapts to measured ms per search after the first 20 jobs |
| Mobile: background tabs frozen, memory, heat | expected on iOS (unverified) | Resume is free (§8); request Screen Wake Lock during analysis where available; 2 workers on mobile; Hash 16 MB per worker |
| Lite net evals differ from the CLI's full net | by design | `engineId` in every cache key and in `settings.engine`; parity is on rules, not numbers |
| chess.js FEN en-passant field differs from python-chess | **unverified** | first fixture of Story 2; normalise in `fenKey` if needed |
| GPL obligations | repo already GPL-3.0-or-later | ship `Copying.txt`, link exact upstream source tags, keep the site source public |
| Storage eviction (Safari 7-day rule, best-effort) | documented by MDN | `navigator.storage.persist()`; export/import backup; worst case is re-analysis |
| Someone wants multithreaded search later | not needed now | coi-serviceworker on Pages, or move hosting to Cloudflare Pages/Netlify with `_headers`; switch to `stockfish-19-lite.js` |

**Decision (2026-10-08): browser and CLI may flag different borderline mistakes.** Slice 5 compared both on the same 100 games (depth 12, threshold 20 cp): the first mistake agreed in 46/100 games, mistake keys 43 shared (browser 92, CLI 75), and top-10 overlap was 2/10. The browser code is exact: Python run on the browser's own evals reproduces its document byte for byte. The gap comes from the lite network versus the full one; every disagreement had a loss within 30 cp of the threshold. **Accepted as is.** Both find real inaccuracies, and a 20 cp threshold is close to engine noise for any engine. Revisit only if users report the training set feels arbitrary; the measurements and options are in the slice 5 notes (raise the browser default to 30–40 cp, or the full net).

## 12. Suggested implementation slices

Each slice ends in something demoable on the deployed Pages URL.

**Epic A: Foundations**

1. *Lichess spike.* A Pages-hosted page with a name field. It checks the user and streams 50 games into a list, live, in three browsers. **Demo:** CORS and UA proven from a real origin.
2. *Pure core plus shared fixtures.* `core/fen.js`, `core/analyse.js` and `core/aggregate.js` with JSDoc; `spec/fixtures/` from the pytest matrix; parametrised pytest and vitest both green. **Demo:** `uv run pytest` and `npx vitest` pass on the same fixtures.
3. *Engine worker.* Vendored lite-single build, `engine/uci.js`, and a pool. A debug page analyses a pasted FEN at depth 14 with MultiPV 5. **Demo:** best move and timings shown on a phone and a laptop.

**Epic B: Pipeline**

4. *Storage and incremental fetch.* `store/db.js` and `fetch.worker.js` with the since/until cursor. A re-visit downloads only newer games. **Demo:** reload mid-download, then continue.
5. *Coordinator.* Queue, in-flight dedupe, eval cache, `results`, eager MultiPV and checkpoints. Pause and resume, plus a reload-resume. **Demo:** 100 games analysed across a reload with no repeated work (cache-hit counter).
6. *Aggregation into the trainer.* `trainer.js` takes the document from IndexedDB; the list updates during the run. **Demo:** a friend's name in, positions out, train while analysis continues.

**Epic C: Friend-ready**

7. *UX polish.* Settings panel with ETA, error messages for every row of §11, mobile layout, Wake Lock, adaptive worker count. **Demo:** a full run on an iPhone.
8. *Persistence safety.* `storage.persist()`, export/import backup, "Load CLI analysis file", per-user stats key. **Demo:** move training data between two browsers.
9. *Release.* Deploy to the chosen static host (GitHub Pages workflow, or Cloudflare Pages + Access while the repo is private; see §13), license and source footer, README section "Use it in the browser". **Demo:** URL shared with friends.

## 13. Hosting alternatives

GitHub Pages is the default only because the repo already lives on GitHub. **The architecture does not depend on it.** The app is a folder of static files (HTML, ES modules, about 1.8 MB of vendored engine, CSS). All work happens in the visitor's browser, and Lichess answers with `Access-Control-Allow-Origin: *`, so the site's origin doesn't matter (§3.1). Any host that serves static files can run it.

### 13.1 What a host must provide

| Requirement | Why | Notes |
|---|---|---|
| **HTTPS** | Web Workers, IndexedDB persistence (`storage.persist()`) and Wake Lock need a secure context | Every host below provides it; `http://127.0.0.1` also counts as secure for local use |
| Serve `.wasm` as `application/wasm` | `WebAssembly.instantiateStreaming` needs the right MIME type | The engine loader falls back to `arrayBuffer()` + `instantiate`, so a wrong type costs speed, not function |
| Files up to about 2 MB | Vendored `stockfish-19-lite-single.wasm` | Far below every host's per-file limit |
| No server-side code | Nothing to run | Static hosting tiers are enough |

**Nice to have:**
- **Custom response headers.** This is the one thing GitHub Pages lacks. They allow long cache lifetimes for the vendored engine and `COOP: same-origin` + `COEP: require-corp` if multithreaded search is ever wanted (§3.2). Where headers can be set, coi-serviceworker is unnecessary.
- **Access control.** It keeps the site to invited friends while the repo stays private.

### 13.2 What changes when the host changes

Only the deployment layer changes; **application code stays identical.**

- **Deploy step:** replace the Pages workflow (§9) with the host's Git integration or CLI upload of `web/` (minus `positions.json`).
- **Optional headers file in `web/`:** `_headers` on Cloudflare Pages and Netlify, `vercel.json` on Vercel, `staticwebapp.config.json` on Azure, a server block on nginx/Caddy. Example for Cloudflare/Netlify:
  ```
  /vendor/*
    Cache-Control: public, max-age=31536000, immutable
  # only if multithreading is enabled later:
  /*
    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp
  ```
- **Footer links:** point the source link at wherever the code is shared. The GPL source offer still applies, even with a private repo, once the built site is given to others (a tarball link or repo invitation covers it).
- **Story 1** (Lichess spike) runs on the chosen host instead of `*.github.io`. Because CORS is `*`, the result carries over to any origin.

### 13.3 Options compared

| Host | Private repo OK | Custom headers | Restrict to friends | Cost | Fit |
|---|---|---|---|---|---|
| **GitHub Pages** | Only on paid plans (Pro/Team/Enterprise); free accounts need a public repo | No | Only on Enterprise Cloud; on Pro the site is public to anyone with the link | Free (public repo) / GitHub Pro | Default when the repo goes public |
| **Cloudflare Pages** | Yes (Git integration or direct upload) | Yes, `_headers` (max 100 rules) | Yes, Cloudflare Access (Zero Trust free for up to 50 users; login by email code, Google, GitHub, …) | Free | **Recommended while the repo is private** |
| **Netlify** | Yes | Yes, `_headers` / `netlify.toml` | Dashboard password on Pro; free tier: Basic-Auth via `_headers` (password stored in the repo) | Free / Pro | Good alternative |
| **Vercel** | Yes | Yes, `vercel.json` | Password protection is a paid feature (*unverified in this pass*) | Free Hobby tier is for non-commercial use | Works; fewer reasons to prefer it here |
| **Azure Static Web Apps** | Yes | Yes, `staticwebapp.config.json` | Built-in auth and role rules (*unverified in this pass*) | Free tier | Fine if Azure is already in use |
| **Own server** (small VPS or a home Raspberry Pi with nginx/Caddy, optionally behind a Cloudflare Tunnel) | n/a | Full control | Basic Auth, or Cloudflare Access via the Tunnel | VPS a few EUR per month; Pi hardware only | Most control, most upkeep (OS updates, TLS) |

Plan details change; check the current pricing pages before committing to one. Free tiers of all hosts above are far beyond this app's traffic: a few friends, about 2 MB per first visit, cached afterwards.

### 13.4 Recommendation

- **While the repo is private and the audience is a few friends: Cloudflare Pages + Cloudflare Access.**
  - The repo stays private, hosting is free and custom headers are available.
  - Access limits the site to the friends' e-mail addresses without any code in the app.
  - Moving to GitHub Pages later is just the deploy step.
- **When the repo goes public:** GitHub Pages stays the simplest option (one workflow, no extra account). Cloudflare Pages remains equally valid.
- **Avoid paying GitHub only for Pages.** On Pro the site would still be public to anyone with the link, so it buys no privacy.

Slice 9 (*Release*, §12) therefore becomes "deploy to the chosen static host". Its acceptance criteria are host-neutral: HTTPS URL, engine loads, Lichess spike passes, footer with source and license.

## Sources

- Lichess CORS and UA behaviour: own curl tests, 2026-10-08 (§3.1)
- Lichess API tips (rate limits): <https://lichess.org/page/api-tips>
- Lichess export throttling: <https://github.com/lichess-org/api/blob/master/doc/specs/tags/games/api-games-user-username.yaml>
- stockfish.js builds and license: <https://github.com/nmrugg/stockfish.js>; file sizes from <https://unpkg.com/stockfish@19.0.0/?meta>; npm license metadata from <https://registry.npmjs.org/stockfish/latest>
- lichess-org/stockfish-web: <https://github.com/lichess-org/stockfish-web>; npm metadata <https://registry.npmjs.org/@lichess-org/stockfish-web/latest>
- GitHub Pages and COOP/COEP: <https://github.com/orgs/community/discussions/13309>
- coi-serviceworker: <https://github.com/gzuidhof/coi-serviceworker>
- Storage quotas and eviction: <https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria>
- Speed: own benchmark, 2026-10-08 (§3.2); anecdotal context: <https://lichess.org/blog/YDOKRxQAACgAREB3/stockfish-13-nnue-on-lichess>
- License metadata: chessground (GPL-3.0-or-later) and chess.js (BSD-2-Clause) from the npm registry
- GitHub Pages and private repositories (paid plans; site visibility): <https://github.com/orgs/community/discussions/22817>, <https://github.com/orgs/community/discussions/44593>
- Cloudflare Pages limits and headers: <https://developers.cloudflare.com/pages/platform/limits>, <https://developers.cloudflare.com/pages/configuration/headers/>
- Cloudflare Access / Zero Trust free tier (up to 50 users): <https://www.cloudflare.com/en-gb/sase/products/access/>
- Netlify headers and password protection: <https://docs.netlify.com/manage/routing/headers/>, <https://www.netlify.com/blog/restricting-access-to-netlify-sites-with-passwords>, <https://netlify.com/pricing/>
