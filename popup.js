// Popup — Start/Stop control + taste reset.
const btn = document.getElementById('toggleBtn');

document.getElementById('resetBtn').addEventListener('click', () => {
  chrome.storage.local.remove(['ytap_channel_scores', 'ytap_taste_vector', 'ytap_candidates'], () => {
    window.close();
  });
});

// Wrap everything in the tab query so tabId is always known before we wire the button.
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const tabId = tab.id;

  chrome.storage.local.get(['running', 'djTabId'], ({ running, djTabId }) => {
    const isDJHere = running && djTabId === tabId;
    btn.textContent = isDJHere ? 'Stop DJ' : 'Start DJ';
    btn.className   = isDJHere ? 'stop'    : 'start';
  });

  btn.addEventListener('click', () => {
    chrome.storage.local.get(['running', 'djTabId'], ({ running, djTabId }) => {
      const isDJHere = running && djTabId === tabId;

      if (!isDJHere) {
        // Start DJ — clear session state, gently decay channel scores toward neutral
        chrome.storage.local.remove(['recentPicks', 'ytap_current_segment'], () => {
          chrome.storage.local.get('ytap_channel_scores', ({ ytap_channel_scores }) => {
            const scores = ytap_channel_scores || {};
            const decayed = Object.fromEntries(
              Object.entries(scores).map(([ch, s]) => [ch, 0.5 + (s - 0.5) * 0.9])
            );
            chrome.storage.local.set({ ytap_channel_scores: decayed, running: true, djTabId: tabId }, () => {
              chrome.tabs.sendMessage(tabId, { type: 'PICK_NEXT' }, () => {
                void chrome.runtime.lastError;
                window.close();
              });
            });
          });
        });
      } else {
        // Stop DJ
        chrome.storage.local.set({ running: false });
        chrome.storage.local.remove('djTabId');
        window.close();
      }
    });
  });
});
