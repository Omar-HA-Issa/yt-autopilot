// Content script — scraping, picking, overlay, playback monitoring.
console.log('[yt-autopilot] content script loaded', location.href);

// ─── Scraping ─────────────────────────────────────────────────────────────────

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
    if (!channelEl) continue; // skips sponsored cards
    const channel = channelEl.textContent.trim();

    candidates.push({ title, channel, videoId });
  }

  return candidates;
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

const RECENT_PICKS_MAX = 25;

function getRecentPicks() {
  return new Promise(resolve => {
    chrome.storage.local.get('recentPicks', ({ recentPicks }) => resolve(recentPicks || []));
  });
}

function addToRecentPicks(videoId) {
  return getRecentPicks().then(picks => {
    const updated = [videoId, ...picks.filter(id => id !== videoId)].slice(0, RECENT_PICKS_MAX);
    return new Promise(resolve => chrome.storage.local.set({ recentPicks: updated }, resolve));
  });
}

// ─── Pick logic ───────────────────────────────────────────────────────────────

async function pickNext() {
  const candidates = getCandidates();
  if (!candidates.length) {
    console.log('[yt-autopilot] no candidates on this page');
    return null;
  }

  const recentPicks = await getRecentPicks();
  const seen = new Set(recentPicks);
  const pool = candidates.filter(c => !seen.has(c.videoId));
  const finalPool = pool.length > 0 ? pool : candidates; // reset if all seen

  const pick = finalPool[Math.floor(Math.random() * finalPool.length)];
  await addToRecentPicks(pick.videoId);

  console.log(`[yt-autopilot] picked:`, pick, `| pool: ${finalPool.length}/${candidates.length}`);
  return pick;
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PICK_NEXT') {
    pickNext().then(pick => sendResponse({ pick }));
    return true; // keep channel open for async response
  }
});
