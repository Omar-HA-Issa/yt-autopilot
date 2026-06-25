// Popup — Start/Stop control only.
const btn = document.getElementById('toggleBtn');

chrome.storage.local.get('running', ({ running }) => {
  btn.textContent = running ? 'Stop' : 'Start';
});

btn.addEventListener('click', () => {
  chrome.storage.local.get('running', ({ running }) => {
    const next = !running;
    chrome.storage.local.set({ running: next });
    btn.textContent = next ? 'Stop' : 'Start';

    if (next) {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        chrome.tabs.sendMessage(tab.id, { type: 'PICK_NEXT' }, () => void chrome.runtime.lastError);
      });
    }
  });
});
