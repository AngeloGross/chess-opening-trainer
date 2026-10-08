// Shared positions documents for the slice 8 tests (backup, transfer, backupStore): real opening
// positions in the exact positions.json shape.

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** @param {string} fen @param {object} extra */
function entry(fen, extra) {
  const side = fen.split(' ')[1];
  return {
    key: fen.split(' ').slice(0, 4).join(' '),
    fen,
    orientation: side === 'w' ? 'white' : 'black',
    errors: 3, reached: 5, avg_loss: 41.3, raw_avg_loss: 41.3, score: 123.9,
    eco: 'B00', opening: 'Some Opening',
    games: ['https://lichess.org/abcdEFGH#5', 'https://lichess.org/ijklMNOP/black#6'],
    ...extra,
  };
}

export const POSITIONS = [
  entry('rnbqkbnr/ppp1pppp/3p4/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2', {
    errors: 18, reached: 18, avg_loss: 21, raw_avg_loss: 21, score: 378,
    best: 'g1f3', best_san: 'Nf3', acceptable: ['g1f3', 'e2e4', 'b1c3'],
    played: [{ uci: 'c2c4', san: 'c4', count: 18 }], eco: 'A40', opening: "Queen's Pawn Game: Anglo-Slav Opening",
    games: ['https://lichess.org/eNMKCp4m#2'],
  }),
  entry('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2', {
    best: 'g1f3', best_san: 'Nf3', acceptable: ['b1c3', 'g1f3'],
    played: [{ uci: 'd1h5', san: 'Qh5', count: 2 }, { uci: 'f1c4', san: 'Bc4', count: 1 }],
    raw_avg_loss: 612.5, avg_loss: 300, score: 900,
  }),
  entry('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', {
    best: 'c7c5', best_san: 'c5', acceptable: ['c7c5', 'e7e5'],
    played: [{ uci: 'g7g5', san: 'g5', count: 3 }], eco: null, opening: 'Unknown', games: [],
  }),
  entry('4k3/1P6/8/8/8/8/8/4K3 w - - 0 60', {
    best: 'b7b8q', best_san: 'b8=Q+', acceptable: ['b7b8q'], played: [{ uci: 'b7b8n', san: 'b8=N', count: 1 }],
    eco: 'A40', opening: "Queen's Pawn Game: Anglo-Slav Opening",
  }),
];

export function makeDoc(user = 'AngelOgro', positions = POSITIONS, generated = '2026-10-08T09:33:44+00:00') {
  return {
    generated, user, games: 500, clean_games: 120,
    settings: { perf: ['blitz', 'rapid', 'classical'], max_moves: 15, threshold: 20, depth: 14 },
    positions: structuredClone(positions),
  };
}

export const STATS = {
  [POSITIONS[0].key]: { tries: 3, solved: 2, failed: 1, last: 'solved' },
  [POSITIONS[2].key]: { tries: 1, solved: 0, failed: 1, last: 'failed' },
};

export { START };

export function memoryStorage(init = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}
