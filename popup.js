// Popup — Start/Stop control only.
const btn = document.getElementById('toggleBtn');

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
        // Start DJ in this tab — clear stale state first
        chrome.storage.local.remove(['recentPicks', 'ytap_current_segment'], () => {
          chrome.storage.local.set({ running: true, djTabId: tabId }, () => {
            chrome.tabs.sendMessage(tabId, { type: 'PICK_NEXT' }, () => {
              void chrome.runtime.lastError;
              window.close();
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
