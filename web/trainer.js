// Opening trainer page: quizzes positions from positions.json on a chessground board.
import { Chessground } from 'https://cdn.jsdelivr.net/npm/chessground@9.2.1/dist/chessground.min.js';
import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js';

const STATS_KEY = 'opening-trainer:stats';
const $ = (id) => document.getElementById(id);

let positions = [];
let filtered = [];
let index = 0;
let chess = null;
let attempted = false; // whether the current position already got a scored attempt
const stats = loadStats();

const cg = Chessground($('board'), {
  movable: { free: false, showDests: true, events: { after: onMove } },
  draggable: { showGhost: true },
  highlight: { lastMove: true, check: true },
  animation: { duration: 150 },
});

// ---------- persistence (per browser, best effort) ----------

function loadStats() {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveStats() {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
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
  resetBoard(false);
  const usual = pos.played[0];
  const shapes = [arrow(pos.best, 'green')];
  if (usual && usual.uci !== pos.best) shapes.push(arrow(usual.uci, 'red'));
  cg.setAutoShapes(shapes);

  const others = pos.acceptable.filter((u) => u !== pos.best).map((u) => sanOf(pos.fen, u));
  const parts = [`Best: ${pos.best_san} (green).`];
  if (others.length) parts.push(`Also fine: ${others.join(', ')}.`);
  if (usual) parts.push(`You usually played ${usual.san} (red, ${usual.count}×).`);
  showFeedback('', 'Answer', parts.join(' '));
  setActions({ retry: true, reveal: false, nextPrimary: true });
  renderList();
}

function retry() {
  if (!filtered[index]) return;
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

function describe(pos) {
  return `${pos.errors}/${pos.reached} games wrong · avg −${Math.round(pos.avg_loss)} cp`;
}

function renderList() {
  const list = $('position-list');
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
  $('pos-title').textContent = 'No positions match the filters';
  $('pos-meta').textContent = '';
  $('prompt').textContent = '';
  $('counter').textContent = '0 / 0';
  showFeedback('', '', '');
  $('games').replaceChildren();
  setNavEnabled(false);
  renderList();
}

function show(i) {
  if (!filtered.length) {
    showEmpty();
    return;
  }
  setNavEnabled(true);
  index = (i + filtered.length) % filtered.length;
  attempted = false;
  const pos = filtered[index];

  resetBoard(true);
  $('pos-title').textContent = `${pos.eco} ${pos.opening}`;
  $('pos-meta').textContent = `You play ${pos.orientation} · ${describe(pos)} · score ${pos.score}`;
  $('prompt').textContent = `Find the best move for ${turnColor(chess)}.`;
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

  showFeedback('', '', '');
  setActions({ retry: false, reveal: true, nextPrimary: false });
  renderList();
}

function applyFilters() {
  const opening = $('filter-opening').value;
  const color = $('filter-color').value;
  const unsolved = $('filter-unsolved').checked;
  filtered = positions.filter(
    (p) => (!opening || p.opening === opening) && (!color || p.orientation === color) && (!unsolved || !isSolved(p)),
  );
  show(0);
}

function fillOpeningFilter() {
  const counts = new Map();
  for (const p of positions) counts.set(p.opening, (counts.get(p.opening) || 0) + 1);
  const select = $('filter-opening');
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([name, n]) => select.add(new Option(`${name} (${n})`, name)));
}

// ---------- startup ----------

async function init() {
  try {
    const resp = await fetch('positions.json', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    positions = (await resp.json()).positions || [];
  } catch (err) {
    $('summary').textContent = `Could not load positions.json (${err.message}). Run \`uv run trainer update\` first.`;
    return;
  }

  fillOpeningFilter();
  for (const id of ['filter-opening', 'filter-color', 'filter-unsolved']) $(id).addEventListener('change', applyFilters);
  $('prev').addEventListener('click', () => show(index - 1));
  $('next').addEventListener('click', () => show(index + 1));
  $('retry').addEventListener('click', retry);
  $('reveal').addEventListener('click', reveal);
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
    if (e.key === 'ArrowLeft') show(index - 1);
    if (e.key === 'ArrowRight') show(index + 1);
  });
  applyFilters();
}

init();
