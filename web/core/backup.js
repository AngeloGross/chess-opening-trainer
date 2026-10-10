// Backup file format and "Load analysis file" (design §3.3, slice 8): build, read, validate and merge.
// Pure: the IndexedDB side is store/db.js (`exportUserData`, `importUserData`), the UI is dataPanel.js.
//
// Backup format, version 1 (one user per file; JSON, UTF-8):
//   { format: "opening-trainer-backup", version: 1, kind: "small"|"full", exported: ISO date,
//     user: "AngelOgro",
//     positions: <positions document, exactly the CLI's positions.json shape> | null,
//     stats: { <position key>: {tries, solved, failed, last} },   localStorage `opening-trainer:stats:<userId>`
//     settings: { analysisOptions?: {maxGames, depth, maxMoves?} },
//     // kind "full" only:
//     fetchState: <store fetchState row of the user> | null,
//     games: [<store games rows of the user>], results: [<store results rows of the user>],
//     evals: [<store evals rows>] }      the engine cache, shared by all users of the browser
// Store rows keep their stored shape (keys included), so an import writes them back unchanged.
//
// "Load analysis file" also takes the CLI's positions.json as it is (anything with a `positions` array).
import { validateFen } from '../vendor/chess.js@1.4.0/dist/esm/chess.js';
import { userIdOf } from '../store/db.js';

export const BACKUP_FORMAT = 'opening-trainer-backup';
export const BACKUP_VERSION = 1;
/** Files larger than this are refused before reading (a full backup of 5,000 games is about 6 MB). */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
const NAME_PATTERN = /^[A-Za-z0-9_-]{2,30}$/;

/** Readable failure of reading or validating a file. The message is shown to the friend as it is. */
export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
  }
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isUci = (v) => typeof v === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(v);

/**
 * Check that `doc` is a positions document the trainer can show. Throws ImportError naming the first problem.
 * @param {any} doc
 * @param {string} [what]  how the message calls the document
 */
export function validatePositionsDoc(doc, what = 'The analysis') {
  if (!isObject(doc) || !Array.isArray(doc.positions)) throw new ImportError(`${what} has no list of positions.`);
  if (typeof doc.user !== 'string' || !NAME_PATTERN.test(doc.user)) {
    throw new ImportError(`${what} does not say whose games it is (no valid Lichess name in "user").`);
  }
  doc.positions.forEach((p, i) => {
    const bad = (field) => {
      throw new ImportError(`${what} is damaged: position ${i + 1} has an invalid "${field}".`);
    };
    if (!isObject(p)) bad('entry');
    if (typeof p.fen !== 'string' || !validateFen(p.fen).ok) bad('fen');
    if (typeof p.key !== 'string' || p.key !== p.fen.split(' ').slice(0, 4).join(' ')) bad('key');
    if (p.orientation !== 'white' && p.orientation !== 'black') bad('orientation');
    if (!Array.isArray(p.acceptable) || !p.acceptable.length || !p.acceptable.every(isUci)) bad('acceptable');
    if (!isUci(p.best) || !p.acceptable.includes(p.best)) bad('best');
    if (!Array.isArray(p.played) || !p.played.every((m) => isObject(m) && isUci(m.uci) && isNum(m.count))) bad('played');
    if (!Array.isArray(p.games) || !p.games.every((u) => typeof u === 'string')) bad('games');
    for (const f of ['errors', 'reached', 'avg_loss', 'score']) if (!isNum(p[f])) bad(f);
  });
}

/**
 * Keep only well-formed stats entries. Unknown shapes are dropped, never an error: stats are a nicety.
 * @param {any} stats @returns {Record<string, {tries: number, solved: number, failed: number, last: 'solved'|'failed'}>}
 */
export function cleanStats(stats) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!isObject(stats)) return out;
  for (const [key, s] of Object.entries(stats)) {
    if (!isObject(s) || !isNum(s.tries) || s.tries <= 0) continue;
    out[key] = { tries: s.tries | 0, solved: s.solved | 0, failed: s.failed | 0, last: s.last === 'solved' ? 'solved' : 'failed' };
  }
  return out;
}

/**
 * @param {{kind: 'small'|'full', user: string, positions: any, stats?: any, settings?: any,
 *   fetchState?: any, games?: any[], results?: any[], evals?: any[], exported?: Date}} p
 */
export function buildBackup({ kind, user, positions, stats = {}, settings = {}, fetchState = null, games = [], results = [], evals = [], exported = new Date() }) {
  const backup = {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, kind, exported: exported.toISOString(),
    user, positions: positions ?? null, stats: cleanStats(stats), settings: isObject(settings) ? settings : {},
  };
  if (kind === 'full') Object.assign(backup, { fetchState: fetchState ?? null, games, results, evals });
  return backup;
}

/** `opening-trainer-<userId>-<YYYY-MM-DD>.json` (local date). @param {string} user @param {Date} [date] */
export function backupFileName(user, date = new Date()) {
  const id = userIdOf(user || 'unknown').replace(/[^a-z0-9_-]/g, '') || 'unknown';
  const pad = (n) => String(n).padStart(2, '0');
  return `opening-trainer-${id}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

/** Bytes of the UTF-8 JSON text (what the file will be). @param {any} value */
export function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** "1.2 MB", "340 KB", "800 B". @param {number} n */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${Math.round(n / 1000)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

function validateRows(rows, field, userId, check) {
  if (!Array.isArray(rows)) throw new ImportError(`The backup is damaged: "${field}" is not a list.`);
  rows.forEach((r, i) => {
    if (!isObject(r) || !check(r)) throw new ImportError(`The backup is damaged: entry ${i + 1} of "${field}" is invalid.`);
    if (userId !== null && r.userId !== userId) throw new ImportError(`The backup is damaged: "${field}" holds data of another user (${r.userId}).`);
  });
}

/**
 * Validate a parsed backup object. Throws ImportError.
 * @param {any} b @returns {any} the same object
 */
export function validateBackup(b) {
  if (!Number.isInteger(b.version)) throw new ImportError('The backup has no format version.');
  if (b.version > BACKUP_VERSION) {
    throw new ImportError(`This backup was made by a newer version of the trainer (format ${b.version}); this page reads format ${BACKUP_VERSION}. Reload the page to get the newest version.`);
  }
  if (b.version < 1) throw new ImportError(`Unknown backup format version ${b.version}.`);
  if (b.kind !== 'small' && b.kind !== 'full') throw new ImportError('The backup is damaged: "kind" must be "small" or "full".');
  if (typeof b.user !== 'string' || !NAME_PATTERN.test(b.user)) throw new ImportError('The backup is damaged: it has no valid Lichess name in "user".');
  if (b.positions !== null && b.positions !== undefined) {
    validatePositionsDoc(b.positions, 'The analysis in the backup');
    if (userIdOf(b.positions.user) !== userIdOf(b.user)) throw new ImportError(`The backup is damaged: its analysis is of ${b.positions.user}, not ${b.user}.`);
  }
  if (b.stats !== undefined && !isObject(b.stats)) throw new ImportError('The backup is damaged: "stats" is not an object.');
  if (b.kind === 'full') {
    const userId = userIdOf(b.user);
    validateRows(b.games ?? [], 'games', userId, (r) => typeof r.id === 'string' && isNum(r.createdAt));
    validateRows(b.results ?? [], 'results', userId, (r) => typeof r.runKey === 'string' && typeof r.gameId === 'string');
    validateRows(b.evals ?? [], 'evals', null, (r) => typeof r.engineId === 'string' && typeof r.fenKey === 'string'
      && isNum(r.depth) && isNum(r.multipv) && Array.isArray(r.lines));
    if (b.fetchState !== null && b.fetchState !== undefined && (!isObject(b.fetchState) || b.fetchState.userId !== userId)) {
      throw new ImportError('The backup is damaged: "fetchState" is invalid.');
    }
  }
  if ((b.positions ?? null) === null && !Object.keys(cleanStats(b.stats)).length && !(b.games?.length)) {
    throw new ImportError(`The backup of ${b.user} is empty: no analysis, no stats, no games.`);
  }
  return b;
}

/**
 * @typedef {{type: 'backup', user: string, backup: any} | {type: 'positions', user: string, doc: any}} AnalysisFile
 */

/**
 * Read a dropped or picked file's text: a backup, or a CLI positions.json. Throws ImportError with a
 * message for the friend.
 * @param {string} text
 * @returns {AnalysisFile}
 */
export function readAnalysisFile(text) {
  if (typeof text !== 'string' || !text.trim()) throw new ImportError('The file is empty.');
  let value;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new ImportError(`This is not a trainer file: it is not valid JSON (${String(err?.message ?? err).slice(0, 120)}).`);
  }
  if (!isObject(value)) throw new ImportError('This is not a trainer file: expected a backup or a positions.json.');
  if (value.format === BACKUP_FORMAT) {
    validateBackup(value);
    return { type: 'backup', user: value.user, backup: value };
  }
  if ('format' in value) throw new ImportError(`This is not a trainer file (format "${String(value.format).slice(0, 60)}").`);
  if (Array.isArray(value.positions)) {
    validatePositionsDoc(value, 'The positions.json');
    return { type: 'positions', user: value.user, doc: value };
  }
  throw new ImportError('This is not a trainer file: expected a backup or a positions.json (it has neither "format" nor "positions").');
}

// ---------- merge ----------

/**
 * Stats of both sides; per position the entry with more tries wins, the incoming one on a tie. Importing
 * the same backup twice therefore changes nothing.
 * @param {Record<string, any>} existing @param {Record<string, any>} incoming
 */
export function mergeStats(existing, incoming) {
  const out = { ...cleanStats(existing) };
  for (const [key, s] of Object.entries(cleanStats(incoming))) {
    if (!out[key] || s.tries >= out[key].tries) out[key] = s;
  }
  return out;
}

const time = (doc) => {
  const t = Date.parse(doc?.generated ?? '');
  return Number.isNaN(t) ? -Infinity : t;
};

/**
 * The positions document after an import. Replace: the incoming one (if any). Merge: the newer by
 * `generated`; on a tie (the same analysis again) the one with more positions, so a link with only
 * the top positions never shrinks a complete copy; else the incoming one.
 * @param {any} existing @param {any} incoming @param {'merge'|'replace'} mode
 */
export function choosePositions(existing, incoming, mode) {
  if (!incoming) return mode === 'replace' ? null : existing ?? null;
  if (mode === 'replace' || !existing) return incoming;
  const [a, b] = [time(existing), time(incoming)];
  if (a !== b) return a > b ? existing : incoming;
  return (existing.positions?.length ?? 0) > incoming.positions.length ? existing : incoming;
}

/**
 * One line about what a file holds, for the confirmation.
 * @param {AnalysisFile} file
 */
export function describeFile(file) {
  if (file.type === 'positions') {
    return `Analysis of ${file.user} from the command line: ${file.doc.positions.length} positions from ${file.doc.games ?? '?'} games.`;
  }
  const b = file.backup;
  const parts = [b.positions ? `${b.positions.positions.length} positions` : 'no analysis', `stats for ${Object.keys(cleanStats(b.stats)).length} positions`];
  if (b.kind === 'full') parts.push(`${b.games?.length ?? 0} games`, `${b.evals?.length ?? 0} engine results`);
  const when = new Date(b.exported);
  const date = Number.isNaN(when.getTime()) ? '' : `, saved ${when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
  return `${b.kind === 'full' ? 'Full backup' : 'Backup'} of ${b.user}${date}: ${parts.join(', ')}.`;
}
