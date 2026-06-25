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

function getStored(key) {
  return new Promise(resolve => chrome.storage.local.get(key, data => resolve(data[key])));
}

function setStored(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

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
  let candidates = getCandidates();
  console.log('[yt-autopilot] getCandidates() returned', candidates.length, 'on', location.pathname);

  if (candidates.length) {
    // On a feed page — save the fresh pool for use on watch pages
    await setStored({ ytap_candidates: candidates });
  } else {
    // On a watch page — use the saved pool from the last feed visit
    candidates = (await getStored('ytap_candidates')) || [];
    console.log('[yt-autopilot] using stored candidates:', candidates.length);
  }

  if (!candidates.length) {
    console.log('[yt-autopilot] no candidates available');
    return null;
  }

  const recentPicks = await getRecentPicks();
  const seen = new Set(recentPicks);
  const pool = candidates.filter(c => !seen.has(c.videoId));
  const finalPool = pool.length > 0 ? pool : candidates; // reset if all seen

  const pick = finalPool[Math.floor(Math.random() * finalPool.length)];
  await addToRecentPicks(pick.videoId);

  console.log('[yt-autopilot] picked:', pick, '| pool:', finalPool.length, '/', candidates.length);
  return pick;
}

// ─── History helpers (Phase 3d) ───────────────────────────────────────────────

const HISTORY_MAX = 50;

async function pushToHistory(video) {
  if (!video?.videoId) return;
  const history = (await getStored('ytap_history')) || [];
  const updated = [video, ...history].slice(0, HISTORY_MAX);
  await setStored({ ytap_history: updated });
}

async function popFromHistory() {
  const history = (await getStored('ytap_history')) || [];
  if (!history.length) return null;
  const [prev, ...rest] = history;
  await setStored({ ytap_history: rest });
  return prev;
}

// ─── Overlay (Phase 3b/3c/3d) ────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function removeOverlay() {
  document.getElementById('ytap-overlay')?.remove();
}

async function injectOverlay(video) {
  removeOverlay();

  const current  = (await getStored('ytap_current')) || {};
  const history  = (await getStored('ytap_history')) || [];
  const hasHistory = history.length > 0;
  const videoStartTime = video.currentTime;

  const overlay = document.createElement('div');
  overlay.id = 'ytap-overlay';
  if (!video.paused) overlay.classList.add('playing');
  overlay.innerHTML = `
    <div class="ytap-top">
      <div class="ytap-visualizer">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
      <div class="ytap-meta">
        <div class="ytap-channel">${escapeHtml(current.channel || '')}</div>
        <div class="ytap-title">${escapeHtml(current.title || '')}</div>
      </div>
    </div>
    <div class="ytap-controls">
      <button id="ytap-back" ${hasHistory ? '' : 'disabled'}>&#9664; Back</button>
      <button id="ytap-pause">${video.paused ? '&#9654; Play' : '&#10074;&#10074; Pause'}</button>
      <button id="ytap-skip">Skip &#9654;&#9654;</button>
    </div>
  `;

  document.body.appendChild(overlay);

  const pauseBtn = overlay.querySelector('#ytap-pause');
  const backBtn  = overlay.querySelector('#ytap-back');

  pauseBtn.addEventListener('click', () => {
    video.paused ? video.play() : video.pause();
  });

  video.addEventListener('pause', () => { pauseBtn.innerHTML = '&#9654; Play';           overlay.classList.remove('playing'); });
  video.addEventListener('play',  () => { pauseBtn.innerHTML = '&#10074;&#10074; Pause'; overlay.classList.add('playing'); });

  backBtn.addEventListener('click', async () => {
    const prev = await popFromHistory();
    if (prev) {
      await setStored({ ytap_current: prev });
      window.location.href = `https://www.youtube.com/watch?v=${prev.videoId}`;
    }
  });

  overlay.querySelector('#ytap-skip').addEventListener('click', async () => {
    const elapsed = video.currentTime - videoStartTime;
    await setStored({ ytap_last_skip_elapsed: elapsed });
    console.log('[yt-autopilot] skip clicked after', Math.round(elapsed), 's');
    await pushToHistory(current);
    const pick = await pickNext();
    if (pick) {
      await setStored({ ytap_current: pick });
      window.location.href = `https://www.youtube.com/watch?v=${pick.videoId}`;
    }
  });
}

// Remove overlay when Stop is clicked in the popup
chrome.storage.onChanged.addListener((changes) => {
  if (changes.running && !changes.running.newValue) removeOverlay();
});

// ─── Autoplay loop (Phase 3a) ─────────────────────────────────────────────────

function waitForVideo(timeoutMs = 8000) {
  return new Promise(resolve => {
    const v = document.querySelector('video');
    if (v && v.readyState >= 1) return resolve(v);

    const start = Date.now();
    const poll = setInterval(() => {
      const found = document.querySelector('video');
      if (found && found.readyState >= 1) {
        clearInterval(poll);
        resolve(found);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        console.log('[yt-autopilot] waitForVideo timed out');
        resolve(null);
      }
    }, 150);
  });
}

let autoplayActive = false;
let autoplayInitUrl = '';

function waitForAdToFinish() {
  return new Promise(resolve => {
    const player = document.querySelector('#movie_player');
    if (!player || !player.classList.contains('ad-showing')) return resolve();

    console.log('[yt-autopilot] post-roll ad detected, waiting for it to finish');
    const observer = new MutationObserver(() => {
      if (!player.classList.contains('ad-showing')) {
        observer.disconnect();
        console.log('[yt-autopilot] post-roll ad finished');
        resolve();
      }
    });
    observer.observe(player, { attributes: true, attributeFilter: ['class'] });
  });
}

async function onVideoEnded() {
  console.log('[yt-autopilot] video ended, picking next');
  if (!chrome.runtime?.id) { console.log('[yt-autopilot] extension context lost — refresh the tab'); return; }
  const running = await getStored('running');
  if (!running) { console.log('[yt-autopilot] DJ stopped, not advancing'); return; }

  // Give YouTube ~400ms to start a post-roll ad before we check
  await new Promise(r => setTimeout(r, 400));
  await waitForAdToFinish();

  const current = (await getStored('ytap_current')) || {};
  await pushToHistory(current);

  const pick = await pickNext();
  if (pick) {
    await setStored({ ytap_current: pick });
    console.log('[yt-autopilot] navigating to', pick.videoId);
    window.location.href = `https://www.youtube.com/watch?v=${pick.videoId}`;
  }
}

async function initAutoplay() {
  const url = location.href;
  if (url === autoplayInitUrl) { console.log('[yt-autopilot] initAutoplay: already armed for this URL, skip'); return; }
  if (autoplayActive) { console.log('[yt-autopilot] initAutoplay: init in progress, skip'); return; }
  if (location.pathname !== '/watch') { console.log('[yt-autopilot] initAutoplay: not a watch page, skip'); return; }

  const running = await getStored('running');
  if (!running) { console.log('[yt-autopilot] initAutoplay: DJ not running, skip'); return; }

  console.log('[yt-autopilot] initAutoplay: starting on', url);
  autoplayActive = true;
  autoplayInitUrl = url;

  const video = await waitForVideo();
  if (!video) {
    autoplayActive = false;
    autoplayInitUrl = '';
    return;
  }

  console.log('[yt-autopilot] got video element, triggering play');
  video.play().catch(err => console.log('[yt-autopilot] play() blocked:', err.message));
  video.addEventListener('ended', onVideoEnded, { once: true });
  await injectOverlay(video);
  console.log('[yt-autopilot] autoplay loop armed');
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PICK_NEXT') {
    console.log('[yt-autopilot] PICK_NEXT received');
    pickNext().then(async pick => {
      sendResponse({ pick }); // respond before navigating so the channel doesn't error
      if (pick) {
        await setStored({ ytap_current: pick });
        console.log('[yt-autopilot] navigating to first pick:', pick.videoId);
        window.location.href = `https://www.youtube.com/watch?v=${pick.videoId}`;
      }
    }).catch(err => {
      console.error('[yt-autopilot] PICK_NEXT error:', err);
      sendResponse({ pick: null });
    });
    return true; // keep channel open for async response
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

initAutoplay();

// Re-init after YouTube SPA navigation — only when the URL actually changed
document.addEventListener('yt-navigate-finish', () => {
  const url = location.href;
  console.log('[yt-autopilot] yt-navigate-finish', url);
  if (url === autoplayInitUrl) { console.log('[yt-autopilot] same URL, skipping re-init'); return; }
  autoplayActive = false;
  initAutoplay();
});
