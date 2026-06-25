// Service worker — message relay between popup and content script.
// Content scripts have no direct way to read their own tab ID; they ask us.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_TAB_ID') {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return false;
  }
});

// Reset DJ state on every browser start so the popup always opens showing "Start DJ"
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ running: false });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ running: false });
});
