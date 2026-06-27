// Content script — scraping, picking, overlay, playback monitoring.
console.log('[yt-autopilot] content script loaded', location.href);

// ─── Scraping ─────────────────────────────────────────────────────────────────

const MIN_DURATION_SEC = 300; // 5 minutes

const NEWS_PATTERNS = [
  'breaking news', 'breaking:', '| breaking', 'live news', 'live stream',
  '| live', 'watch live', 'live coverage', 'live update', 'news update',
  'press conference', 'full press', 'full speech', 'raw video',
];

function parseDuration(text) {
  if (!text) return null;
  const t = text.trim();
  if (t === 'LIVE' || t === 'SHORTS' || t === '') return null;
  const parts = t.split(':').map(Number);
  if (parts.length < 2 || parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function parseViews(text) {
  if (!text) return 0;
  const m = text.replace(/,/g, '').match(/([\d.]+)\s*([KMBkmb]?)\s*views?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const s = m[2].toUpperCase();
  if (s === 'B') return n * 1e9;
  if (s === 'M') return n * 1e6;
  if (s === 'K') return n * 1e3;
  return n;
}

const MIN_VIEWS_HARD = 20000; // absolute floor — filters out the truly niche

function getCandidates() {
  const cards = document.querySelectorAll(
    'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer'
  );
  const candidates = [];

  for (const card of cards) {
    // Feed pages use ytLockupMetadataViewModelTitle; sidebar uses a#video-title
    const titleEl = card.querySelector('a.ytLockupMetadataViewModelTitle') ||
                    card.querySelector('a#video-title[href*="watch?v="]');
    if (!titleEl) continue;

    const match = (titleEl.href || '').match(/[?&]v=([^&]+)/);
    if (!match) continue;
    const videoId = match[1];

    const title = titleEl.textContent.trim();
    if (!title) continue;

    const channelEl = card.querySelector('a[href*="/@"]');
    if (!channelEl) continue;
    const channel = channelEl.textContent.trim();

    // Skip live streams and shorts via overlay badge
    const overlayEl = card.querySelector('ytd-thumbnail-overlay-time-status-renderer');
    const overlayStyle = overlayEl?.getAttribute('overlay-style') || '';
    if (overlayStyle === 'LIVE' || overlayStyle === 'SHORTS') continue;

    // Skip short videos (< 5 min)
    const timeEl = card.querySelector('ytd-thumbnail-overlay-time-status-renderer yt-formatted-string') ||
                   card.querySelector('ytd-thumbnail-overlay-time-status-renderer span#text') ||
                   card.querySelector('ytd-thumbnail-overlay-time-status-renderer span');
    const duration = parseDuration(timeEl?.textContent);
    if (duration === null || duration < MIN_DURATION_SEC) continue;

    // Skip news-style titles
    const titleLower = title.toLowerCase();
    if (NEWS_PATTERNS.some(p => titleLower.includes(p))) continue;

    // Extract view count for weighting and hard filtering
    const viewEl = card.querySelector('#metadata-line span.inline-metadata-item') ||
                   card.querySelector('ytd-video-meta-block span');
    const views = parseViews(viewEl?.textContent);
    if (views < MIN_VIEWS_HARD) continue;

    candidates.push({ title, channel, videoId, views });
  }

  return candidates;
}

// ─── Tab identity ─────────────────────────────────────────────────────────────

function getMyTabId() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, res => {
      void chrome.runtime.lastError;
      resolve(res?.tabId ?? null);
    });
  });
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

// ─── Embedder (5a) ────────────────────────────────────────────────────────────
// Embedding runs in background.js (extension-origin service worker) to avoid
// YouTube's page CSP blocking Workers created from content script context.

async function embedTexts(texts, timeoutMs = 30000) {
  const embedPromise = new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'EMBED', texts }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (response?.error) return reject(new Error(response.error));
      resolve(response?.embeddings ?? null);
    });
  });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('embedTexts timeout')), timeoutMs)
  );
  return Promise.race([embedPromise, timeoutPromise])
    .catch(err => { console.warn('[yt-autopilot] embedTexts failed:', err.message); return null; });
}

// ─── Taste profile (5b) ───────────────────────────────────────────────────────

const EMBED_DIM   = 384;
const TASTE_ALPHA = 0.15; // higher than channel α — topical taste drifts faster

function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

async function updateTasteVector(embedding) {
  if (!embedding || embedding.length !== EMBED_DIM) return;
  const stored = (await getStored('ytap_taste_vector')) || new Array(EMBED_DIM).fill(0);
  const updated = stored.map((v, i) => v * (1 - TASTE_ALPHA) + embedding[i] * TASTE_ALPHA);
  const mag = Math.sqrt(updated.reduce((s, x) => s + x * x, 0));
  const normalized = mag > 0 ? updated.map(x => x / mag) : updated;
  await setStored({ ytap_taste_vector: normalized });
}

function blendedWeight(channelScore, embedding, tasteVector) {
  if (!tasteVector || !embedding) return channelScore;
  const simNorm = (cosineSim(embedding, tasteVector) + 1) / 2; // [-1,1] → [0,1]
  return 0.4 * channelScore + 0.6 * simNorm;
}

function embedCandidatesAsync(candidates) {
  // Fire and forget — offscreen document embeds and writes to storage directly.
  // No response expected so page navigation doesn't break anything.
  chrome.runtime.sendMessage({ type: 'EMBED_AND_STORE', candidates }, () => {
    void chrome.runtime.lastError;
  });
}

// ─── Segment logic (5c) ──────────────────────────────────────────────────────

const SEGMENT_SIZE  = 3;
const SIM_THRESHOLD = 0.2;

function formSegment(pool, scores, tasteVector) {
  const anchor = weightedPick(pool, scores, tasteVector);
  const segment = [anchor];
  const rest = pool.filter(c => c.videoId !== anchor.videoId);

  const withEmbed = rest.filter(c => c.embedding);
  if (anchor.embedding && withEmbed.length > 0) {
    const ranked = withEmbed
      .map(c => ({ ...c, _sim: cosineSim(c.embedding, anchor.embedding) }))
      .filter(c => c._sim >= SIM_THRESHOLD)
      .sort((a, b) => b._sim - a._sim);

    while (segment.length < SEGMENT_SIZE && ranked.length) {
      const next = ranked.shift();
      delete next._sim;
      segment.push(next);
    }
  }

  const topic = typeof YTAP_CLASSIFY !== 'undefined'
    ? YTAP_CLASSIFY(segment.map(c => c.title))
    : 'general';

  console.log('[yt-autopilot] formSegment topic:', topic, segment.map(v => v.title));
  return { topic, videos: segment };
}

async function willStartNewSegment() {
  const seg = await getStored('ytap_current_segment');
  return !seg || seg.segmentIndex >= seg.videos.length;
}

// ─── Pick logic ───────────────────────────────────────────────────────────────

async function pickNext() {
  // Drain the current segment before forming a new one.
  const seg = await getStored('ytap_current_segment');
  if (seg && seg.segmentIndex < seg.videos.length) {
    const pick = seg.videos[seg.segmentIndex];
    await setStored({ ytap_current_segment: { ...seg, segmentIndex: seg.segmentIndex + 1 } });
    console.log('[yt-autopilot] segment drain [', seg.segmentIndex + 1, '/', seg.videos.length, ']', seg.topic, pick.title);
    await addToRecentPicks(pick.videoId);
    return pick;
  }

  // Segment exhausted or none — build a new one.
  let candidates = getCandidates();

  if (!candidates.length && location.pathname !== '/watch') {
    for (let i = 0; i < 5 && !candidates.length; i++) {
      await new Promise(r => setTimeout(r, 800));
      candidates = getCandidates();
    }
  }

  console.log('[yt-autopilot] getCandidates() returned', candidates.length, 'on', location.pathname);

  if (candidates.length) {
    // Merge with stored pool — keep embeddings, drop stale no-views entries, cap at 100
    const prev = (await getStored('ytap_candidates')) || [];
    const prevById = Object.fromEntries(prev.map(c => [c.videoId, c]));
    const freshWithEmbed = candidates.map(c => ({ ...c, embedding: prevById[c.videoId]?.embedding }));
    const newIds = new Set(candidates.map(c => c.videoId));
    const retained = prev.filter(c => !newIds.has(c.videoId) && (c.views ?? 0) >= MIN_VIEWS_HARD);
    const merged = [...freshWithEmbed, ...retained].slice(0, 100);
    await setStored({ ytap_candidates: merged });
    embedCandidatesAsync(freshWithEmbed.filter(c => !c.embedding));
    candidates = merged;
  } else {
    const raw = (await getStored('ytap_candidates')) || [];
    candidates = raw.filter(c => (c.views ?? 0) >= MIN_VIEWS_HARD);
    console.log('[yt-autopilot] using stored candidates:', candidates.length, '(filtered from', raw.length, ')');
  }

  if (!candidates.length) {
    console.log('[yt-autopilot] no candidates available');
    return null;
  }

  let recentPicks = await getRecentPicks();
  let seen = new Set(recentPicks);
  let pool = candidates.filter(c => !seen.has(c.videoId));

  if (pool.length === 0) {
    // All candidates seen — keep only last 5 to avoid immediate repeats
    recentPicks = recentPicks.slice(0, 5);
    await setStored({ recentPicks });
    seen = new Set(recentPicks);
    pool = candidates.filter(c => !seen.has(c.videoId));
    console.log('[yt-autopilot] recentPicks reset — pool refreshed to', pool.length);
  }

  const finalPool = pool.length > 0 ? pool : candidates;

  const scores = (await getStored('ytap_channel_scores')) || {};
  const tasteVector = (await getStored('ytap_taste_vector')) || null;
  const newSeg = formSegment(finalPool, scores, tasteVector);

  // Save segment with index at 1 — returning index 0 now.
  await setStored({ ytap_current_segment: { ...newSeg, segmentIndex: 1 } });

  const pick = newSeg.videos[0];
  await addToRecentPicks(pick.videoId);
  console.log('[yt-autopilot] new segment:', newSeg.topic, '— first pick:', pick.title);
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

// ─── Channel scoring (Phase 4) ───────────────────────────────────────────────

async function updateChannelScore(channel, signal) {
  const α = 0.1;
  const scores = (await getStored('ytap_channel_scores')) || {};
  const prev = scores[channel] ?? 0.5;
  scores[channel] = prev * (1 - α) + signal * α;
  await setStored({ ytap_channel_scores: scores });
  console.log('[yt-autopilot] channel score update:', channel, prev.toFixed(3), '→', scores[channel].toFixed(3), '(signal', signal, ')');

  if (signal === 1.0) {
    const current = (await getStored('ytap_current')) || {};
    if (current.embedding) {
      await updateTasteVector(current.embedding);
      console.log('[yt-autopilot] taste vector updated from:', current.title);
    }
  }
}

function weightedPick(pool, scores, tasteVector) {
  // Log-normalize view counts across the pool so a 10M video isn't 10000x a 1K video
  const logViews = pool.map(c => Math.log10((c.views || 0) + 1));
  const maxLog = Math.max(...logViews);
  const minLog = Math.min(...logViews);
  const logRange = maxLog - minLog || 1;

  const weights = pool.map((c, i) => {
    const base = blendedWeight(scores[c.channel] ?? 0.5, c.embedding ?? null, tasteVector);
    const viewScore = (logViews[i] - minLog) / logRange;
    return 0.85 * base + 0.15 * viewScore;
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

// ─── Narration (Phase 5e) ─────────────────────────────────────────────────────

let _lastNarrationClip = null;

async function playNarration(topic) {
  if (typeof YTAP_NARRATION === 'undefined') return;
  const clips = YTAP_NARRATION[topic] || YTAP_NARRATION['general'];
  if (!clips?.length) return;

  const pool = clips.length > 1 ? clips.filter(c => c !== _lastNarrationClip) : clips;
  const clip = pool[Math.floor(Math.random() * pool.length)];
  _lastNarrationClip = clip;

  const audio = new Audio(chrome.runtime.getURL(`audio/${topic}/${clip}`));
  console.log('[yt-autopilot] narration:', topic, clip);

  await new Promise(resolve => {
    const timer = setTimeout(resolve, 8000);
    const done  = () => { clearTimeout(timer); resolve(); };
    audio.addEventListener('ended', done, { once: true });
    audio.addEventListener('error', done, { once: true });
    audio.play().catch(err => {
      console.log('[yt-autopilot] narration autoplay blocked:', err.message);
      clearTimeout(timer);
      resolve();
    });
  });
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
    console.log('[yt-autopilot] skip clicked after', Math.round(elapsed), 's');
    const watchPct = video.duration > 0 ? elapsed / video.duration : 0;
    const signal = watchPct >= 0.4 ? 1.0 : 0.0;
    await updateChannelScore(current.channel, signal);
    await pushToHistory(current);
    const pick = await pickNext();
    if (pick) {
      await setStored({ ytap_current: pick });
      window.location.href = `https://www.youtube.com/watch?v=${pick.videoId}`;
    }
  });
}

// Remove overlay when DJ stops or another tab claims the DJ
chrome.storage.onChanged.addListener((changes) => {
  if (changes.running && !changes.running.newValue) {
    removeOverlay();
    return;
  }
  if (changes.djTabId) {
    getMyTabId().then(myTabId => {
      if (changes.djTabId.newValue !== myTabId) removeOverlay();
    });
  }
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
  const [running, djTabId, myTabId] = await Promise.all([
    getStored('running'),
    getStored('djTabId'),
    getMyTabId(),
  ]);
  if (!running)            { console.log('[yt-autopilot] DJ stopped, not advancing'); return; }
  if (djTabId !== myTabId) { console.log('[yt-autopilot] not the DJ tab, not advancing'); return; }

  // Give YouTube ~400ms to start a post-roll ad before we check
  await new Promise(r => setTimeout(r, 400));
  await waitForAdToFinish();

  // Check segment state BEFORE pickNext() modifies it.
  const isSegmentBoundary = await willStartNewSegment();

  const current = (await getStored('ytap_current')) || {};
  await updateChannelScore(current.channel, 1.0);
  await pushToHistory(current);

  const pick = await pickNext();
  if (pick) {
    if (isSegmentBoundary) {
      const newSeg = await getStored('ytap_current_segment');
      const topic  = newSeg?.topic || 'general';
      console.log('[yt-autopilot] segment boundary → new topic:', topic);
      await playNarration(topic);
    }
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

  const [running, djTabId, myTabId] = await Promise.all([
    getStored('running'),
    getStored('djTabId'),
    getMyTabId(),
  ]);
  if (!running)            { console.log('[yt-autopilot] initAutoplay: DJ not running, skip'); return; }
  if (djTabId !== myTabId) { console.log('[yt-autopilot] initAutoplay: not the DJ tab, skip'); return; }

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
      try { sendResponse({ pick }); } catch (_) {}
      if (pick) {
        await playNarration('intro');
        await new Promise(r => setTimeout(r, 1000));
        const firstSeg = await getStored('ytap_current_segment');
        if (firstSeg?.topic) await playNarration(firstSeg.topic);
        await setStored({ ytap_current: pick });
        console.log('[yt-autopilot] navigating to first pick:', pick.videoId);
        window.location.href = `https://www.youtube.com/watch?v=${pick.videoId}`;
      }
    }).catch(err => {
      console.error('[yt-autopilot] PICK_NEXT error:', err);
      try { sendResponse({ pick: null }); } catch (_) {}
    });
    return true; // keep channel open for async response
  }
});

// ─── Feed scraping (proactive embed) ─────────────────────────────────────────
// Runs on home/subscriptions pages so embeddings are ready before a pick is needed.

function scrapeAndEmbedIfFeed() {
  if (location.pathname === '/watch') return;
  // Feed pages need a moment to render cards
  setTimeout(async () => {
    const candidates = getCandidates();
    if (!candidates.length) return;
    const prev = (await getStored('ytap_candidates')) || [];
    const prevById = Object.fromEntries(prev.map(c => [c.videoId, c]));
    const freshWithEmbed = candidates.map(c => ({ ...c, embedding: prevById[c.videoId]?.embedding }));
    const newIds = new Set(candidates.map(c => c.videoId));
    const retained = prev.filter(c => !newIds.has(c.videoId) && (c.views ?? 0) >= MIN_VIEWS_HARD);
    const merged = [...freshWithEmbed, ...retained].slice(0, 100);
    await setStored({ ytap_candidates: merged });
    embedCandidatesAsync(freshWithEmbed.filter(c => !c.embedding));
    console.log('[yt-autopilot] feed scrape:', candidates.length, 'fresh +', retained.length, 'retained =', merged.length, 'total');
  }, 1500);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function warmNarrationIntro() {
  if (typeof YTAP_NARRATION === 'undefined') return;
  for (const clip of (YTAP_NARRATION['intro'] || [])) {
    const a = new Audio(chrome.runtime.getURL(`audio/intro/${clip}`));
    a.load();
  }
}

warmNarrationIntro();
scrapeAndEmbedIfFeed();
initAutoplay();

// Re-init after YouTube SPA navigation — only when the URL actually changed
document.addEventListener('yt-navigate-finish', () => {
  const url = location.href;
  console.log('[yt-autopilot] yt-navigate-finish', url);
  if (url === autoplayInitUrl) { console.log('[yt-autopilot] same URL, skipping re-init'); return; }
  autoplayActive = false;
  scrapeAndEmbedIfFeed();
  initAutoplay();
});
