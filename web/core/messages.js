// Every user-facing error message of the browser app in one place (design §11: each risk gets a message
// with a next step). Pure: the app, the fetch worker and the tests all read the same wording.
//
// A message is {kind, text, hint, retry}: `text` says what happened, `hint` what to do next, and `retry`
// whether waiting and trying again can help (the app then offers or runs a retry countdown).

/** Error kinds the app can show. */
export const KINDS = /** @type {const} */ ([
  'offline', 'network', 'rate_limited', 'not_found', 'closed', 'no_games', 'http',
  'quota', 'storage_unavailable', 'engine_failed', 'no_decompression', 'no_compression', 'internal',
]);

/** @typedef {typeof KINDS[number]} Kind */
/** @typedef {{kind: Kind, text: string, hint: string, retry: boolean}} Message */

const PERF_NAMES = { bullet: 'bullet', blitz: 'blitz', rapid: 'rapid', classical: 'classical', correspondence: 'correspondence' };

/** "blitz, rapid or classical" @param {string[]} perfs */
export function perfList(perfs = ['blitz', 'rapid', 'classical']) {
  const names = perfs.map((p) => PERF_NAMES[p] ?? p);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : (names[0] ?? 'rated');
}

/**
 * The message for one error kind.
 * @param {string} kind  a Kind; anything else is treated as 'internal'
 * @param {{name?: string, perfs?: string[], status?: number, detail?: string}} [ctx]
 * @returns {Message}
 */
export function messageFor(kind, { name = '', perfs, status, detail = '' } = {}) {
  const who = name ? `“${name}”` : 'this name';
  switch (kind) {
    case 'offline':
      return { kind, retry: true, text: 'This device is offline.',
        hint: 'Connect to the internet, then press Start again. Games and training already stored here stay available.' };
    case 'network':
      return { kind, retry: true, text: 'Lichess could not be reached. Either the connection dropped or Lichess is asking us to slow down.',
        hint: 'Wait a minute, then try again. Games already downloaded are kept.' };
    case 'rate_limited':
      return { kind, retry: true, text: 'Lichess asked us to slow down.',
        hint: 'Wait a minute, then try again. Games already downloaded are kept.' };
    case 'not_found':
      return { kind, retry: false, text: `There is no Lichess player called ${who}.`,
        hint: 'Check the spelling: it is the name in your lichess.org profile address.' };
    case 'closed':
      return { kind, retry: false, text: `The Lichess account ${who} is closed.`,
        hint: 'Games of closed accounts cannot be downloaded. Try another name.' };
    case 'no_games':
      return { kind, retry: false, text: `${name || 'This player'} has no ${perfList(perfs)} games on Lichess.`,
        hint: 'The trainer only uses these time controls. Play a few such games, then press Start again.' };
    case 'http':
      return { kind, retry: true, text: `Lichess answered with an error${status ? ` (HTTP ${status})` : ''}.`,
        hint: 'Wait a minute, then try again. If it keeps happening, Lichess may be down: check lichess.org.' };
    case 'quota':
      return { kind, retry: false, text: 'The browser has no room left to store games and results for this page.',
        hint: 'Free some space on the device, or choose fewer games under Settings, then try again. Data → Export backup saves what is here.' };
    case 'storage_unavailable':
      return { kind, retry: false, text: 'This browser does not let the page store data (a private window, or site data is blocked).',
        hint: 'Open the page in a normal window, or allow site data for this page in the browser settings, then reload.' };
    case 'engine_failed':
      return { kind, retry: false, text: 'The chess engine could not start in this browser.',
        hint: 'Update the browser (Chrome, Edge, Firefox or Safari from the last few years can run it), or analyse on a computer and send the result here with Data → Send to phone.' };
    case 'no_decompression':
      return { kind, retry: false, text: 'This browser cannot read trainer links (Safari needs iOS 16.4 or newer).',
        hint: 'Update the browser, or export a backup on the other device and open it here with Data → Load a file.' };
    case 'no_compression':
      return { kind, retry: false, text: 'This browser cannot pack the analysis into a link.',
        hint: 'Export a backup instead and open it on the phone with Data → Load a file.' };
    default:
      return { kind: 'internal', retry: false, text: `Something went wrong${detail ? `: ${detail}` : '.'}`,
        hint: 'Reload the page and try again. Stored games and results are kept.' };
  }
}

/** Text and hint as one line. @param {Message} m */
export function messageText(m) {
  return `${m.text} ${m.hint}`;
}

/** The visible countdown of the automatic retry after a rate limit or an unreadable network error. */
export function retryCountdownText(kind, seconds) {
  const why = kind === 'rate_limited' ? 'Lichess asked us to slow down.' : 'Lichess could not be reached (it may be asking us to slow down).';
  return `${why} Trying again in ${Math.max(0, Math.ceil(seconds))} s…`;
}

/**
 * The kind of a thrown error (or a {kind} message from the fetch worker).
 * @param {any} err
 * @param {{online?: boolean, where?: 'storage'|'engine'|'lichess'|'link'}} [ctx]
 *   online: navigator.onLine; where: what was being done (opening IndexedDB, starting the engine, …)
 * @returns {Kind}
 */
export function classifyError(err, { online = true, where } = {}) {
  const name = err?.name ?? '';
  const text = String(err?.message ?? err ?? '');
  if (name === 'QuotaExceededError' || /quota/i.test(text)) return 'quota';
  if (typeof err?.kind === 'string') {
    if ((err.kind === 'network' || err.kind === 'offline') && !online) return 'offline';
    if (KINDS.includes(err.kind)) return err.kind;
  }
  if (/DecompressionStream/.test(text)) return 'no_decompression';
  if (/CompressionStream/.test(text)) return 'no_compression';
  if (where === 'storage' || /indexedDB/i.test(text) || name === 'InvalidStateError' || name === 'SecurityError') {
    if (where === 'storage' || name !== 'InvalidStateError') return 'storage_unavailable';
  }
  if (where === 'engine' || name === 'EngineAnalysisError' || /WebAssembly|wasm/i.test(text)) {
    if (!err?.stopped) return 'engine_failed';
  }
  if (where === 'lichess' && name === 'TypeError') return online ? 'network' : 'offline';
  return 'internal';
}
