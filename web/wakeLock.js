// Screen Wake Lock while an analysis runs (design §11, mobile): phones dim and lock the screen, and a
// locked phone freezes the page. The browser drops the lock whenever the page is hidden, so it is asked
// for again on `visibilitychange` as long as it is wanted. Where the API is missing (older Safari,
// Firefox before 126, some headless browsers) everything here is a no-op and `supported` is false.

/**
 * @param {{nav?: Navigator, doc?: Document, onChange?: (state: 'acquired'|'released'|'failed'|'unsupported', err?: any) => void}} [opts]
 */
export function createWakeLock({ nav = globalThis.navigator, doc = globalThis.document, onChange = () => {} } = {}) {
  const api = /** @type {any} */ (nav)?.wakeLock;
  let wanted = false;
  /** @type {any} */
  let sentinel = null;
  let asking = null;

  async function acquire() {
    if (!wanted || sentinel || asking || doc.visibilityState !== 'visible') return;
    if (!api?.request) {
      onChange('unsupported');
      return;
    }
    asking = (async () => {
      try {
        const s = await api.request('screen');
        if (!wanted) {
          await s.release();
          return;
        }
        sentinel = s;
        s.addEventListener?.('release', () => {
          if (sentinel === s) sentinel = null;
          onChange('released');
        });
        onChange('acquired');
      } catch (err) {
        onChange('failed', err); // e.g. battery saver, or the page is not visible
      }
    })();
    try { await asking; } finally { asking = null; }
  }

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') acquire();
  });

  return {
    supported: !!api?.request,
    get held() { return !!sentinel; },
    /** Keep the screen on from now on (again after the page was hidden). */
    async hold() {
      wanted = true;
      await acquire();
    },
    /** Let the screen sleep again. */
    async release() {
      wanted = false;
      const s = sentinel;
      sentinel = null;
      if (s) {
        try { await s.release(); } catch { /* already released */ }
      }
    },
  };
}
