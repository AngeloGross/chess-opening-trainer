// Opening trainer view: quizzes the positions of a positions document on a chessground board.
// The app (app.js) mounts it with a document from the CLI's positions.json or from the browser
// analysis, and calls `update(doc)` at every analysis checkpoint (design §5, slice 6).
//
// Lazy MultiPV on open (slice 7): an entry marked `unchecked` has no accept window yet. Showing it asks
// `opts.alternatives(entry)` for the full entry ("Checking alternatives…"). Until the answer arrives only the
// engine's best move is accepted at once; any other move waits for the answer and is then judged against the
// full window, so a move that turns out fine is never scored as a miss. One scored attempt per visit still holds.
import { Chessground } from './vendor/chessground@9.2.1/dist/chessground.min.js';
import { Chess } from './vendor/chess.js@1.4.0/dist/esm/chess.js';
import { filterPositions, loadStats, mergeList, openingCounts, statsKeyFor } from './core/trainerList.js';

// ---------- chess helpers ----------

const turnColor = (game) => (game.turn() === 'w' ? 'white' : 'black');

function legalDests(game) {
  const dests = new Map();
  for (const m of game.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return dests;
}

const uciParts = (uci) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

function sanOf(fen, uci) {
  try {
    return new Chess(fen).move(uciParts(uci)).san;
  } catch {
    return uci;
  }
}

const arrow = (uci, brush) => ({ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush });

function lichessAnalysisUrl(pos) {
  return `https://lichess.org/analysis/${pos.fen.replaceAll(' ', '_')}?color=${pos.orientation}`;
}

function describe(pos) {
  return `${pos.errors}/${pos.reached} games wrong · avg −${Math.round(pos.avg_loss)} cp`;
}

/**
 * Show `doc` in `root` (the element holding the trainer markup of index.html).
 * @param {HTMLElement} root
 * @param {{user?: string, positions: object[]}} doc
 * @param {{migrateLegacyStats?: boolean, storage?: Storage, alternatives?: ((entry: object) => Promise<object>)|null}} [opts]
 *   migrateLegacyStats: a CLI document; stats of the old single-user page move to this user's key once
 *   alternatives: completes an `unchecked` entry (analysis/alternatives.js); without it the entry keeps its window
 * @returns {{update: (doc: object) => void, destroy: () => void, readonly cg: any, readonly current: object|null}}
 */
export function mountTrainer(root, doc, { migrateLegacyStats = false, storage = globalThis.localStorage, alternatives = null } = {}) {
  const $ = (id) => root.querySelector(`#${id}`);
  const listeners = new AbortController();
  const on = (target, type, fn) => target.addEventListener(type, fn, { signal: listeners.signal });

  const statsKey = statsKeyFor(doc.user);
  const stats = loadStats(storage, doc.user, { migrateLegacy: migrateLegacyStats });
  /** @type {Map<string, object>} key -> completed entry (lazy MultiPV), laid over every later document */
  const checked = new Map();
  /** @type {Map<string, Promise<void>>} key -> running alternatives check */
  const checking = new Map();
  let positions = overlay(doc.positions || []);
  let filtered = [];
  let index = 0;
  let chess = null;
  let attempted = false; // whether the current position already got a scored attempt
  let revealed = false; // the answer is on screen for the current position
  /** @type {{key: string, uci: string, san: string}|null} a move waiting for the alternatives check */
  let held = null;
  let destroyed = false;

  const cg = Chessground($('board'), {
    movable: { free: false, showDests: true, events: { after: onMove } },
    draggable: { showGhost: true },
    highlight: { lastMove: true, check: true },
    animation: { duration: 150 },
  });

  // ---------- persistence (per browser and user, best effort) ----------

  function saveStats() {
    try {
      storage.setItem(statsKey, JSON.stringify(stats));
    } catch {
      // Storage blocked (private mode etc.): stats just last for this page view.
    }
  }

  // One scored result per visit of a position: the first move, or a reveal before any move.
  function record(key, solved) {
    if (attempted) return;
    attempted = true;
    const s = stats[key] || { tries: 0, solved: 0, failed: 0 };
    s.tries += 1;
    s[solved ? 'solved' : 'failed'] += 1;
    s.last = solved ? 'solved' : 'failed';
    stats[key] = s;
    saveStats();
  }

  // "Solved" means the latest scored attempt was right; never-tried and last-failed are unsolved.
  const isSolved = (pos) => stats[pos.key]?.last === 'solved';

  const filters = () => ({ opening: $('filter-opening').value, color: $('filter-color').value, unsolved: $('filter-unsolved').checked });

  // ---------- board / quiz ----------

  function resetBoard(movable) {
    const pos = filtered[index];
    chess = new Chess(pos.fen);
    const color = turnColor(chess);
    cg.set({
      fen: pos.fen,
      orientation: pos.orientation,
      turnColor: color,
      lastMove: undefined,
      check: chess.inCheck(),
      movable: { color: movable ? color : undefined, dests: movable ? legalDests(chess) : new Map() },
    });
    cg.setAutoShapes([]);
  }

  // Promotion piece for a pawn move: the one an accepted (or best) move with the same squares uses, else a queen.
  function promotionFor(pos, orig, dest) {
    const piece = chess.get(orig);
    if (piece?.type !== 'p' || (dest[1] !== '8' && dest[1] !== '1')) return undefined;
    const match = [pos.best, ...pos.acceptable].find((u) => u.length === 5 && u.startsWith(orig + dest));
    return match ? match[4] : 'q';
  }

  function onMove(orig, dest) {
    const pos = filtered[index];
    if (!pos || !chess) return;
    const move = chess.move({ from: orig, to: dest, promotion: promotionFor(pos, orig, dest) });
    const uci = move.from + move.to + (move.promotion || '');

    // Sync the board (handles promotion, castling and en passant) and lock it.
    cg.set({ fen: chess.fen(), turnColor: turnColor(chess), check: chess.inCheck(), movable: { color: undefined, dests: new Map() } });

    // Window not known yet: the best move is right at once, anything else waits for the check.
    if (pos.unchecked && checking.has(pos.key) && uci !== pos.best) {
      held = { key: pos.key, uci, san: move.san };
      showFeedback('', `You played ${move.san}`, 'Checking alternatives…');
      setActions({ retry: false, reveal: false, nextPrimary: false });
      return;
    }
    judge(pos, uci, move.san);
  }

  function judge(pos, uci, san) {
    held = null;
    const move = { san };
    const correct = pos.acceptable.includes(uci);
    record(pos.key, correct);
    if (correct) {
      cg.setAutoShapes([arrow(uci, 'green')]);
      const note = uci === pos.best ? 'That is the engine\'s best move.' : `Also good. Engine best: ${pos.best_san}.`;
      showFeedback('good', `Correct: ${move.san}`, note);
      setActions({ retry: false, reveal: false, nextPrimary: true });
    } else {
      showFeedback('bad', `Not quite: ${move.san}`, 'Try again or reveal the answer.');
      setActions({ retry: true, reveal: true, nextPrimary: false });
    }
    renderList();
  }

  function reveal() {
    const pos = filtered[index];
    if (!pos) return;
    record(pos.key, false); // revealing before solving counts as a miss
    held = null;
    revealed = true;
    resetBoard(false);
    renderAnswer(pos);
    setActions({ retry: true, reveal: false, nextPrimary: true });
    renderList();
  }

  function renderAnswer(pos) {
    const usual = pos.played[0];
    const shapes = [arrow(pos.best, 'green')];
    if (usual && usual.uci !== pos.best) shapes.push(arrow(usual.uci, 'red'));
    cg.setAutoShapes(shapes);

    const others = pos.acceptable.filter((u) => u !== pos.best).map((u) => sanOf(pos.fen, u));
    const parts = [`Best: ${pos.best_san} (green).`];
    if (others.length) parts.push(`Also fine: ${others.join(', ')}.`);
    if (usual) parts.push(`You usually played ${usual.san} (red, ${usual.count}×).`);
    if (pos.unchecked && checking.has(pos.key)) parts.push('Checking alternatives…');
    showFeedback('', 'Answer', parts.join(' '));
  }

  function retry() {
    if (!filtered[index]) return;
    held = null;
    revealed = false;
    resetBoard(true);
    showFeedback('', '', '');
    setActions({ retry: false, reveal: true, nextPrimary: false });
  }

  // ---------- rendering ----------

  function showFeedback(kind, title, detail) {
    const el = $('feedback');
    el.className = kind;
    el.textContent = title;
    if (detail) {
      const span = document.createElement('span');
      span.className = 'detail';
      span.textContent = detail;
      el.appendChild(span);
    }
  }

  function setActions({ retry, reveal, nextPrimary }) {
    $('retry').hidden = !retry;
    $('reveal').hidden = !reveal;
    $('next').classList.toggle('primary', nextPrimary);
  }

  function renderList() {
    const list = $('position-list');
    const scroll = list.scrollTop;
    list.replaceChildren(
      ...filtered.map((pos, i) => {
        const li = document.createElement('li');
        li.classList.toggle('current', i === index);
        li.classList.toggle('solved', isSolved(pos));
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = `${i + 1}. ${pos.eco} ${pos.opening} (${pos.orientation})`;
        const info = document.createElement('span');
        info.className = 'stats';
        info.textContent = describe(pos);
        li.append(name, info);
        li.addEventListener('click', () => show(i));
        return li;
      }),
    );
    list.scrollTop = scroll;
    list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });

    const solved = positions.filter(isSolved).length;
    $('summary').textContent = `${positions.length} positions · ${solved} solved`;
  }

  function setNavEnabled(enabled) {
    for (const id of ['prev', 'next', 'retry', 'reveal']) $(id).disabled = !enabled;
    const link = $('lichess-link');
    link.hidden = !enabled;
    if (!enabled) link.removeAttribute('href');
  }

  function showEmpty() {
    // Nothing to quiz: clear and lock the board so no move handler can run.
    chess = null;
    index = 0;
    cg.set({ fen: '8/8/8/8/8/8/8/8', lastMove: undefined, check: false, movable: { color: undefined, dests: new Map() } });
    cg.setAutoShapes([]);
    $('pos-title').textContent = positions.length ? 'No positions match the filters' : 'No positions yet';
    $('pos-meta').textContent = '';
    $('prompt').textContent = '';
    $('counter').textContent = '0 / 0';
    showFeedback('', '', '');
    $('games').replaceChildren();
    setNavEnabled(false);
    renderList();
  }

  // Title, meta line, links: everything about the current position except the board and the feedback.
  function renderInfo(pos) {
    $('pos-title').textContent = `${pos.eco} ${pos.opening}`;
    $('pos-meta').textContent = `You play ${pos.orientation} · ${describe(pos)} · score ${pos.score}`;
    $('prompt').textContent = `Find the best move for ${turnColor(new Chess(pos.fen))}.`;
    $('counter').textContent = `${index + 1} / ${filtered.length}`;
    $('lichess-link').href = lichessAnalysisUrl(pos);

    const games = $('games');
    games.replaceChildren(document.createTextNode('Games: '));
    pos.games.forEach((url, n) => {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `#${n + 1}`;
      games.appendChild(a);
    });
  }

  function show(i) {
    if (!filtered.length) {
      showEmpty();
      return;
    }
    setNavEnabled(true);
    index = (i + filtered.length) % filtered.length;
    attempted = false;
    revealed = false;
    held = null;
    resetBoard(true);
    renderInfo(filtered[index]);
    showFeedback('', '', '');
    setActions({ retry: false, reveal: true, nextPrimary: false });
    renderList();
    ensureChecked(filtered[index]);
  }

  // ---------- lazy MultiPV on open ----------

  function overlay(list) {
    return checked.size ? list.map((p) => (p.unchecked && checked.has(p.key) ? checked.get(p.key) : p)) : list;
  }

  function setCheckState(text) {
    const el = $('alt-status');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  /** Start the alternatives check of `pos` once (again after a failure, on the next visit). */
  function ensureChecked(pos) {
    if (!pos?.unchecked || !alternatives) {
      setCheckState('');
      return;
    }
    if (!checking.has(pos.key)) {
      const key = pos.key;
      const job = Promise.resolve()
        .then(() => alternatives(pos))
        .then((entry) => { checking.delete(key); completed(key, entry); }, (err) => { checking.delete(key); failed(key, err); });
      checking.set(key, job);
    }
    setCheckState('Checking alternatives… until then only the engine’s best move counts.');
  }

  function replaceEntry(entry) {
    positions = positions.map((p) => (p.key === entry.key ? entry : p));
    filtered = filtered.map((p) => (p.key === entry.key ? entry : p));
  }

  function completed(key, entry) {
    if (destroyed || !entry) return;
    checked.set(key, entry);
    replaceEntry(entry);
    const pos = filtered[index];
    if (pos?.key !== key) return;
    setCheckState('');
    renderInfo(pos);
    if (held?.key === key) judge(pos, held.uci, held.san); // the waiting move, against the full window
    else if (revealed) renderAnswer(pos);
  }

  function failed(key, err) {
    if (destroyed) return;
    console.warn('alternatives check failed', err);
    const pos = filtered[index];
    if (pos?.key !== key) return;
    setCheckState('Alternatives could not be checked now; only the engine’s best move counts. They are checked again on the next visit of this position.');
    if (held?.key === key) judge(pos, held.uci, held.san);
  }

  function applyFilters() {
    filtered = filterPositions(positions, filters(), isSolved);
    show(0);
  }

  // Refill the opening filter with the current counts, keeping the selection (also when its count is 0 now).
  function fillOpeningFilter() {
    const select = $('filter-opening');
    const selected = select.value;
    const counts = openingCounts(positions);
    select.replaceChildren(new Option('All openings', ''));
    counts.forEach(([name, n]) => select.add(new Option(`${name} (${n})`, name)));
    if (selected && !counts.some(([name]) => name === selected)) select.add(new Option(`${selected} (0)`, selected));
    select.value = selected;
  }

  /**
   * A newer document of the same user (an analysis checkpoint): the list grows and re-ranks, while the
   * current position, the filters and an attempt in progress stay as they are.
   * @param {{positions: object[]}} next
   */
  function update(next) {
    const wasEmpty = !filtered.length;
    positions = overlay(next.positions || []);
    fillOpeningFilter();
    const merged = mergeList({ positions, filters: filters(), isSolved, filtered, index: wasEmpty ? -1 : index });
    filtered = merged.filtered;
    if (wasEmpty) {
      show(0);
      return;
    }
    index = merged.index;
    renderInfo(filtered[index]); // the board and an attempt in progress stay untouched
    renderList();
    ensureChecked(filtered[index]);
  }

  // ---------- startup ----------

  // A new document starts unfiltered (the controls may still hold an earlier mount's choice).
  $('filter-opening').value = '';
  $('filter-color').value = '';
  $('filter-unsolved').checked = false;
  fillOpeningFilter();
  for (const id of ['filter-opening', 'filter-color', 'filter-unsolved']) on($(id), 'change', applyFilters);
  on($('prev'), 'click', () => show(index - 1));
  on($('next'), 'click', () => show(index + 1));
  on($('retry'), 'click', retry);
  on($('reveal'), 'click', reveal);
  on(document, 'keydown', (e) => {
    if (root.hidden) return;
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
    if (e.key === 'ArrowLeft') show(index - 1);
    if (e.key === 'ArrowRight') show(index + 1);
  });
  applyFilters();

  return {
    update,
    destroy() {
      destroyed = true;
      setCheckState('');
      listeners.abort();
      cg.destroy();
    },
    get cg() {
      return cg;
    },
    get current() {
      return filtered.length ? filtered[index] : null;
    },
  };
}
