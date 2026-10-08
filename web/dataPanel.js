// "Data" panel (slice 8): storage state, backup export, "Load analysis file" (picker and drag-and-drop,
// backup or the CLI's positions.json) and "Send to phone" (link + QR code). The formats live in
// core/backup.js and core/transfer.js, the IndexedDB side in store/backupStore.js.
import { ImportError, MAX_FILE_BYTES, backupFileName, describeFile, formatBytes, readAnalysisFile } from './core/backup.js';
import { classifyError, messageFor, messageText } from './core/messages.js';
import { qrSvg } from './core/qr.js';
import { compressionSupported, planTransfer } from './core/transfer.js';
import { applyImport, collectBackup, existingOf, readStats } from './store/backupStore.js';
import { requestPersistence, storageInfo } from './store/db.js';

/**
 * @param {{db: IDBDatabase, storage: Storage, current: () => any, onImported: (r: import('./store/backupStore.js').ImportResult) => void,
 *   note: (type: string, extra?: object) => void, busy: () => boolean}} deps
 *   current(): the positions document on screen, or null; busy(): an analysis is running (no imports then)
 */
export function mountDataPanel({ db, storage, current, onImported, note, busy }) {
  const $ = (id) => document.getElementById(id);
  const panel = $('data');
  /** @type {{text: string, file: import('./core/backup.js').AnalysisFile}|null} */
  let pending = null;
  let backups = { small: null, full: null }; // built on open: the sizes shown are the real file sizes

  // ---------- storage ----------

  async function renderStorage() {
    const info = await storageInfo();
    const el = $('storage-state');
    el.classList.toggle('good', info.persisted === true);
    if (!info.supported) {
      el.textContent = 'This page cannot ask for permanent storage here (it needs a secure https:// address). The browser may clear this data; keep a backup.';
    } else if (info.persisted) {
      el.textContent = 'Stored permanently: the browser will not clear this data on its own.';
    } else {
      el.textContent = 'The browser may clear this data when space runs short (Safari: after 7 days without a visit). Keep a backup.';
    }
    $('keep').hidden = !info.supported || info.persisted === true;
    $('storage-usage').textContent = info.usage === null ? ''
      : `This site uses ${formatBytes(info.usage)}${info.quota ? ` of ${formatBytes(info.quota)} available` : ''}.`;
    return info;
  }

  // ---------- export ----------

  async function renderExport() {
    const doc = current();
    $('export-section').hidden = !doc;
    $('send-section').hidden = !doc;
    $('nothing').hidden = !!doc;
    if (!doc) return;
    $('backup-user').textContent = `${doc.user}: ${doc.positions.length} positions, stats for ${Object.keys(readStats(storage, doc.user)).length} of them.`;
    $('size-small').textContent = $('size-full').textContent = '…';
    backups = { small: null, full: null };
    for (const kind of /** @type {const} */ (['small', 'full'])) {
      const b = await collectBackup(db, storage, doc, kind);
      const text = JSON.stringify(b);
      backups[kind] = { text, user: doc.user };
      const extra = kind === 'full' ? `, ${b.games.length} games, ${b.evals.length} engine results` : '';
      $(`size-${kind}`).textContent = `(${formatBytes(new TextEncoder().encode(text).length)}${extra})`;
    }
  }

  async function exportBackup() {
    const kind = /** @type {'small'|'full'} */ (panel.querySelector('input[name="backup-kind"]:checked')?.value ?? 'small');
    const doc = current();
    if (!doc) return;
    if (!backups[kind] || backups[kind].user !== doc.user) {
      const b = await collectBackup(db, storage, doc, kind);
      backups[kind] = { text: JSON.stringify(b), user: doc.user };
    }
    const name = backupFileName(doc.user);
    const url = URL.createObjectURL(new Blob([backups[kind].text], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    $('export-done').textContent = `Saved ${name} (${formatBytes(new TextEncoder().encode(backups[kind].text).length)}). Keep it somewhere safe, or open it on another device with “Load a file”.`;
    $('export-done').hidden = false;
    note('export', { kind, name, bytes: backups[kind].text.length });
  }

  // ---------- import ----------

  function showImportError(text) {
    $('import-error').textContent = text;
    $('import-error').hidden = !text;
    if (text) {
      $('import-confirm').hidden = true;
      $('import-done').hidden = true;
      note('import-error', { message: text });
    }
  }

  /** @param {File} file */
  async function readFile(file) {
    showImportError('');
    $('import-done').hidden = true;
    pending = null;
    try {
      if (file.size > MAX_FILE_BYTES) throw new ImportError(`The file is too large (${formatBytes(file.size)}); a trainer backup is a few MB at most.`);
      const text = await file.text();
      const parsed = readAnalysisFile(text);
      pending = { text, file: parsed };
      const have = await existingOf(db, storage, parsed.user);
      $('import-summary').textContent = `${file.name}: ${describeFile(parsed)}`;
      const exists = !!have.doc || have.stats > 0;
      $('import-existing').textContent = exists
        ? `This browser already has ${parsed.user}: ${have.doc ? `${have.doc.positions.length} positions` : 'no analysis'}, stats for ${have.stats} positions. `
          + '“Merge” keeps the newer analysis and, per position, the stats with more tries. “Replace” overwrites them with the file.'
        : `Nothing of ${parsed.user} is stored in this browser yet.`;
      $('import-merge').hidden = !exists;
      $('import-replace').textContent = exists ? 'Replace' : 'Import';
      $('import-replace').classList.toggle('primary', !exists);
      $('import-confirm').hidden = false;
      note('import-read', { name: file.name, type: parsed.type, user: parsed.user, exists });
    } catch (err) {
      showImportError(err instanceof ImportError ? err.message : `The file could not be read (${err?.message ?? err}).`);
    }
  }

  /** @param {'merge'|'replace'} mode */
  async function confirmImport(mode) {
    if (!pending) return;
    if (busy()) {
      showImportError('An analysis is running. Stop it first, then import the file.');
      return;
    }
    const { file } = pending;
    pending = null;
    $('import-confirm').hidden = true;
    try {
      const incoming = file.type === 'backup' ? { kind: 'backup', backup: file.backup } : { kind: 'positions', doc: file.doc };
      const result = await applyImport(db, storage, /** @type {any} */ (incoming), mode);
      const what = result.doc ? `${result.doc.positions.length} positions` : 'no analysis';
      $('import-done').textContent = `Imported ${result.user}: ${what}${result.keptExisting ? ' (this browser’s analysis was newer and stays)' : ''}`
        + `, stats for ${result.stats} positions${result.games ? `, ${result.games} games` : ''}.`;
      $('import-done').hidden = false;
      note('import-done', { mode, user: result.user, positions: result.doc?.positions.length ?? 0, stats: result.stats, games: result.games, keptExisting: result.keptExisting });
      requestPersistence().then(renderStorage);
      onImported(result);
    } catch (err) {
      console.error(err);
      const kind = classifyError(err);
      showImportError(kind === 'quota' || kind === 'storage_unavailable'
        ? `${messageText(messageFor(kind))} Nothing was changed.`
        : `The import failed (${err?.message ?? err}). Nothing was changed.`);
    }
  }

  // ---------- send to phone ----------

  async function sendToPhone() {
    const doc = current();
    if (!doc) return;
    const result = $('send-result');
    if (!compressionSupported()) {
      $('send-error').textContent = messageText(messageFor('no_compression'));
      $('send-error').hidden = false;
      return;
    }
    $('send-error').hidden = true;
    $('send-phone').disabled = true;
    try {
      const base = location.origin + location.pathname;
      const plan = await planTransfer(doc, readStats(storage, doc.user), base);
      app().transfer = plan; // for the headless checks
      result.hidden = false;
      const qr = $('qr');
      if (plan.qr) {
        qr.innerHTML = qrSvg(plan.qr.url, `QR code with ${plan.qr.positions} positions of ${doc.user}`);
        $('qr-note').textContent = plan.qr.positions === plan.total
          ? `Scan with the phone camera: all ${plan.total} positions and your stats.`
          : `Scan with the phone camera: the top ${plan.qr.positions} of ${plan.total} positions and their stats (a QR code holds about 3 KB).`;
      } else {
        qr.replaceChildren();
        $('qr-note').textContent = 'Too much for a QR code: send yourself the link instead.';
      }
      qr.hidden = !plan.qr;
      fitQr();
      $('send-link').value = plan.link?.url ?? '';
      $('link-row').hidden = !plan.link;
      const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
      $('link-note').textContent = (plan.link
        ? `The link holds ${plan.link.positions === plan.total ? `all ${plan.total}` : `the top ${plan.link.positions} of ${plan.total}`} positions`
          + ` (${formatBytes(plan.link.bytes)}). Copy it and send it to yourself (e-mail, WhatsApp, a notes app), then open it on the phone.`
        : 'The analysis is too large for a link; export a backup and open it on the phone with “Load a file”.')
        + (local ? ` Note: this page runs on ${location.hostname}, which the phone cannot reach; use the published trainer for real transfers.` : '');
      note('send', { total: plan.total, qr: plan.qr && { positions: plan.qr.positions, bytes: plan.qr.bytes }, link: plan.link && { positions: plan.link.positions, bytes: plan.link.bytes } });
    } catch (err) {
      console.error(err);
      $('send-error').textContent = `The link could not be created (${err?.message ?? err}).`;
      $('send-error').hidden = false;
    } finally {
      $('send-phone').disabled = false;
    }
  }

  async function copyLink() {
    const input = $('send-link');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select(); // no clipboard API (insecure origin): the old way
      document.execCommand?.('copy');
    }
    $('copy-link').textContent = 'Copied';
    setTimeout(() => { $('copy-link').textContent = 'Copy'; }, 1500);
  }

  // ---------- open / close, wiring ----------

  const app = () => /** @type {any} */ (window).app;

  /**
   * Whole device pixels per module: a QR code scaled by a fraction gets uneven modules, which scanners
   * misread at version 40 (checked with jsQR on screenshots). The largest size that fits the box.
   */
  function fitQr() {
    const svg = $('qr').querySelector('svg');
    if (!svg) return;
    const units = svg.viewBox.baseVal.width; // modules + quiet zone
    const dpr = window.devicePixelRatio || 1;
    const perModule = Math.max(1, Math.floor(($('qr').clientWidth * dpr) / units));
    svg.style.width = `${(perModule * units) / dpr}px`;
  }
  window.addEventListener('resize', fitQr);

  async function open() {
    panel.hidden = false;
    $('send-result').hidden = true;
    $('export-done').hidden = true;
    await Promise.all([renderStorage(), renderExport()]);
  }

  function close() {
    panel.hidden = true;
    pending = null;
    $('import-confirm').hidden = true;
  }

  $('data-close').addEventListener('click', close);
  $('keep').addEventListener('click', async () => {
    const granted = await requestPersistence();
    note('persist', { granted, from: 'button' });
    await renderStorage();
  });
  $('export').addEventListener('click', exportBackup);
  $('file-input').addEventListener('change', (ev) => {
    const file = /** @type {HTMLInputElement} */ (ev.target).files?.[0];
    if (file) readFile(file);
    /** @type {HTMLInputElement} */ (ev.target).value = '';
  });
  $('import-merge').addEventListener('click', () => confirmImport('merge'));
  $('import-replace').addEventListener('click', () => confirmImport('replace'));
  $('import-cancel').addEventListener('click', () => {
    pending = null;
    $('import-confirm').hidden = true;
  });
  $('send-phone').addEventListener('click', sendToPhone);
  $('copy-link').addEventListener('click', copyLink);

  // Drag-and-drop anywhere on the page: the panel opens with the file.
  const hasFiles = (ev) => [...(ev.dataTransfer?.types ?? [])].includes('Files');
  document.addEventListener('dragover', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', (ev) => {
    if (!ev.relatedTarget) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', async (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    document.body.classList.remove('dragging');
    const file = ev.dataTransfer.files?.[0];
    if (!file) return;
    if (panel.hidden) await open();
    panel.scrollIntoView({ block: 'start' });
    readFile(file);
  });

  return { open, close, renderStorage, get isOpen() { return !panel.hidden; } };
}
