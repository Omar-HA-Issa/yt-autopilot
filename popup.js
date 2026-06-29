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
    ['ytap_channel_scores', 'ytap_taste_vectors', 'ytap_taste_watch_counts',
     'ytap_candidates', 'ytap_last_segment_topic'],
    () => window.close()
  );
});

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
          ['recentPicks', 'ytap_current_segment', 'ytap_last_segment_topic'],
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
