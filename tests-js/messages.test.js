// User-facing messages (slice 7): every error kind has a text and a next step; errors map to kinds.
import { describe, expect, it } from 'vitest';
import { KINDS, classifyError, messageFor, messageText, perfList, retryCountdownText } from '../web/core/messages.js';
import { LichessError } from '../web/lichess/client.js';
import { EngineAnalysisError } from '../web/engine/pool.js';
import { TransferError } from '../web/core/transfer.js';

describe('messageFor', () => {
  it('has a text and a next step for every kind', () => {
    for (const kind of KINDS) {
      const m = messageFor(kind, { name: 'Bob', perfs: ['blitz'], status: 503 });
      expect(m.kind).toBe(kind);
      expect(m.text.length).toBeGreaterThan(10);
      expect(m.hint.length).toBeGreaterThan(10);
      expect(messageText(m)).toBe(`${m.text} ${m.hint}`);
    }
    expect(new Set(KINDS.map((k) => messageFor(k).text)).size).toBe(KINDS.length); // all different
  });

  it('says what to do for the risk-table rows', () => {
    expect(messageFor('offline').hint).toMatch(/Connect to the internet/);
    expect(messageFor('rate_limited')).toMatchObject({ retry: true, hint: expect.stringMatching(/Wait a minute/) });
    expect(messageFor('network')).toMatchObject({ retry: true, text: expect.stringMatching(/slow down/) });
    expect(messageFor('not_found', { name: 'zz' }).text).toBe('There is no Lichess player called “zz”.');
    expect(messageFor('closed', { name: 'zz' }).text).toMatch(/closed/);
    expect(messageFor('no_games', { name: 'Bob', perfs: ['blitz', 'rapid', 'classical'] }).text)
      .toBe('Bob has no blitz, rapid or classical games on Lichess.');
    expect(messageFor('http', { status: 503 }).text).toMatch(/HTTP 503/);
    expect(messageFor('quota').hint).toMatch(/fewer games/);
    expect(messageFor('storage_unavailable').hint).toMatch(/normal window/);
    expect(messageFor('engine_failed').hint).toMatch(/Update the browser/);
    expect(messageFor('no_decompression').text).toMatch(/iOS 16\.4/);
    expect(messageFor('whatever', { detail: 'x broke' })).toMatchObject({ kind: 'internal', text: 'Something went wrong: x broke' });
  });

  it('formats lists and the retry countdown', () => {
    expect(perfList(['blitz'])).toBe('blitz');
    expect(perfList(['blitz', 'rapid'])).toBe('blitz or rapid');
    expect(retryCountdownText('rate_limited', 59.2)).toBe('Lichess asked us to slow down. Trying again in 60 s…');
    expect(retryCountdownText('network', 3)).toMatch(/could not be reached .* 3 s…$/);
  });
});

describe('classifyError', () => {
  it('maps Lichess errors, offline first', () => {
    expect(classifyError(new LichessError('x', 'not_found'))).toBe('not_found');
    expect(classifyError(new LichessError('x', 'rate_limited'))).toBe('rate_limited');
    expect(classifyError(new LichessError('x', 'network'))).toBe('network');
    expect(classifyError(new LichessError('x', 'network'), { online: false })).toBe('offline');
    expect(classifyError({ kind: 'closed' })).toBe('closed'); // a fetch-worker message
    expect(classifyError(new TypeError('Failed to fetch'), { where: 'lichess' })).toBe('network'); // a 429 without CORS
    expect(classifyError(new TypeError('Failed to fetch'), { where: 'lichess', online: false })).toBe('offline');
  });

  it('maps storage, engine and link failures', () => {
    expect(classifyError(new DOMException('full', 'QuotaExceededError'))).toBe('quota');
    expect(classifyError({ kind: 'quota' })).toBe('quota');
    expect(classifyError(new DOMException('no', 'InvalidStateError'), { where: 'storage' })).toBe('storage_unavailable');
    expect(classifyError(new Error('indexedDB is missing'))).toBe('storage_unavailable');
    expect(classifyError(new DOMException('denied', 'SecurityError'))).toBe('storage_unavailable');
    expect(classifyError(new EngineAnalysisError('engine did not start in time'))).toBe('engine_failed');
    expect(classifyError(new EngineAnalysisError('stopped', { stopped: true }))).toBe('internal');
    expect(classifyError(new Error('WebAssembly.instantiate(): out of memory'))).toBe('engine_failed');
    expect(classifyError(new Error('x'), { where: 'engine' })).toBe('engine_failed');
    expect(classifyError(new TransferError('This browser cannot read trainer links (DecompressionStream is missing)'))).toBe('no_decompression');
    expect(classifyError(new Error('This browser cannot compress data (CompressionStream is missing)'))).toBe('no_compression');
    expect(classifyError(new Error('boom'))).toBe('internal');
  });
});
