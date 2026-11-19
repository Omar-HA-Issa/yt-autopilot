// Service worker — tab ID relay + embedding coordinator.
// Embedding runs in offscreen.js (full window context) via a named port.

let offscreenPort = null;
const pending = new Map(); // requestId → sendResponse

// Offscreen document connects here on load.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen-embedder') return;
  offscreenPort = port;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'EMBED_AND_STORE_RESULT') {
      const embMap = msg.embeddings; // { videoId: number[] }
      const stored = await chrome.storage.local.get('ytap_candidates');
      const candidates = stored.ytap_candidates || [];
      const updated = candidates.map(c =>
        embMap[c.videoId] ? { ...c, embedding: embMap[c.videoId] } : c
      );
      await chrome.storage.local.set({ ytap_candidates: updated });
      console.log('[yt-autopilot] stored embeddings for', Object.keys(embMap).length, 'candidates');
      return;
    }
    const cb = pending.get(msg.id);
    if (!cb) return;
    pending.delete(msg.id);
    if (msg.type === 'EMBED_ERROR') cb({ error: msg.error });
    else cb({ embeddings: msg.embeddings });
  });

  port.onDisconnect.addListener(() => { offscreenPort = null; });
});

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['BLOBS'],
    justification: 'Run transformers.js ML model which requires URL.createObjectURL',
  });
}

async function waitForPort(timeoutMs = 5000) {
  if (offscreenPort) return;
  await new Promise((resolve) => {
    const poll = setInterval(() => { if (offscreenPort) { clearInterval(poll); resolve(); } }, 50);
    setTimeout(() => { clearInterval(poll); resolve(); }, timeoutMs);
  });
}

async function routeToOffscreen(msg) {
  await ensureOffscreen();
  await waitForPort();
  if (!offscreenPort) throw new Error('offscreen did not connect in time');
  offscreenPort.postMessage(msg);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_TAB_ID') {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return false;
  }

  if (msg.type === 'EMBED_AND_STORE') {
    // Respond immediately — offscreen writes embeddings to storage directly.
    sendResponse();
    routeToOffscreen({ type: 'EMBED_AND_STORE', candidates: msg.candidates })
      .catch(err => console.error('[yt-autopilot] EMBED_AND_STORE failed:', err.message));
    return false;
  }

  if (msg.type === 'EMBED') {
    const id = Math.random().toString(36).slice(2);
    pending.set(id, sendResponse);
    routeToOffscreen({ type: 'EMBED', texts: msg.texts, id })
      .catch(err => { pending.delete(id); sendResponse({ error: err.message }); });
    return true; // keep channel open for async response
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ running: false, djTabId: null, ytap_pending_start: false });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ running: false, djTabId: null, ytap_pending_start: false });
});
