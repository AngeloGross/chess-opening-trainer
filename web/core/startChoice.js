// Pure start-up decision of the app (app.js): what to show first, given the remembered user, the stored
// browser document and a `positions.json` from the CLI (design §10: served by `trainer serve`, the page
// can still pick up the CLI's file).

/**
 * Whether `value` looks like a positions document (the CLI's positions.json shape, design §5).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPositionsDoc(value) {
  return !!value && typeof value === 'object' && Array.isArray(/** @type {any} */ (value).positions);
}

/**
 * What the start screen offers for a CLI document: its user and position count, or null.
 * @param {any} cliDoc
 * @returns {{user: string, positions: number, games: number|null, generated: string|null}|null}
 */
export function cliOffer(cliDoc) {
  if (!isPositionsDoc(cliDoc)) return null;
  return {
    user: typeof cliDoc.user === 'string' && cliDoc.user ? cliDoc.user : 'unknown user',
    positions: cliDoc.positions.length,
    games: Number.isFinite(cliDoc.games) ? cliDoc.games : null,
    generated: typeof cliDoc.generated === 'string' ? cliDoc.generated : null,
  };
}

/**
 * The first view:
 * - the CLI document, when the friend chose it last time and it is still there;
 * - otherwise the stored browser document of the remembered user (returning visitor);
 * - otherwise the start screen, which offers the CLI document if there is one.
 * @param {{lastSource?: 'cli'|'browser'|null, browserDoc?: any, cliDoc?: any}} p
 * @returns {{view: 'trainer', source: 'cli'|'browser', doc: any} | {view: 'start', offer: ReturnType<typeof cliOffer>}}
 */
export function chooseStart({ lastSource = null, browserDoc = null, cliDoc = null }) {
  if (lastSource === 'cli' && isPositionsDoc(cliDoc)) return { view: 'trainer', source: 'cli', doc: cliDoc };
  if (isPositionsDoc(browserDoc)) return { view: 'trainer', source: 'browser', doc: browserDoc };
  return { view: 'start', offer: cliOffer(cliDoc) };
}

/**
 * Read the CLI's positions.json next to the page. Missing (404, a static host without it), unreadable or
 * not a positions document: null, never an error.
 * @param {typeof fetch} [fetchFn]
 * @param {string} [url]
 * @returns {Promise<any|null>}
 */
export async function loadCliDoc(fetchFn = globalThis.fetch, url = 'positions.json') {
  try {
    const resp = await fetchFn(url, { cache: 'no-store' });
    if (!resp.ok) return null;
    const doc = await resp.json();
    return isPositionsDoc(doc) ? doc : null;
  } catch {
    return null;
  }
}
