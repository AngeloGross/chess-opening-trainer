// Start-up choice between the CLI's positions.json and the browser analysis (web/core/startChoice.js).
import { describe, expect, it } from 'vitest';
import { chooseStart, cliOffer, isPositionsDoc, loadCliDoc } from '../web/core/startChoice.js';

const cli = { user: 'AngelOgro', games: 500, generated: '2026-10-08T09:33:44+00:00', positions: [{ key: 'a' }, { key: 'b' }] };
const browser = { user: 'friend', games: 60, positions: [{ key: 'c' }] };

describe('isPositionsDoc / cliOffer', () => {
  it('recognises the positions document shape', () => {
    expect(isPositionsDoc(cli)).toBe(true);
    expect(isPositionsDoc({ positions: [] })).toBe(true);
    for (const bad of [null, undefined, 'x', [], {}, { positions: {} }]) expect(isPositionsDoc(bad)).toBe(false);
  });

  it('describes the CLI analysis for the choice button', () => {
    expect(cliOffer(cli)).toEqual({ user: 'AngelOgro', positions: 2, games: 500, generated: '2026-10-08T09:33:44+00:00' });
    expect(cliOffer({ positions: [] })).toEqual({ user: 'unknown user', positions: 0, games: null, generated: null });
    expect(cliOffer(null)).toBeNull();
  });
});

describe('chooseStart', () => {
  it('first visit without anything: start screen, nothing offered', () => {
    expect(chooseStart({})).toEqual({ view: 'start', offer: null });
  });

  it('first visit with a CLI document: start screen offering it', () => {
    expect(chooseStart({ cliDoc: cli })).toEqual({ view: 'start', offer: cliOffer(cli) });
  });

  it('returning browser visitor: the stored document at once, even with a CLI document present', () => {
    expect(chooseStart({ lastSource: 'browser', browserDoc: browser, cliDoc: cli })).toEqual({ view: 'trainer', source: 'browser', doc: browser });
    expect(chooseStart({ browserDoc: browser })).toEqual({ view: 'trainer', source: 'browser', doc: browser });
  });

  it('CLI chosen last time: the CLI document directly', () => {
    expect(chooseStart({ lastSource: 'cli', browserDoc: browser, cliDoc: cli })).toEqual({ view: 'trainer', source: 'cli', doc: cli });
  });

  it('CLI chosen last time but the file is gone: the browser document, else the start screen', () => {
    expect(chooseStart({ lastSource: 'cli', browserDoc: browser })).toEqual({ view: 'trainer', source: 'browser', doc: browser });
    expect(chooseStart({ lastSource: 'cli' })).toEqual({ view: 'start', offer: null });
  });
});

describe('loadCliDoc', () => {
  const answer = (status, body) => async () => ({ ok: status < 400, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });

  it('returns the document when it is there', async () => {
    expect(await loadCliDoc(answer(200, cli))).toEqual(cli);
  });

  it('treats 404, network errors, bad JSON and other shapes as "no CLI document"', async () => {
    expect(await loadCliDoc(answer(404, { error: 'Not found' }))).toBeNull();
    expect(await loadCliDoc(async () => { throw new TypeError('offline'); })).toBeNull();
    expect(await loadCliDoc(answer(200, '<!doctype html>'))).toBeNull();
    expect(await loadCliDoc(answer(200, { hello: 1 }))).toBeNull();
  });

  it('asks for a fresh copy of positions.json', async () => {
    const calls = [];
    await loadCliDoc(async (url, init) => { calls.push([url, init]); return { ok: false, status: 404 }; });
    expect(calls).toEqual([['positions.json', { cache: 'no-store' }]]);
  });
});
