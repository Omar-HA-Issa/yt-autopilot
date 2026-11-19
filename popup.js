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
    ['ytap_channel_scores', 'ytap_taste_anchors', 'ytap_total_completions',
     'ytap_clusters', 'ytap_watched', 'recentPicks'],
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
      el.textContent = `Still learning. Open your subscriptions or home feed for a moment, then start.`;
      el.style.display = 'block';
    }
  });
})();

// ── Start / Stop ──────────────────────────────────────────────────────────────
// Starting the DJ has three possible paths, in order of likelihood:
//   1. Active tab is already on YouTube and its content script is live —
//      sendMessage succeeds, we mark running immediately.
//   2. Active tab isn't on YouTube at all — navigate it there; content.js
//      picks up ytap_pending_start once the resulting page load injects it.
//   3. Active tab IS YouTube but sendMessage fails (content script missing —
//      e.g. the tab predates installing/reloading the extension) — reload it;
//      same ytap_pending_start pickup once it re-injects.
// `running` is only ever set true once a start has actually been delivered —
// either here after a successful sendMessage, or by content.js itself when it
// consumes ytap_pending_start. It's never set preemptively.

function isYouTubeUrl(url) {
  try { return new URL(url).hostname === 'www.youtube.com'; }
  catch { return false; }
}

// Decays channel scores toward neutral and clears any leftover segment from
// a previous session, then hands off to the actual delivery attempt.
function beginDjStart(tabId, isYouTubeTab) {
  chrome.storage.local.remove(['ytap_current_segment'], () => {
    chrome.storage.local.get('ytap_channel_scores', ({ ytap_channel_scores }) => {
      const scores  = ytap_channel_scores || {};
      const decayed = Object.fromEntries(
        Object.entries(scores).map(([ch, s]) => [ch, 0.5 + (s - 0.5) * 0.9])
      );
      chrome.storage.local.set({ ytap_channel_scores: decayed }, () => {
        if (!isYouTubeTab) {
          chrome.storage.local.set(
            { djTabId: tabId, ytap_pending_start: true },
            () => chrome.tabs.update(tabId, { url: 'https://www.youtube.com/' }, () => window.close())
          );
          return;
        }

        chrome.tabs.sendMessage(tabId, { type: 'PICK_NEXT' }, () => {
          if (chrome.runtime.lastError) {
            chrome.storage.local.set(
              { djTabId: tabId, ytap_pending_start: true },
              () => chrome.tabs.reload(tabId, () => window.close())
            );
            return;
          }
          chrome.storage.local.set({ running: true, djTabId: tabId }, () => window.close());
        });
      });
    });
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const tabId = tab.id;

  chrome.storage.local.get(['running', 'djTabId'], ({ running, djTabId }) => {
    updateUI(running && djTabId === tabId);
  });

  btn.addEventListener('click', () => {
    chrome.storage.local.get(['running', 'djTabId'], ({ running, djTabId }) => {
      const isDJHere = running && djTabId === tabId;

      if (!isDJHere) {
        beginDjStart(tabId, isYouTubeUrl(tab.url));
      } else {
        chrome.storage.local.set({ running: false });
        chrome.storage.local.remove('djTabId');
        window.close();
      }
    });
  });
});
