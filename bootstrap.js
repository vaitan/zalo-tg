// Bootstrap to patch ws to avoid ERR_UNHANDLED_ERROR when an 'error' event
// is emitted without any listeners. This file must run before any module
// that constructs WebSocket instances (e.g., zca-js). Run this as the
// process entrypoint (update package.json start script to `node bootstrap.js`).

import ws from 'ws';

const origEmit = ws.prototype.emit;
ws.prototype.emit = function (event: string, ...args: any[]) {
  try {
    if (event === 'error') {
      // If there are no listeners for 'error', swallow and log to avoid
      // Node throwing ERR_UNHANDLED_ERROR which would otherwise crash the
      // process. We still return false to indicate the event wasn't handled.
      if (typeof this.listenerCount === 'function' && this.listenerCount('error') === 0) {
        // Log minimal info to help debugging but don't throw
        try { console.warn('[Bootstrap] Swallowed WS error (no listeners):', args[0]); } catch { /* ignore */ }
        return false;
      }
    }
  } catch (err) {
    // If anything goes wrong in the patch, fallback to original emit
    return origEmit.call(this, event, ...args);
  }
  return origEmit.call(this, event, ...args);
};

// Finally, import the real application entrypoint
import('./dist/index.js').catch((err) => {
  console.error('[Bootstrap] Failed to load app entry:', err);
  process.exit(1);
});
