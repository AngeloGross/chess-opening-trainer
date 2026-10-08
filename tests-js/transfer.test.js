// "Send to phone" link (web/core/transfer.js, slice 8): slim format, deflate-raw + base64url round trip,
// the size strategy, and damaged links. CompressionStream is native in Node 24.
import { describe, expect, it } from 'vitest';
import { qrPath } from '../web/core/qr.js';
import {
  FRAGMENT_PREFIX, QR_MAX_BYTES, TransferError, compressionSupported, decodeFragment, decodePayload, encodeSlim,
  expandSlim, fromBase64Url, planTransfer, slimDoc, toBase64Url,
} from '../web/core/transfer.js';
import { POSITIONS, STATS, makeDoc } from './backupFixtures.js';

const BASE = 'https://trainer.example/';

/** What the trainer gets: the document with played cut to the usual move and games to `games`. */
function trainerView(doc, games) {
  return { ...doc, positions: doc.positions.map((p) => ({ ...p, played: p.played.slice(0, 1), games: p.games.slice(0, games) })) };
}

/** A larger document: `n` distinct positions (the fixture positions with renumbered fullmove fields). */
function bigDoc(n) {
  const positions = [];
  for (let i = 0; i < n; i += 1) {
    const p = structuredClone(POSITIONS[i % POSITIONS.length]);
    const f = p.fen.split(' ');
    f[5] = String(2 + i);
    p.fen = f.join(' ');
    p.score = 1000 - i;
    p.games = [`https://lichess.org/${String(i).padStart(8, 'x')}#${i % 30}`];
    positions.push(p);
  }
  return { ...makeDoc(), positions };
}

const transferError = async (promise) => {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(TransferError);
  return err.message;
};

describe('slim document', () => {
  it('round-trips everything the trainer uses, recomputing key, orientation and SAN', () => {
    const doc = makeDoc();
    const { doc: back, stats, total } = expandSlim(slimDoc(doc, STATS));
    expect(back).toEqual(trainerView(doc, 1));
    expect(stats).toEqual(STATS);
    expect(total).toBe(4);
  });

  it('keeps raw_avg_loss only when it differs, and drops game links on request', () => {
    const slim = slimDoc(makeDoc(), {}, { gamesPerPosition: 0 });
    expect(slim.p.map((r) => r.length)).toEqual([10, 11, 10, 10]);
    expect(slim.p[0][9]).toBe('');
    expect(expandSlim(slim).doc.positions[1].raw_avg_loss).toBe(612.5);
  });

  it('carries only the top N positions and their stats, and the total', () => {
    const slim = slimDoc(makeDoc(), STATS, { top: 2 });
    const { doc, stats, total } = expandSlim(slim);
    expect(doc.positions.map((p) => p.key)).toEqual(POSITIONS.slice(0, 2).map((p) => p.key));
    expect(Object.keys(stats)).toEqual([POSITIONS[0].key]); // POSITIONS[2]'s stats went with it
    expect(total).toBe(4);
  });

  it('shares one opening table entry between positions', () => {
    expect(slimDoc(makeDoc()).o).toEqual([['A40', "Queen's Pawn Game: Anglo-Slav Opening"], ['B00', 'Some Opening'], [null, 'Unknown']]);
  });

  it('refuses links of another format or version, and damaged rows', () => {
    const slim = slimDoc(makeDoc());
    expect(() => expandSlim({ ...slim, v: 2 })).toThrow(/newer version of the trainer \(format 2\)/);
    expect(() => expandSlim({ ...slim, f: 'x' })).toThrow(TransferError);
    expect(() => expandSlim({ ...slim, p: [['fen']] })).toThrow(/position 1/);
    expect(() => expandSlim({ ...slim, p: [[...slim.p[0].slice(0, 6), 9, ...slim.p[0].slice(7)]] })).toThrow(/best move of position 1/);
    const badFen = structuredClone(slim);
    badFen.p[0][0] = 'xx w - - 0 1';
    expect(() => expandSlim(badFen)).toThrow(/damaged or incomplete \(The analysis is damaged: position 1 has an invalid "fen"\.\)/);
  });
});

describe('encode / decode', () => {
  it('Node has CompressionStream', () => {
    expect(compressionSupported()).toBe(true);
  });

  it('base64url round-trips any bytes without padding or + /', () => {
    const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7919) % 256);
    const text = toBase64Url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64Url(text)).toEqual(bytes);
  });

  it('round-trips through the fragment', async () => {
    const doc = makeDoc();
    const payload = await encodeSlim(slimDoc(doc, STATS));
    const back = await decodeFragment(FRAGMENT_PREFIX + payload);
    expect(back.doc).toEqual(trainerView(doc, 1));
    expect(back.stats).toEqual(STATS);
  });

  it('compresses: the link is far smaller than the document', async () => {
    const doc = bigDoc(200);
    const payload = await encodeSlim(slimDoc(doc, {}));
    expect(payload.length).toBeLessThan(JSON.stringify(doc).length / 4);
  });

  it('damaged links give readable errors', async () => {
    const payload = await encodeSlim(slimDoc(makeDoc(), STATS));
    expect(await transferError(decodeFragment('#other=1'))).toBe('This is not a trainer link.');
    expect(await transferError(decodePayload(''))).toMatch(/empty/);
    expect(await transferError(decodePayload('abc$def'))).toMatch(/characters a trainer link never has/);
    expect(await transferError(decodePayload(payload.slice(0, payload.length / 2)))).toMatch(/damaged or cut off/);
    expect(await transferError(decodePayload('A'))).toMatch(/damaged or cut off/);
    const notJson = toBase64Url(new Uint8Array(await new Response(new Blob(['not json']).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()));
    expect(await transferError(decodePayload(notJson))).toMatch(/contents are not readable/);
  });
});

describe('planTransfer (size strategy)', () => {
  it('a small analysis: one link, which is also the QR code, with game links', async () => {
    const plan = await planTransfer(makeDoc(), STATS, BASE);
    expect(plan.qr).toBe(plan.link);
    expect(plan.link).toMatchObject({ positions: 4, gamesPerPosition: 1 });
    expect(plan.link.url.startsWith(BASE + FRAGMENT_PREFIX)).toBe(true);
    expect(plan.link.bytes).toBe(plan.link.url.length);
    expect(plan.rawBytes).toBeGreaterThan(plan.slimBytes);
  });

  it('too large for a QR code: the link keeps everything, the QR the top N without game links', async () => {
    const doc = bigDoc(400);
    const plan = await planTransfer(doc, STATS, BASE);
    expect(plan.link).toMatchObject({ positions: 400, gamesPerPosition: 1 });
    expect(plan.qr.gamesPerPosition).toBe(0);
    expect(plan.qr.positions).toBeGreaterThan(5);
    expect(plan.qr.positions).toBeLessThan(400);
    expect(plan.qr.bytes).toBeLessThanOrEqual(QR_MAX_BYTES);
    // N is the largest that fits: one more position does not.
    const next = BASE + FRAGMENT_PREFIX + await encodeSlim(slimDoc(doc, STATS, { top: plan.qr.positions + 1, gamesPerPosition: 0 }));
    expect(next.length).toBeGreaterThan(QR_MAX_BYTES);
    // And the QR link really decodes to those positions.
    const back = await decodeFragment(plan.qr.url.slice(BASE.length));
    expect(back.doc.positions).toHaveLength(plan.qr.positions);
    expect(back.total).toBe(400);
    expect(back.doc.positions.every((p) => p.games.length === 0)).toBe(true);
    // The QR code itself is a version-40 code at most.
    expect(qrPath(plan.qr.url).version).toBeLessThanOrEqual(40);
  });

  it('caps the copyable link too, and gives up on the QR code when nothing fits', async () => {
    const doc = bigDoc(400);
    const plan = await planTransfer(doc, {}, BASE, { qrMax: 60, linkMax: 3000 });
    expect(plan.qr).toBeNull();
    expect(plan.link.positions).toBeLessThan(400);
    expect(plan.link.bytes).toBeLessThanOrEqual(3000);
  });
});

describe('qrPath', () => {
  it('builds the smallest code that fits, and refuses more than version 40 holds', () => {
    expect(qrPath('https://trainer.example/')).toMatchObject({ version: 2, modules: 25 });
    expect(qrPath('x'.repeat(QR_MAX_BYTES)).version).toBe(40);
    expect(() => qrPath('x'.repeat(QR_MAX_BYTES + 1))).toThrow();
  });
});
