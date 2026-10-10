# Design: "Why am I better?" — explaining a position advantage without extra material

Status: **slice 1 built** (2026-10-10), slices 2–5 open. Builds on `architecture-browser-trainer.md`.

Decisions (2026-10-10): the eval appears **only after** the position is solved or revealed; the threshold
for "Why am I better?" is **+0.8**. §10 records how slice 1 was built.

## 1. Request

A friend asks: when the trainer shows a position where I am clearly better (e.g. +1.0) but have no extra
pawn, explain **why**, visually and/or in words.

## 2. What the data says (probe on the CLI analysis, 2026-10-10)

`web/positions.json` (400 positions, depth 14) plus native Stockfish 19 at depth 18:

- **89 of 400 positions (22 %)** are ≥ +0.8 for the player with equal material (also after the hanging
  captures are played out, `book.settled_material`). The request covers a large part of the trainer.
- **The engine's line rarely explains it on its own.** In 3 of 4 sampled positions the 12-ply PV wins no
  material at all; the advantage stays positional.
- **Most of these advantages are dynamic.** The "pass" test (the player skips his move; the engine evaluates
  the opponent to move):

  | Position (player to move) | Eval | Eval if he passes | Best move |
  |---|---|---|---|
  | A40 1. d4 b6 (White) | +0.89 | −0.05 | 2. e4: the full centre |
  | D30 QGD …c6, …Bd6 (White) | +1.39 | +0.25 | 5. e4 |
  | D02 Baltic, Pseudo-Slav (White) | +1.32 | +0.05 | 4. Qb3: b7 and the d5 pressure |
  | D70 Neo-Grünfeld (White) | +1.07 | +0.41 | 6. h3: takes g4 from the bishop |

  So the honest answer to "why am I better?" is usually **"because of what your next move does"** (centre,
  tempo, a target), not something already on the board. An explanation that only lists static features
  ("better mobility") would mostly miss the point.

## 3. Goals and non-goals

**Goals**
- In the trainer, after the position is solved or revealed, a **"Why?"** panel for positions where the player
  is ≥ +0.8 (setting) with no extra settled material. Optionally also for any position.
- A one-line **verdict** that is always right because it comes from the engine (static vs dynamic advantage).
- The **engine's plan** as a playable line with arrows, noting where (if anywhere) material changes.
- Up to **3 reasons** in plain words, each with board highlights, chosen from a fixed catalogue of
  recognisable chess concepts (centre, development, king safety, pawn weaknesses, piece activity, threats).
- Runs entirely in the browser, offline, on the existing engine pool. No server, no account, works for the
  CLI's `positions.json` too (the trainer page is the same).

**Non-goals**
- A true causal decomposition of the engine eval. NNUE does not offer one (see §7.4); the reasons are
  **heuristic and labelled as such** ("likely reasons").
- An LLM / chat explanation. It would need a server or API key, costs money, sends positions away and
  sounds confident when wrong. It can be revisited later on top of the same facts (§9).
- Explaining positions the player is worse in (could reuse the same machinery later, mirrored).

## 4. The explanation in three layers

Each layer is useful alone; together they give "what", "how" and "why".

### 4.1 Verdict (engine facts, always shown)

Inputs: eval of the position `E` (the MultiPV search the trainer already has), settled material `M`,
eval if the player passes `P` (one extra search, §5).

| Condition | Sentence (White example) |
|---|---|
| `M ≥ 1` | "You are a pawn up (after the captures on the board)." — the feature is not for this case, short text only |
| `P ≥ 0.6·E` | "**Your position itself is better** (+1.0): even if it were Black's move, you would keep +0.7. See the reasons below." |
| `P < 0.6·E` | "**Your advantage is in your next move** (+1.0 now, about +0.2 if you did nothing). The engine's plan shows what it achieves." |
| PV wins material within the line | adds: "With best play you win a pawn after 4 moves (move 7)." |

### 4.2 The engine's plan (visual)

- Keep the PV that `engine/uci.js` already parses (today `pool.js` returns only `[uci, cp]`).
- A stepper under the board: **◀ ▶** through the first 6–8 plies, with numbered arrows on chessground
  (`setAutoShapes`) and the settled material after each ply. The ply where material changes is marked.
- Shown only after the position is solved or revealed: the first PV move is the quiz answer.

### 4.3 Reasons (heuristic features, words + highlights)

A pure module `core/features.js` (chess.js only, unit-testable like `core/analyse.js`) measures each
concept for both sides in the **quiz position** and, for dynamic advantages, also **after the best move and
the opponent's best reply** (PV ply 2). The explanation ranks the **differences**: what the player has and
the opponent does not, or what the best move gains.

Catalogue (weights are rough centipawns, only for ranking; tuned in slice 3):

| Concept | Measurement (chess.js `moves`, `attackers`, `isAttacked`, board scan) | Sentence | Highlight |
|---|---|---|---|
| Centre | own pawns on d4/e4/d5/e5, control of the four centre squares | "You can occupy the centre with e4 and d4; Black has no centre pawn." | circles d4 e4 d5 e5 |
| Development | minor pieces off the back rank, castled, rooks connected | "You have 3 pieces out, Black 1." | circles on developed pieces |
| King safety | not castled with the centre file open or half-open; missing shield pawns; enemy attacks on the king zone | "Black's king is stuck in the centre and the e-file is opening." | king zone in red |
| Pawn weaknesses | isolated, doubled, backward pawns; a pawn attacked more often than defended | "Black's d5 pawn is attacked twice and defended once." | red circle, attacker arrows |
| Piece activity | legal-move count (opponent's by a null move), knight outposts, rooks on open files, bishop pair | "Your pieces have 38 moves, Black's 24." | green circles |
| Targets / threats | engine move for the player if the opponent passes (`null-move threat`), hanging pieces | "You threaten Qxb7: the b7 pawn has no defender." | arrow |
| Space | own-controlled squares in the opponent's half | "You control 9 squares in Black's half, Black 3 in yours." | light shading |

Rules that keep it honest:
- Report a concept only if the difference passes its threshold **and** points the same way as the eval.
- At most 3 reasons, strongest first; if none passes, say so: "No simple reason found: the engine sees it
  deeper than these checks. Follow its plan."
- Wording says "likely reasons"; numbers are shown ("3 pieces out vs 1") so the friend can check them.

## 5. Engine work per explanation (on demand, cached)

| Search | Already there? | Use |
|---|---|---|
| MultiPV-5 of the quiz position | yes (accept window) | `E`, best move; now also the **PV** |
| Opponent to move, same position (null move) | new, 1 search | `P` (verdict), the player's threat if the opponent passes |
| Position after PV ply 2 | new, optional | features "after the plan" |

- **Null move FEN:** flip the side to move, clear the en-passant field; skipped when the player is in check
  (then the verdict falls back to the plan).
- **PV in the cache:** today `evals` rows hold `lines: [[uci, cp], …]`. Store `[uci, cp, pv]` with `pv` an
  optional third element: old rows still read; an explanation that finds no `pv` searches again once. No
  schema version bump. Same in `evals.sqlite`? Not needed: the CLI does not explain.
- **Cost:** 1–2 extra searches at the run depth, about 0.5–2 s on a phone, only when "Why?" is opened, in the
  existing pool (like the lazy alternatives check, `analysis/alternatives.js`).

## 6. UI

- Info panel line, always: "Engine: **+1.0** for you · material equal" (needs the eval: from the MultiPV
  search, so it appears with the accept window).
- Button **"Why am I better?"** after solved/revealed, for positions over the threshold (Settings: on/off,
  threshold 0.8).
- Panel: verdict sentence, "The engine's plan" stepper, "Likely reasons" list. Tapping a reason shows its
  highlights; tapping the stepper shows the plan arrows; one set of shapes at a time (phones are small).
- Optional **hint mode** (later): before answering, show one static reason without the plan ("Look at the
  centre"), since reasons do not give the move away.

## 7. Implementation outline

### 7.1 Modules

- `web/core/material.js`: JS port of `book.py` `settled_material` (capture-only search). Shared fixture with
  Python, so the two stay equal.
- `web/core/features.js`: the catalogue in §4.3, pure functions `features(fen) -> {white, black}` and
  `reasons(before, after, color, eval) -> [{id, text, shapes}]`.
- `web/core/explain.js`: combines engine facts and features into `{verdict, plan, reasons}`; pure, the engine
  is injected (like `core/analyse.js`).
- `web/analysis/explainer.js`: on-demand searches through the running or idle coordinator (same routing as
  `alternativesFor` in `app.js`), with caching.
- `web/trainer.js`: the panel, the stepper and the shapes.

### 7.2 Data

Nothing new in `positions.json`. Explanations are computed from the stored FEN and the engine cache;
optionally an in-memory cache per page view. Backups and "Send to phone" do not change.

### 7.3 Tests

- `tests-js/features.test.js`: hand-built FENs per concept (isolated pawn, king in the centre with open
  e-file, outpost, …) → expected measurements and sentences.
- Shared fixture for `settled_material` (Python vs JS).
- `explain.test.js` with a fake engine: verdict thresholds, PV material marking, "no simple reason".
- **Quality check on real positions:** the 89 positions from §2 with their explanations printed into a
  review page; the friend marks each as helpful or not. Goal for release: helpful in ≥ 2 of 3.

### 7.4 Experiment: per-piece heat map (optional, slice 5)

Stockfish 19's `eval` prints only a material/positional split per NNUE bucket (checked on the native
engine: no per-piece board any more). A heat map would need ~30 static evals of the position with one piece
removed each (value of the piece = eval drop minus its material value). Cheap (no search), but it has to be
verified on the Lite WASM net and is hard to explain ("your knight is worth 1.4 here"). Only if slices 1–4
leave the friend wanting more.

## 8. Slices

| # | Slice | Delivers | Size |
|---|---|---|---|
| 1 | Eval line + verdict | keep PV, null-move search, settled material in JS, "Engine: +1.0 · material equal", verdict sentence | S |
| 2 | Engine plan stepper | PV arrows, material marks, after-solve only | S |
| 3 | Reasons | `features.js` catalogue, ranking, sentences, highlights; tuned on the 89 positions | M–L |
| 4 | Review with the friend | review page of the 89 explanations, fix wording and thresholds | S |
| 5 | (optional) heat map spike | §7.4 | S, may be dropped |

Slices 1–2 already answer the request in part: the verdict tells *what kind* of advantage it is, and the
plan shows *how* it is used. Slice 3 adds *why* in concepts.

## 9. Risks and open questions

(The first two open questions below were decided on 2026-10-10: eval after the answer, threshold +0.8.)

- **Heuristic reasons can be wrong or trivial.** Mitigation: engine-backed verdict first, thresholds, "no
  simple reason" fallback, the review in slice 4.
- **Engine depth on phones** (depth 12) can make `P` noisy for small advantages; the verdict uses a ratio and
  is only shown from +0.8.
- **Opening positions are mostly dynamic** (§2), so the "after the plan" comparison carries most of the
  value. If it does not work well, the plan stepper still explains by showing.
- Open: show the eval number at all before the answer? (It hints that something is to be found.) Proposal:
  only after solved/revealed.
- Open: the threshold (+0.8) and whether to offer "Why?" for every position.
- Later: an optional LLM layer could turn the same facts (verdict, plan, measured reasons) into prose; it
  would only phrase, never decide, and would need the friend's own API key.

## 10. Slice 1 as built (2026-10-10)

- **PV:** `engine/uci.js` `SearchCollector.pvs()`, the worker posts `pvs` next to `lines`, and `pool.analyse`
  resolves `{lines, pvs, nodes, timeMs}`. Different from §5: the PV is **not** written to the eval cache.
  `analysis/explainer.js` runs its own single-PV search (with PV) and the pass search, and remembers both for
  the page view. The cache, `positions.json`, backups and the runKey are unchanged. Cost: one search when an
  answer is shown, one more when "Why?" is opened (about 0.5 s each at depth 14 on a laptop).
- **Material:** `core/material.js` `settledMaterial`, the same capture-only search as `book.py`. It uses
  chess.js's internal move generator, because the public `moves({verbose: true})` writes SAN for every move
  and was 40 times slower (12 ms per position against 0.3 ms). `spec/golden/settled-material.json` (905
  positions from the opening lines, written by `tools/make_fixture.py`) is checked by pytest and vitest.
- **Verdict:** `core/explain.js`: `engineLine`, `offersWhy` (≥ 80 cp, no mate, settled material ≤ 0),
  `passFen` (null in check), `planGain` (the first ply of the 12-ply PV from which the player stays at least
  a pawn up; a gain that shows after the opponent's reply counts at the player's next move) and `verdict`.
  The sentences: material up, mate, in check, static (`P ≥ 0.6·E`) and dynamic ("Your advantage is in your
  next move, e4 (+0.9 now, about −0.1 if you did nothing)"), plus "With best play you win a pawn within 2
  moves (by move 5)."
- **UI:** a box under Retry/Reveal: the eval line, the button and the verdict. It is hidden on Next, Retry and
  when the list changes the position.
- **Checked** in headless Edge on the CLI analysis (Stockfish 19 Lite WASM, depth 14): 3 of 19 revealed
  positions offered "Why?"; all three verdicts were "in your next move" (D70 a4, D30 e4, D02 Qb3 with a pawn
  won by move 5), which matches the §2 probe.
