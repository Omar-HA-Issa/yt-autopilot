// Content script — scraping, picking, overlay, playback monitoring.
console.log('[yt-autopilot] content script loaded', location.href);

function getCandidates() {
  const cards = document.querySelectorAll('ytd-rich-item-renderer, ytd-video-renderer');
  const candidates = [];

  for (const card of cards) {
    const titleEl = card.querySelector('a.ytLockupMetadataViewModelTitle');
    if (!titleEl) continue;

    const match = (titleEl.href || '').match(/[?&]v=([^&]+)/);
    if (!match) continue;
    const videoId = match[1];

    const title = titleEl.textContent.trim();
    if (!title) continue;

    const channelEl = card.querySelector('a[href*="/@"]');
    if (!channelEl) continue; // skips sponsored cards which have no channel link
    const channel = channelEl.textContent.trim();

    candidates.push({ title, channel, videoId });
  }

  return candidates;
}

// Phase 1 verification — remove once scraping is confirmed working.
function waitForCandidates() {
  const titleSelector = 'a.ytLockupMetadataViewModelTitle';

  if (document.querySelector(titleSelector)) {
    console.log('[yt-autopilot] candidates:', getCandidates());
    return;
  }

  const observer = new MutationObserver(() => {
    if (document.querySelector(titleSelector)) {
      observer.disconnect();
      console.log('[yt-autopilot] candidates:', getCandidates());
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

waitForCandidates();
