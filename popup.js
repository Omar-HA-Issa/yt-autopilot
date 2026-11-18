// ── UI state ──────────────────────────────────────────────────────────────────

const btn       = document.getElementById('toggleBtn');
const statusDot = document.getElementById('statusDot');

function updateUI(isActive) {
  btn.textContent = isActive ? 'Stop DJ' : 'Start DJ';
  btn.className   = isActive ? 'stop'    : 'start';
  statusDot.classList.toggle('active', isActive);
}

// ── Reset taste profile ───────────────────────────────────────────────────────

document.getElementById('resetBtn').addEventListener('click', () => {
  chrome.storage.local.remove(
    ['ytap_channel_scores', 'ytap_taste_anchors', 'ytap_total_completions'],
    () => window.close()
  );
});

// ── Pool health check ─────────────────────────────────────────────────────────
// v2 needs ≥ CLUSTER_K × SEGMENT_SIZE (≈30) embedded candidates for ≥2 eligible
// clusters. Below that, pickNextNew() burns a few extra seconds on a direct
// embed-and-retry before falling back to a lightweight channel/view-based pick
// — surface the thin pool here instead of letting that happen silently.

(function checkPool() {
  const POOL_WARN_THRESHOLD = 30;
  chrome.storage.local.get('ytap_candidates', ({ ytap_candidates }) => {
    const embedded = (ytap_candidates || []).filter(c => c.embedding).length;
    if (embedded < POOL_WARN_THRESHOLD) {
      const el = document.getElementById('poolWarning');
      el.textContent = `Pool thin (${embedded} ready). Scroll your subscriptions feed first.`;
      el.style.display = 'block';
    }
  });
})();

// ── Start / Stop ──────────────────────────────────────────────────────────────

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const tabId = tab.id;

  chrome.storage.local.get(['running', 'djTabId'], ({ running, djTabId }) => {
    updateUI(running && djTabId === tabId);
  });

  btn.addEventListener('click', () => {
    chrome.storage.local.get(['running', 'djTabId'], ({ running, djTabId }) => {
      const isDJHere = running && djTabId === tabId;

      if (!isDJHere) {
        chrome.storage.local.remove(
          ['ytap_current_segment'],
          () => {
            chrome.storage.local.get('ytap_channel_scores', ({ ytap_channel_scores }) => {
              const scores  = ytap_channel_scores || {};
              const decayed = Object.fromEntries(
                Object.entries(scores).map(([ch, s]) => [ch, 0.5 + (s - 0.5) * 0.9])
              );
              chrome.storage.local.set(
                { ytap_channel_scores: decayed, running: true, djTabId: tabId },
                () => {
                  chrome.tabs.sendMessage(tabId, { type: 'PICK_NEXT' }, () => {
                    void chrome.runtime.lastError;
                    window.close();
                  });
                }
              );
            });
          }
        );
      } else {
        chrome.storage.local.set({ running: false });
        chrome.storage.local.remove('djTabId');
        window.close();
      }
    });
  });
});
