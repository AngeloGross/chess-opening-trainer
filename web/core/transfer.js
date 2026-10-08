// "Send to phone" without a server (design §8, consequence 3; slice 8): the positions document plus the
// user's quiz stats travel in the URL fragment of a link (`#import=…`), shown as a QR code when it fits.
//
// Wire format, version 1: `#import=` + base64url(deflate-raw(JSON of a slim document)). The fragment never
// reaches a server. The slim document drops what the trainer can recompute and shortens the rest:
//
//   { f: "otx", v: 1,
//     u: user, g: games, c: clean_games, t: generated,
//     s: [perf[], max_moves, threshold, depth, engine|null],
//     n: positions in the source document (the slim one may carry only the top N),
//     o: [[eco, opening name], …]                         opening table, referenced by index
//     p: [[fen, errors, reached, avg_loss, score, "uci uci …" (acceptable), best index in acceptable,
//          "uci count" (the most played move), opening index, "gameId#ply …" (0 or 1 game), raw_avg_loss?], …]
//     x: [[position index, tries, solved, failed, last 1=solved|0=failed], …] }   quiz stats of those positions
//
// Recomputed on the phone: key (first four FEN fields), orientation (side to move: positions are always the
// player's move), best_san and the played SAN (chess.js). raw_avg_loss is sent only when it differs from
// avg_loss. Dropped: every played move but the most common one (the trainer shows only that one) and the
// game links beyond `gamesPerPosition`.
import { Chess } from '../vendor/chess.js@1.4.0/dist/esm/chess.js';
import { validatePositionsDoc } from './backup.js';

export const TRANSFER_FORMAT = 'otx';
export const TRANSFER_VERSION = 1;
export const FRAGMENT_PREFIX = '#import=';
/** QR version 40, error correction L, byte mode: the largest QR code there is. */
export const QR_MAX_BYTES = 2953;
/** Longest link offered for copying: what WhatsApp, e-mail and notes apps take in one message. */
export const LINK_MAX_CHARS = 60000;

const LICHESS = 'https://lichess.org/';

/** Readable failure of decoding or expanding a transfer link. */
export class TransferError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransferError';
  }
}

/** Whether this browser can build and read transfer links. */
export function compressionSupported(g = globalThis) {
  return typeof g.CompressionStream === 'function' && typeof g.DecompressionStream === 'function';
}

// ---------- slim document ----------

/**
 * @param {any} doc  positions document (validated)
 * @param {Record<string, any>} stats  the user's quiz stats, by position key
 * @param {{top?: number, gamesPerPosition?: number}} [opts]  top: first N positions of the document's ranking
 * @returns {any} the slim document (JSON-ready)
 */
export function slimDoc(doc, stats = {}, { top = Infinity, gamesPerPosition = 1 } = {}) {
  const positions = doc.positions.slice(0, Math.max(0, top));
  const openings = [];
  const openingIndex = new Map();
  const p = positions.map((pos) => {
    const id = JSON.stringify([pos.eco ?? null, pos.opening ?? null]);
    if (!openingIndex.has(id)) {
      openingIndex.set(id, openings.length);
      openings.push([pos.eco ?? null, pos.opening ?? null]);
    }
    const usual = pos.played[0];
    const row = [
      pos.fen, pos.errors, pos.reached, pos.avg_loss, pos.score,
      pos.acceptable.join(' '), Math.max(0, pos.acceptable.indexOf(pos.best)),
      usual ? `${usual.uci} ${usual.count}` : '',
      openingIndex.get(id),
      pos.games.slice(0, gamesPerPosition).map((u) => (u.startsWith(LICHESS) ? u.slice(LICHESS.length) : u)).join(' '),
    ];
    if (pos.raw_avg_loss !== pos.avg_loss) row.push(pos.raw_avg_loss);
    return row;
  });
  const x = [];
  positions.forEach((pos, i) => {
    const s = stats?.[pos.key];
    if (s && Number(s.tries) > 0) x.push([i, s.tries | 0, s.solved | 0, s.failed | 0, s.last === 'solved' ? 1 : 0]);
  });
  const st = doc.settings ?? {};
  return {
    f: TRANSFER_FORMAT, v: TRANSFER_VERSION,
    u: doc.user, g: doc.games ?? null, c: doc.clean_games ?? null, t: doc.generated ?? null,
    s: [st.perf ?? null, st.max_moves ?? null, st.threshold ?? null, st.depth ?? null, st.engine ?? null],
    n: doc.positions.length,
    o: openings, p, x,
  };
}

const fail = (what) => {
  throw new TransferError(`The link is damaged or incomplete (${what}). Create a new link on the computer.`);
};

function sanOf(fen, uci) {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return uci;
  }
}

/**
 * The positions document and stats of a slim document.
 * @param {any} slim
 * @returns {{doc: any, stats: Record<string, any>, total: number}}
 */
export function expandSlim(slim) {
  if (!slim || typeof slim !== 'object' || slim.f !== TRANSFER_FORMAT) fail('not a trainer link');
  if (slim.v !== TRANSFER_VERSION) {
    throw new TransferError(`The link was made by a ${slim.v > TRANSFER_VERSION ? 'newer' : 'different'} version of the trainer `
      + `(format ${slim.v}); this page reads format ${TRANSFER_VERSION}. Update the page and try again.`);
  }
  if (!Array.isArray(slim.p) || !Array.isArray(slim.o) || !Array.isArray(slim.s)) fail('fields missing');
  const [perf, maxMoves, threshold, depth, engine] = slim.s;
  const positions = slim.p.map((row, i) => {
    if (!Array.isArray(row) || row.length < 10) fail(`position ${i + 1}`);
    const [fen, errors, reached, avgLoss, score, acceptableText, bestIdx, usualText, openingIdx, gamesText, raw] = row;
    if (typeof fen !== 'string' || typeof acceptableText !== 'string' || typeof usualText !== 'string' || typeof gamesText !== 'string') fail(`position ${i + 1}`);
    const fields = fen.split(' ');
    const acceptable = acceptableText ? acceptableText.split(' ') : [];
    const [eco, opening] = slim.o[openingIdx] ?? fail(`opening of position ${i + 1}`);
    const best = acceptable[bestIdx] ?? fail(`best move of position ${i + 1}`);
    const [usualUci, usualCount] = usualText ? usualText.split(' ') : [];
    return {
      key: fields.slice(0, 4).join(' '),
      fen,
      orientation: fields[1] === 'b' ? 'black' : 'white',
      errors, reached, avg_loss: avgLoss, raw_avg_loss: raw ?? avgLoss, score,
      best, best_san: sanOf(fen, best), acceptable,
      played: usualUci ? [{ uci: usualUci, san: sanOf(fen, usualUci), count: Number(usualCount) }] : [],
      eco, opening,
      games: gamesText ? gamesText.split(' ').map((g) => (/^https?:/.test(g) ? g : LICHESS + g)) : [],
    };
  });
  /** @type {any} */
  const settings = { perf, max_moves: maxMoves, threshold, depth };
  if (engine) settings.engine = engine;
  const doc = { generated: slim.t, user: slim.u, games: slim.g, clean_games: slim.c, settings, positions };
  try {
    validatePositionsDoc(doc);
  } catch (err) {
    fail(err.message);
  }
  /** @type {Record<string, any>} */
  const stats = {};
  for (const row of Array.isArray(slim.x) ? slim.x : []) {
    const pos = positions[row?.[0]];
    if (!pos) continue;
    const [, tries, solved, failed, last] = row;
    stats[pos.key] = { tries, solved, failed, last: last ? 'solved' : 'failed' };
  }
  return { doc, stats, total: Number.isFinite(slim.n) ? slim.n : positions.length };
}

// ---------- compression + base64url ----------

/** @param {Uint8Array} bytes @returns {string} */
export function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** @param {string} text @returns {Uint8Array} */
export function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new TransferError('The link is damaged (it contains characters a trainer link never has). Copy the whole link again.');
  const b64 = text.replaceAll('-', '+').replaceAll('_', '/');
  let bin;
  try {
    bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  } catch {
    throw new TransferError('The link is damaged or cut off. Copy the whole link again.');
  }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** @param {Uint8Array} bytes @param {CompressionStream|DecompressionStream} stream */
async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/**
 * @param {any} slim @returns {Promise<string>} the fragment payload (after `#import=`)
 */
export async function encodeSlim(slim) {
  if (!compressionSupported()) throw new TransferError('This browser cannot compress data (CompressionStream is missing). Use a backup file instead.');
  const bytes = await pipe(new TextEncoder().encode(JSON.stringify(slim)), new CompressionStream('deflate-raw'));
  return toBase64Url(bytes);
}

/**
 * @param {string} payload @returns {Promise<any>} the slim document
 */
export async function decodePayload(payload) {
  if (!compressionSupported()) {
    throw new TransferError('This browser cannot read trainer links (DecompressionStream is missing; Safari needs iOS 16.4 or newer). Use a backup file instead.');
  }
  const bytes = fromBase64Url(payload);
  if (!bytes.length) throw new TransferError('The link is empty. Copy the whole link again.');
  let json;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(await pipe(bytes, new DecompressionStream('deflate-raw')));
  } catch {
    throw new TransferError('The link is damaged or cut off (it does not unpack). Copy the whole link again.');
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new TransferError('The link is damaged (its contents are not readable). Create a new link on the computer.');
  }
}

/** The payload of a `#import=` fragment, or null. @param {string} hash */
export function payloadOf(hash) {
  return typeof hash === 'string' && hash.startsWith(FRAGMENT_PREFIX) ? hash.slice(FRAGMENT_PREFIX.length) : null;
}

/** @param {string} hash @returns {Promise<{doc: any, stats: Record<string, any>, total: number}>} */
export async function decodeFragment(hash) {
  const payload = payloadOf(hash);
  if (payload === null) throw new TransferError('This is not a trainer link.');
  return expandSlim(await decodePayload(payload));
}

// ---------- size strategy ----------

/**
 * Largest n in [0, max] with `fits(n)`, assuming fits is monotone (more positions never get shorter).
 * @param {number} max @param {(n: number) => Promise<boolean>} fits
 */
async function largest(max, fits) {
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (await fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * @typedef {{url: string, positions: number, gamesPerPosition: number, bytes: number}} TransferLink
 * @typedef {{total: number, rawBytes: number, slimBytes: number, link: TransferLink|null, qr: TransferLink|null}} TransferPlan
 */

/**
 * The links to offer (design §8 slice 8 strategy):
 * 1. Everything (all positions, one game link each) if that link fits a QR code: one link, one QR.
 * 2. Otherwise the copyable link keeps all positions with one game link (or the top N that fit
 *    `linkMax`), and the QR code carries the top N positions without game links that fit `qrMax`.
 * Lengths are of the whole URL, `base` included (ASCII, so characters = bytes in the QR code).
 * @param {any} doc @param {Record<string, any>} stats @param {string} base  page URL without fragment
 * @param {{qrMax?: number, linkMax?: number}} [limits]
 * @returns {Promise<TransferPlan>}
 */
export async function planTransfer(doc, stats, base, { qrMax = QR_MAX_BYTES, linkMax = LINK_MAX_CHARS } = {}) {
  const total = doc.positions.length;
  const cache = new Map();
  const build = async (top, gamesPerPosition) => {
    const id = `${top}/${gamesPerPosition}`;
    if (!cache.has(id)) {
      const url = base + FRAGMENT_PREFIX + await encodeSlim(slimDoc(doc, stats, { top, gamesPerPosition }));
      cache.set(id, { url, positions: Math.min(top, total), gamesPerPosition, bytes: url.length });
    }
    return cache.get(id);
  };
  const rawBytes = new TextEncoder().encode(JSON.stringify(doc)).length;
  const slimBytes = new TextEncoder().encode(JSON.stringify(slimDoc(doc, stats))).length;

  const full = await build(total, 1);
  if (full.bytes <= qrMax) return { total, rawBytes, slimBytes, link: full, qr: full };

  let link = full;
  if (full.bytes > linkMax) {
    const n = await largest(total, async (k) => (await build(k, 1)).bytes <= linkMax);
    link = n ? await build(n, 1) : null;
  }
  const bare = await build(total, 0);
  let qr = null;
  if (bare.bytes <= qrMax) qr = bare;
  else {
    const n = await largest(total, async (k) => (await build(k, 0)).bytes <= qrMax);
    if (n) qr = await build(n, 0);
  }
  return { total, rawBytes, slimBytes, link, qr };
}
