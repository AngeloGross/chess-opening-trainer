// Lichess API client for the browser: user check and streamed game export (ndjson).
// The browser's own User-Agent is accepted by Lichess, and both endpoints answer with
// Access-Control-Allow-Origin: *, so this runs from any origin (see design §3.1).

const BASE = 'https://lichess.org';

export class LichessError extends Error {
  /**
   * @param {string} message
   * @param {'not_found'|'closed'|'rate_limited'|'network'|'offline'|'http'} kind
   * @param {{status?: number}} [extra]
   */
  constructor(message, kind, { status } = {}) {
    super(message);
    this.name = 'LichessError';
    this.kind = kind;
    this.status = status;
  }
}

/** Map a fetch() rejection to a LichessError. A 429 without CORS headers also lands here (design §3.1). */
function networkError(err) {
  if (err?.name === 'AbortError') throw err;
  if (globalThis.navigator?.onLine === false) throw new LichessError(`This device is offline (${err?.message ?? err}).`, 'offline');
  throw new LichessError(`Could not reach Lichess (${err?.message ?? err}). Wait a minute and retry.`, 'network');
}

function httpError(resp, user) {
  if (resp.status === 404) return new LichessError(`Lichess user "${user}" not found.`, 'not_found');
  if (resp.status === 429) return new LichessError('Lichess rate limit hit. Wait a minute and retry.', 'rate_limited');
  return new LichessError(`Lichess answered HTTP ${resp.status}.`, 'http', { status: resp.status });
}

/**
 * The canonical Lichess name for `user`; throws LichessError if the account does not exist or is closed.
 * @param {string} user
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<string>}
 */
export async function checkUser(user, { signal } = {}) {
  let resp;
  try {
    resp = await fetch(`${BASE}/api/user/${encodeURIComponent(user)}`, { signal });
  } catch (err) {
    networkError(err);
  }
  if (!resp.ok) throw httpError(resp, user);
  const info = await resp.json();
  if (info.disabled || info.closed) throw new LichessError(`Lichess account "${user}" is closed.`, 'closed');
  return info.username || user;
}

/**
 * Stream a user's games as parsed objects, newest first, as they arrive.
 * Params mirror the CLI (fetch.py): perfType, max, since, until; opening and moves are always on.
 * @param {string} user
 * @param {{perfType?: string, max?: number, since?: number, until?: number}} params
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {AsyncGenerator<object>}
 */
export async function* streamGames(user, params = {}, { signal } = {}) {
  const query = new URLSearchParams({ opening: 'true', moves: 'true', evals: 'false' });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) query.set(k, String(v));
  let resp;
  try {
    resp = await fetch(`${BASE}/api/games/user/${encodeURIComponent(user)}?${query}`, {
      headers: { Accept: 'application/x-ndjson' }, // CORS-safelisted: no preflight
      signal,
    });
  } catch (err) {
    networkError(err);
  }
  if (!resp.ok) throw httpError(resp, user);

  const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        networkError(err);
      }
      if (chunk.done) break;
      buffer += chunk.value;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield JSON.parse(line);
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer);
  } finally {
    reader.releaseLock();
  }
}
