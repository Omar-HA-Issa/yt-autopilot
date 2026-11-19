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

const MIN_VIEWS_HARD = 40000; // absolute floor — filters out the truly niche

function getCandidates() {
  const cards = document.querySelectorAll(
    'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer'
  );
  const candidates = [];

  for (const card of cards) {
    // Feed pages use ytLockupMetadataViewModelTitle; sidebar uses a#video-title
    const titleEl = card.querySelector('a.ytLockupMetadataViewModelTitle') ||
                    card.querySelector('a#video-title[href*="watch?v="]') ||
                    card.querySelector('a[href*="watch?v="]');
    if (!titleEl) continue;

    const match = (titleEl.href || '').match(/[?&]v=([^&]+)/);
    if (!match) continue;
    const videoId = match[1];

    const title = titleEl.textContent.trim() || card.querySelector('h3')?.textContent?.trim() || '';
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
                   card.querySelector('ytd-thumbnail-overlay-time-status-renderer span') ||
                   card.querySelector('badge-shape');
    const duration = parseDuration(timeEl?.textContent);
    if (duration === null || duration < MIN_DURATION_SEC) continue;

    // Skip news-style titles
    const titleLower = title.toLowerCase();
    if (NEWS_PATTERNS.some(p => titleLower.includes(p))) continue;

    // Extract view count — scan all spans for one containing "view" text.
    // Broad scan is resilient to YouTube DOM layout changes across card types.
    // Only reject if we found a count AND it's below the floor; unknown = let through.
    let views = 0;
    for (const span of card.querySelectorAll('span')) {
      if (!span.textContent.toLowerCase().includes('view')) continue;
      const v = parseViews(span.textContent);
      if (v > 0) { views = v; break; }
    }
    if (views > 0 && views < MIN_VIEWS_HARD) continue;

    candidates.push({ title, channel, videoId, views });
  }

  return candidates;
}

// ─── Tab identity ─────────────────────────────────────────────────────────────

function getMyTabId() {
  return new Promise(resolve => {
    if (!chrome.runtime?.id) { resolve(null); return; }
    chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, res => {
      void chrome.runtime.lastError;
      resolve(res?.tabId ?? null);
    });
  });
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

const RECENT_PICKS_MAX    = 100;                         // rolling cap on persisted recentPicks
const RECENT_PICKS_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30-day age-out for recentPicks entries
const WATCHED_TTL_MS      = 90 * 24 * 60 * 60 * 1000;  // 90-day suppression for completed videos

function getStored(key) {
  return new Promise(resolve => {
    if (!chrome.runtime?.id) { resolve(undefined); return; }
    chrome.storage.local.get(key, data => resolve(data[key]));
  });
}

function setStored(obj) {
  return new Promise(resolve => {
    if (!chrome.runtime?.id) { resolve(); return; }
    chrome.storage.local.set(obj, resolve);
  });
}

function getRecentPicks() {
  return new Promise(resolve => {
    if (!chrome.runtime?.id) { resolve([]); return; }
    chrome.storage.local.get('recentPicks', ({ recentPicks }) => {
      const now = Date.now();
      const entries = (recentPicks || [])
        .map(x => typeof x === 'string' ? { id: x, ts: now } : x) // migrate plain-string format
        .filter(x => now - x.ts < RECENT_PICKS_TTL_MS);
      resolve(entries);
    });
  });
}

function addToRecentPicks(videoId) {
  return getRecentPicks().then(picks => {
    const now     = Date.now();
    const updated = [{ id: videoId, ts: now }, ...picks.filter(x => x.id !== videoId)]
      .slice(0, RECENT_PICKS_MAX);
    return new Promise(resolve => {
      if (!chrome.runtime?.id) { resolve(); return; }
      chrome.storage.local.set({ recentPicks: updated }, resolve);
    });
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

// ─── Tunable constants ────────────────────────────────────────────────────────
const CLUSTER_K               = 10;   // number of embedding clusters
const SEGMENT_SIZE            = 3;    // videos per segment; also the runt-guard minimum
const TEMPERATURE             = 0.4;  // softmax temperature for cluster selection
const RECENTLY_PLAYED_PENALTY = 1.5;  // subtracted from cluster affinity for recently-played clusters
const COHERENCE_WEIGHT        = 1.0;  // exponent on per-cluster coherence in softmax (0 = off)
const COHERENCE_FLOOR         = 0.40; // clusters below this coherence are hard-excluded from the main softmax
const DISCOVERY_RATE          = 0.10; // probability of picking a nearby under-watched cluster
const VIEW_PRIOR_WEIGHT       = 0.15; // weight of log-view-count in within-cluster pick score
const ANCHOR_NEW_THRESHOLD    = 0.50; // min cosine to nearest anchor before creating a new one
const ANCHOR_SKIP_SIM         = 0.95; // above this sim the vector nudge is a near-no-op; bump weight only
const ANCHOR_MAX              = 10;   // maximum number of taste anchors
const ALPHA_CENTROID          = 0.10; // EMA: cluster centroid nudge toward new members
const ALPHA_ANCHOR_VEC        = 0.15; // EMA: taste-anchor vector nudge toward completions
const ALPHA_ANCHOR_WEIGHT     = 0.20; // EMA: taste-anchor weight bump on a hit
const ALPHA_CHANNEL           = 0.10; // EMA: channel score
const POOL_BOOTSTRAP_THRESHOLD = 30; // embedded candidates below this → bootstrap before cluster selection
const FILL_TOP_N               = 5;  // top candidates eligible for weighted-random fill (coherence gate)
const NARRATION_CONFIDENCE_THRESHOLD = 0.40; // min cosine to nearest topic centroid to use genre narration; below this → generic fallback
const NARRATION_COOLDOWN_MS          = 20 * 1000; // suppress narration if another clip played within this window

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

function normalizeVec(v) {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return mag > 0 ? v.map(x => x / mag) : v;
}

// ─── Clustering (warm-started k-means, k=CLUSTER_K) ──────────────────────────

function kmeansppInit(embeddings, k) {
  const centroids = [embeddings[Math.floor(Math.random() * embeddings.length)]];
  while (centroids.length < k) {
    // Cosine distance = 1 − cosine_similarity (higher distance → more likely to be picked)
    const dists = embeddings.map(e => {
      let best = -Infinity;
      for (const c of centroids) { const s = cosineSim(c, e); if (s > best) best = s; }
      return Math.max(0, 1 - best);
    });
    const total = dists.reduce((a, b) => a + b, 0);
    let picked = embeddings[0];
    if (total > 0) {
      let r = Math.random() * total;
      for (let i = 0; i < embeddings.length; i++) {
        r -= dists[i];
        if (r <= 0) { picked = embeddings[i]; break; }
      }
    }
    centroids.push(picked);
  }
  return centroids;
}

async function updateClusters(embeddedCandidates) {
  if (!embeddedCandidates.length) return;

  const stored = (await getStored('ytap_clusters')) || { centroids: [], members: {} };
  let { centroids, members } = stored;

  // Cold start: no valid centroids — run k-means++ initialisation
  if (!Array.isArray(centroids) || centroids.length !== CLUSTER_K) {
    if (embeddedCandidates.length < CLUSTER_K) {
      console.log('[yt-autopilot] clustering: cold start deferred — need ≥', CLUSTER_K, 'embedded candidates, have', embeddedCandidates.length);
      return;
    }
    console.log('[yt-autopilot] clustering: cold start k-means++ with', embeddedCandidates.length, 'candidates');
    centroids = kmeansppInit(embeddedCandidates.map(c => c.embedding), CLUSTER_K);
    members = {};
    for (let i = 0; i < CLUSTER_K; i++) members[i] = [];
    for (const c of embeddedCandidates) {
      let bestIdx = 0, bestSim = -Infinity;
      for (let i = 0; i < centroids.length; i++) {
        const s = cosineSim(c.embedding, centroids[i]);
        if (s > bestSim) { bestSim = s; bestIdx = i; }
      }
      if (!members[bestIdx].includes(c.videoId)) members[bestIdx].push(c.videoId);
    }
    await setStored({ ytap_clusters: { centroids, members } });
    console.log('[yt-autopilot] clustering: cold start done, sizes:', Object.values(members).map(m => m.length));
    return;
  }

  // Warm start: assign each candidate to its nearest centroid, nudge the centroid
  let changed = false;
  for (const c of embeddedCandidates) {
    let bestIdx = 0, bestSim = -Infinity;
    for (let i = 0; i < centroids.length; i++) {
      const s = cosineSim(c.embedding, centroids[i]);
      if (s > bestSim) { bestSim = s; bestIdx = i; }
    }
    if (!members[bestIdx]) members[bestIdx] = [];
    if (!members[bestIdx].includes(c.videoId)) {
      members[bestIdx].push(c.videoId);
      centroids[bestIdx] = normalizeVec(
        centroids[bestIdx].map((v, i) => v * (1 - ALPHA_CENTROID) + c.embedding[i] * ALPHA_CENTROID)
      );
      changed = true;
    }
  }

  if (changed) await setStored({ ytap_clusters: { centroids, members } });
}

function embedCandidatesAsync(candidates) {
  if (!chrome.runtime?.id) return;
  // Fire and forget — offscreen document embeds and writes to storage directly.
  // No response expected so page navigation doesn't break anything.
  chrome.runtime.sendMessage({ type: 'EMBED_AND_STORE', candidates }, () => {
    void chrome.runtime.lastError;
  });
}

function willStartNewSegment(seg) {
  return !seg || seg.segmentIndex >= seg.videos.length;
}

// ─── Taste anchors (v2) ───────────────────────────────────────────────────────

function nearestAnchorScore(embedding, anchors) {
  if (!anchors || !anchors.length || !embedding) return { sim: 1.0, weight: 1.0 };
  let bestSim = -Infinity, bestWeight = 1.0;
  for (const a of anchors) {
    const s = cosineSim(embedding, a.centroid);
    if (s > bestSim) { bestSim = s; bestWeight = a.weight; }
  }
  return { sim: Math.max(0, bestSim), weight: bestWeight };
}

async function updateTasteAnchors(embedding) {
  if (!embedding || embedding.length !== EMBED_DIM) return;
  const anchors = (await getStored('ytap_taste_anchors')) || [];

  let nearestIdx = -1, nearestSim = -Infinity;
  for (let i = 0; i < anchors.length; i++) {
    const s = cosineSim(embedding, anchors[i].centroid);
    if (s > nearestSim) { nearestSim = s; nearestIdx = i; }
  }

  let logMsg;
  if (nearestIdx >= 0 && nearestSim >= ANCHOR_NEW_THRESHOLD) {
    const a = anchors[nearestIdx];
    if (nearestSim > ANCHOR_SKIP_SIM) {
      // Degenerate nudge: anchor already aligned to this video's embedding.
      // Bumping weight only keeps the anchor's influence growing without pinning
      // the centroid to a single video on re-watch.
      anchors[nearestIdx] = { centroid: a.centroid, weight: a.weight * (1 - ALPHA_ANCHOR_WEIGHT) + ALPHA_ANCHOR_WEIGHT };
      logMsg = 'skip sim=' + nearestSim.toFixed(3);
    } else {
      anchors[nearestIdx] = {
        centroid: normalizeVec(a.centroid.map((v, j) => v * (1 - ALPHA_ANCHOR_VEC) + embedding[j] * ALPHA_ANCHOR_VEC)),
        weight:   a.weight * (1 - ALPHA_ANCHOR_WEIGHT) + ALPHA_ANCHOR_WEIGHT,
      };
      logMsg = 'nudge sim=' + nearestSim.toFixed(3);
    }
  } else if (anchors.length < ANCHOR_MAX) {
    anchors.push({ centroid: [...embedding], weight: ALPHA_ANCHOR_WEIGHT });
    logMsg = 'new';
  } else {
    // All ANCHOR_MAX anchors full and all far — nudge nearest anyway (taste changes slowly)
    const a = anchors[nearestIdx];
    if (nearestSim > ANCHOR_SKIP_SIM) {
      anchors[nearestIdx] = { centroid: a.centroid, weight: a.weight * (1 - ALPHA_ANCHOR_WEIGHT) + ALPHA_ANCHOR_WEIGHT };
      logMsg = 'full/skip sim=' + nearestSim.toFixed(3);
    } else {
      anchors[nearestIdx] = {
        centroid: normalizeVec(a.centroid.map((v, j) => v * (1 - ALPHA_ANCHOR_VEC) + embedding[j] * ALPHA_ANCHOR_VEC)),
        weight:   a.weight * (1 - ALPHA_ANCHOR_WEIGHT) + ALPHA_ANCHOR_WEIGHT,
      };
      logMsg = 'full/nudge sim=' + nearestSim.toFixed(3);
    }
  }

  await setStored({ ytap_taste_anchors: anchors });
  console.log('[yt-autopilot] taste anchors:', anchors.length, logMsg);
}

// ─── Pool bootstrap (A + C) ───────────────────────────────────────────────────

// Fetches /feed/subscriptions and extracts video candidates from the ytInitialData
// JSON blob that YouTube server-renders into the initial HTML. Returns a filtered
// candidate array on success, or null if the fetch/parse failed outright.
// A result with < 5 entries means parse succeeded but the renderer tree was wrong
// (logged-out, consent wall, auth state) — caller distinguishes these two cases.
async function fetchFeedCandidates() {
  try {
    const html = await fetch('https://www.youtube.com/feed/subscriptions').then(r => r.text());

    // Brace-count extraction: more reliable than a regex on a multi-MB blob.
    const marker   = 'var ytInitialData = ';
    const jsonStart = html.indexOf(marker);
    if (jsonStart === -1) {
      console.log('[yt-autopilot] bootstrap A: ytInitialData marker missing — likely a login/consent page');
      return null;
    }
    let depth = 0, i = jsonStart + marker.length;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { if (--depth === 0) { i++; break; } }
    }
    let data;
    try {
      data = JSON.parse(html.slice(jsonStart + marker.length, i));
    } catch (e) {
      console.log('[yt-autopilot] bootstrap A: ytInitialData JSON parse threw:', e.message);
      return null;
    }

    // Standard subscription feed path — richGridRenderer has been stable since ~2021.
    // If this path is absent (wrong auth state, layout change) contents will be [].
    const contents = data?.contents
      ?.twoColumnBrowseResultsRenderer
      ?.tabs?.[0]?.tabRenderer?.content
      ?.richGridRenderer?.contents ?? [];

    const candidates = [];
    for (const item of contents) {
      const v = item?.richItemRenderer?.content?.videoRenderer;
      if (!v?.videoId) continue;

      const title = v.title?.runs?.[0]?.text;
      if (!title) continue;
      const channel = v.shortBylineText?.runs?.[0]?.text;
      if (!channel) continue;

      // Live / Shorts — mirrors the overlayStyle check in getCandidates()
      const overlayStyle = v.thumbnailOverlays
        ?.find(o => o.thumbnailOverlayTimeStatusRenderer)
        ?.thumbnailOverlayTimeStatusRenderer?.style;
      if (overlayStyle === 'LIVE' || overlayStyle === 'SHORTS') continue;

      // Duration — same parseDuration() + MIN_DURATION_SEC as DOM scraper
      const duration = parseDuration(v.lengthText?.simpleText);
      if (duration === null || duration < MIN_DURATION_SEC) continue;

      // Views — same parseViews() + MIN_VIEWS_HARD as DOM scraper
      const viewStr = v.viewCountText?.simpleText
        ?? v.viewCountText?.runs?.map(r => r.text).join('');
      const views = parseViews(viewStr);
      if (views > 0 && views < MIN_VIEWS_HARD) continue;

      // News patterns — same filter as DOM scraper
      if (NEWS_PATTERNS.some(p => title.toLowerCase().includes(p))) continue;

      candidates.push({ videoId: v.videoId, title, channel, views });
    }
    return candidates;
  } catch (err) {
    console.log('[yt-autopilot] bootstrap A: fetch threw:', err.message);
    return null;
  }
}

// Merges a fresh batch of candidates into the stored pool with the same
// dedup / retain / embed logic used everywhere else in the pipeline.
async function mergeIntoCandidatePool(fresh) {
  if (!fresh.length) return;
  const prev          = (await getStored('ytap_candidates')) || [];
  const prevById      = Object.fromEntries(prev.map(c => [c.videoId, c]));
  const freshWithEmbed = fresh.map(c => ({ ...c, embedding: prevById[c.videoId]?.embedding }));
  const newIds        = new Set(fresh.map(c => c.videoId));
  const retained      = prev.filter(c => !newIds.has(c.videoId) && !(c.views > 0 && c.views < MIN_VIEWS_HARD));
  const merged        = [...freshWithEmbed, ...retained].slice(0, 100);
  await setStored({ ytap_candidates: merged });
  await updateClusters(merged.filter(c => c.embedding));
  embedCandidatesAsync(freshWithEmbed.filter(c => !c.embedding));
}

// Fires when the embedded pool is thin at DJ start. Tries A (ytInitialData fetch)
// first, falls through to C (immediate sidebar scrape) regardless of A's outcome.
async function bootstrapPool() {
  // A: subscription feed via ytInitialData
  const feedCandidates = await fetchFeedCandidates();
  if (feedCandidates === null) {
    console.log('[yt-autopilot] bootstrap: A failed (fetch/parse error) — sidebar only');
  } else if (feedCandidates.length < 5) {
    console.log('[yt-autopilot] bootstrap: A returned', feedCandidates.length,
      'candidates (auth/consent state?) — sidebar only');
  } else {
    console.log('[yt-autopilot] bootstrap: A fetched', feedCandidates.length, 'from feed');
    await mergeIntoCandidatePool(feedCandidates);
  }

  // C: immediate sidebar scrape — complement to A, or sole source when A fails
  const sidebarFresh = getCandidates();
  if (sidebarFresh.length) {
    console.log('[yt-autopilot] bootstrap: C sidebar gave', sidebarFresh.length, 'candidates');
    await mergeIntoCandidatePool(sidebarFresh);
  } else {
    console.log('[yt-autopilot] bootstrap: C sidebar empty on this page type');
  }
}

// ─── Exclusion pool resolver ───────────────────────────────────────────────────
// Hard-excludes recently-picked and long-watched videos from a candidate pool.
// If exclusion would leave fewer than SEGMENT_SIZE candidates, relaxes the
// exclusion oldest-first (across both sets combined) until the pool is refillable.
// Never returns an empty pool — worst case it returns all available videos.
// Shared by the v2 cluster picker and the legacy fallback picker.
function resolveExclusionPool(available, recentPicks, watchedMap) {
  const recentById = Object.fromEntries(recentPicks.map(x => [x.id, x.ts]));

  const fresh    = [];
  const excluded = []; // { c, lastSeenTs }

  for (const c of available) {
    const recentTs  = recentById[c.videoId];
    const watchedTs = watchedMap[c.videoId];
    if (recentTs === undefined && watchedTs === undefined) {
      fresh.push(c);
    } else {
      // lastSeenTs = most recent time this video appeared in either exclusion set
      excluded.push({ c, lastSeenTs: Math.max(recentTs ?? 0, watchedTs ?? 0) });
    }
  }

  if (fresh.length >= SEGMENT_SIZE) return fresh;

  // Starvation: add back the oldest-seen excluded videos first
  excluded.sort((a, b) => a.lastSeenTs - b.lastSeenTs);
  const pool = [...fresh];
  for (const { c } of excluded) {
    if (pool.length >= SEGMENT_SIZE) break;
    pool.push(c);
  }
  if (pool.length < available.length) {
    console.log('[yt-autopilot] starvation fallback: pool relaxed',
      pool.length - fresh.length, 'exclusions (oldest-first),', fresh.length, 'fresh');
  }
  return pool.length > 0 ? pool : available; // absolute last resort: all members
}

// ─── New pick loop (v2) ───────────────────────────────────────────────────────

async function pickNextNew(coldStartRetried = false) {
  // 1. Drain current segment first
  const seg = await getStored('ytap_current_segment');
  if (seg && seg.segmentIndex < seg.videos.length) {
    const pick = seg.videos[seg.segmentIndex];
    await setStored({ ytap_current_segment: { ...seg, segmentIndex: seg.segmentIndex + 1 } });
    console.log('[yt-autopilot] v2 drain [', seg.segmentIndex + 1, '/', seg.videos.length, '] cluster', seg.clusterIdx, pick.title);
    await addToRecentPicks(pick.videoId);
    return pick;
  }

  // Bootstrap: if the embedded pool is thin, populate it before cluster selection.
  // Runs only when needed — once pool reaches POOL_BOOTSTRAP_THRESHOLD this check
  // is a single fast storage read and the await resolves immediately.
  const _preCands = (await getStored('ytap_candidates')) || [];
  if (_preCands.filter(c => c.embedding).length < POOL_BOOTSTRAP_THRESHOLD) {
    await bootstrapPool();
  }

  // 2. Load all state in parallel
  const [clusterData, storedCandidates, channelScores, tasteAnchors, recentPicks, rawWatched, lastCluster, totalCompletions] = await Promise.all([
    getStored('ytap_clusters'),
    getStored('ytap_candidates'),
    getStored('ytap_channel_scores'),
    getStored('ytap_taste_anchors'),
    getRecentPicks(),
    getStored('ytap_watched'),
    getStored('ytap_last_cluster'),
    getStored('ytap_total_completions'),
  ]);

  const { centroids, members } = clusterData || {};
  if (!centroids || centroids.length < CLUSTER_K) {
    if (!coldStartRetried) {
      console.log('[yt-autopilot] v2: clusters not ready — attempting direct embed + cluster');
      await coldStartEmbedAndCluster();
      return pickNextNew(true);
    }
    console.log('[yt-autopilot] v2: clusters still not ready after cold-start embed — using lightweight fallback');
    return pickNextColdStart();
  }

  const allCandidates = storedCandidates || [];
  const scores        = channelScores    || {};
  const anchors       = tasteAnchors     || [];
  const recentSet     = new Set(recentPicks.map(x => x.id));
  const now_ms        = Date.now();
  const watchedMap    = Object.fromEntries(
    Object.entries(rawWatched || {}).filter(([, ts]) => now_ms - ts < WATCHED_TTL_MS)
  );
  const completions   = totalCompletions || 0;
  const byId          = Object.fromEntries(allCandidates.map(c => [c.videoId, c]));

  // 3. Per-cluster stats — available = members present in pool with embeddings
  const clusterInfos = [];
  for (let i = 0; i < centroids.length; i++) {
    const available = (members[i] || []).map(id => byId[id]).filter(c => c && c.embedding);

    // RUNT GUARD: cluster must supply at least SEGMENT_SIZE embedded candidates
    if (available.length < SEGMENT_SIZE) continue;

    // Affinity: mean(anchor_sim × anchor_weight) across available members
    const affinity = anchors.length === 0
      ? 0.5
      : available.reduce((s, c) => {
          const { sim, weight } = nearestAnchorScore(c.embedding, anchors);
          return s + sim * weight;
        }, 0) / available.length;

    // Coherence: mean cosine of members to their cluster centroid
    const coherence = available.reduce((s, c) => s + cosineSim(c.embedding, centroids[i]), 0) / available.length;

    // Penalty for the most recently played cluster
    const penalty = lastCluster === i ? RECENTLY_PLAYED_PENALTY : 0;

    clusterInfos.push({ idx: i, available, affinity, coherence, penalty });
  }

  if (!clusterInfos.length) {
    if (!coldStartRetried) {
      console.log('[yt-autopilot] v2: no eligible clusters — attempting direct embed + cluster');
      await coldStartEmbedAndCluster();
      return pickNextNew(true);
    }
    console.log('[yt-autopilot] v2: still no eligible clusters after cold-start embed — using lightweight fallback');
    return pickNextColdStart();
  }

  // Hard-quarantine clusters below COHERENCE_FLOOR from the main softmax.
  // Discovery is exempt — it can still explore low-coherence clusters.
  const softmaxPool  = clusterInfos.filter(ci => ci.coherence >= COHERENCE_FLOOR);
  const quarantined  = clusterInfos.filter(ci => ci.coherence < COHERENCE_FLOOR);
  if (quarantined.length) {
    console.log('[yt-autopilot] v2 quarantine:',
      quarantined.map(ci => `cluster ${ci.idx} (coherence ${ci.coherence.toFixed(3)})`).join(', '));
  }
  const mainPool = softmaxPool.length > 0 ? softmaxPool : clusterInfos;
  if (softmaxPool.length === 0) {
    console.log('[yt-autopilot] v2: all clusters below COHERENCE_FLOOR — using full pool as fallback');
  }

  // 4. Discovery: near lastCluster, under-represented in recentPicks (~DISCOVERY_RATE)
  let chosenCluster = null;
  if (lastCluster != null && completions >= 5 && Math.random() < DISCOVERY_RATE) {
    const lastCentroid = centroids[lastCluster];
    if (lastCentroid) {
      const nearby = clusterInfos
        .filter(ci => ci.idx !== lastCluster)
        .map(ci => ({ ci, nearSim: cosineSim(centroids[ci.idx], lastCentroid) }))
        .sort((a, b) => b.nearSim - a.nearSim)
        .slice(0, 3)
        .map(x => x.ci);
      if (nearby.length) {
        chosenCluster = nearby.slice().sort((a, b) =>
          a.available.filter(c => recentSet.has(c.videoId)).length -
          b.available.filter(c => recentSet.has(c.videoId)).length
        )[0];
        console.log('[yt-autopilot] v2 discovery: cluster', chosenCluster.idx, '(near cluster', lastCluster, ')');
      }
    }
  }

  // 5. Normal selection: softmax(affinity × coherence^COHERENCE_WEIGHT − penalty, TEMPERATURE)
  if (!chosenCluster) {
    const logits = mainPool.map(ci =>
      (ci.affinity * Math.pow(ci.coherence, COHERENCE_WEIGHT) - ci.penalty) / TEMPERATURE
    );
    const maxL  = Math.max(...logits);
    const exps  = logits.map(l => Math.exp(l - maxL));
    const total = exps.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    chosenCluster = mainPool[mainPool.length - 1];
    for (let i = 0; i < mainPool.length; i++) {
      r -= exps[i];
      if (r <= 0) { chosenCluster = mainPool[i]; break; }
    }
    console.log(
      '[yt-autopilot] v2 cluster', chosenCluster.idx,
      'affinity', chosenCluster.affinity.toFixed(3),
      'coherence', chosenCluster.coherence.toFixed(3),
      'penalty', chosenCluster.penalty
    );
  }

  // 6. Within-cluster pick: hard-exclude recent/watched; resolve pool with starvation fallback
  const pool     = resolveExclusionPool(chosenCluster.available, recentPicks, watchedMap);
  const logViews = pool.map(c => Math.log10((c.views || 0) + 1));
  const maxLog   = Math.max(...logViews);
  const minLog   = Math.min(...logViews);
  const logRange = maxLog - minLog || 1;

  const scoredPool = pool.map((c, i) => {
    const { sim, weight } = nearestAnchorScore(c.embedding, anchors);
    const channelScore = scores[c.channel] ?? 0.5;
    const viewPrior    = (logViews[i] - minLog) / logRange;
    return {
      c,
      score: (1 - VIEW_PRIOR_WEIGHT) * (sim * weight * channelScore)
           + VIEW_PRIOR_WEIGHT * viewPrior,
    };
  });

  const totalScore = scoredPool.reduce((s, x) => s + Math.max(0, x.score), 0);
  let anchor = scoredPool[0].c;
  if (totalScore > 0) {
    let r = Math.random() * totalScore;
    for (const { c, score } of scoredPool) {
      r -= Math.max(0, score);
      if (r <= 0) { anchor = c; break; }
    }
  }

  // 7. Fill: weighted-random from top FILL_TOP_N remaining by score.
  // Top-N gate keeps the fill coherent (only the best-matching candidates are
  // eligible); weighted-random within that set breaks the deterministic repeat.
  const segment  = [anchor];
  const usedIds  = new Set([anchor.videoId]);
  const fillCands = scoredPool
    .filter(x => !usedIds.has(x.c.videoId))
    .sort((a, b) => b.score - a.score)
    .slice(0, FILL_TOP_N);

  while (segment.length < SEGMENT_SIZE) {
    const avail = fillCands.filter(x => !usedIds.has(x.c.videoId));
    if (!avail.length) break;
    const fillTotal = avail.reduce((s, x) => s + Math.max(0, x.score), 0);
    let pick = avail[0].c;
    if (fillTotal > 0) {
      let r = Math.random() * fillTotal;
      for (const { c, score } of avail) {
        r -= Math.max(0, score);
        if (r <= 0) { pick = c; break; }
      }
    }
    segment.push(pick);
    usedIds.add(pick.videoId);
  }

  console.log('[yt-autopilot] v2 segment cluster', chosenCluster.idx, ':', segment.map(v => v.title));

  // 8. Classify cluster centroid for narration — audio only, never touches selection
  const narration = classifyForNarration(centroids[chosenCluster.idx]);
  console.log('[yt-autopilot] narration classification: cluster', chosenCluster.idx,
    '→', narration.label, '(cosine', narration.score.toFixed(3) + ')');

  // 9. Persist
  await setStored({
    ytap_current_segment: {
      clusterIdx:     chosenCluster.idx,
      videos:         segment,
      segmentIndex:   1,
      narrationLabel: narration.label,
      narrationScore: narration.score,
    },
    ytap_last_cluster: chosenCluster.idx,
  });
  await addToRecentPicks(anchor.videoId);
  return anchor;
}

// ─── Cold-start fallback ───────────────────────────────────────────────────────
// Fires only when pickNextNew() can't find a usable cluster yet (e.g. a brand-new
// install's very first pick, before CLUSTER_K candidates have been embedded and
// clustered). Embeds whatever's missing directly — awaited, bounded by
// COLD_START_EMBED_TIMEOUT_MS — instead of the fire-and-forget EMBED_AND_STORE
// path, then clusters once so pickNextNew() can retry with a real pool. The DJ
// splash/cold-open narration is already showing during this window, so a few
// seconds of extra wait on the very first pick is acceptable.

const COLD_START_EMBED_TIMEOUT_MS = 15000;

async function coldStartEmbedAndCluster() {
  const candidates = (await getStored('ytap_candidates')) || [];
  const unembedded = candidates.filter(c => !c.embedding);
  if (!unembedded.length) return;

  const texts = unembedded.map(c => `${c.channel}: ${c.title}`);
  const embeddings = await embedTexts(texts, COLD_START_EMBED_TIMEOUT_MS);
  if (!embeddings) {
    console.log('[yt-autopilot] cold start: direct embed timed out/failed');
    return;
  }

  const byId = Object.fromEntries(candidates.map(c => [c.videoId, c]));
  let embedded = 0;
  unembedded.forEach((c, i) => {
    if (embeddings[i]) { byId[c.videoId] = { ...c, embedding: embeddings[i] }; embedded++; }
  });
  const merged = Object.values(byId);
  await setStored({ ytap_candidates: merged });
  await updateClusters(merged.filter(c => c.embedding));
  console.log('[yt-autopilot] cold start: directly embedded', embedded, '/', unembedded.length, 'candidates');
}

// Last resort when clusters are still unusable after the cold-start embed retry —
// weighted-random by channel score + view count only, no clustering or topics.
// Should only ever fire on a fresh install's first pick.
async function pickNextColdStart() {
  const [allCandidates, channelScores, recentPicks, rawWatched] = await Promise.all([
    getStored('ytap_candidates'),
    getStored('ytap_channel_scores'),
    getRecentPicks(),
    getStored('ytap_watched'),
  ]);
  const now_ms     = Date.now();
  const watchedMap = Object.fromEntries(
    Object.entries(rawWatched || {}).filter(([, ts]) => now_ms - ts < WATCHED_TTL_MS)
  );
  const scores = channelScores || {};
  const pool   = resolveExclusionPool(allCandidates || [], recentPicks, watchedMap);

  const logViews = pool.map(c => Math.log10((c.views || 0) + 1));
  const maxLog   = Math.max(...logViews);
  const minLog   = Math.min(...logViews);
  const logRange = maxLog - minLog || 1;

  const weights = pool.map((c, i) => {
    const channelScore = scores[c.channel] ?? 0.5;
    const viewPrior    = (logViews[i] - minLog) / logRange;
    return 0.85 * channelScore + 0.15 * viewPrior;
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let picked = pool[pool.length - 1];
  if (total > 0) {
    let r = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) { picked = pool[i]; break; }
    }
  }

  console.log('[yt-autopilot] cold-start fallback pick:', picked?.title);
  await setStored({ ytap_current_segment: { videos: [picked], segmentIndex: 1 } });
  await addToRecentPicks(picked.videoId);
  return picked;
}

async function pickNext() {
  return pickNextNew();
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
    // v2: update taste anchors and session completion count
    if (current.embedding) await updateTasteAnchors(current.embedding);
    // Long-term completion suppression: mark video watched so it stays out of
    // the pick pool for WATCHED_TTL_MS (90 days) regardless of recentPicks age-out.
    if (current.videoId) {
      const watched = (await getStored('ytap_watched')) || {};
      watched[current.videoId] = Date.now();
      await setStored({ ytap_watched: watched });
    }
    const completions = (await getStored('ytap_total_completions')) || 0;
    await setStored({ ytap_total_completions: completions + 1 });
  }
}

// ─── Narration classification (Stage 3) ──────────────────────────────────────
// Classifies a cluster centroid against the 12 topic centroids in topic_centroids.js
// and returns the nearest label plus its cosine score.
// This is the ONLY place on the v2 path that reads YTAP_TOPIC_CENTROIDS for narration.
// It must NOT be called from selection, scoring, clustering, or anchors.
function classifyForNarration(centroid) {
  if (typeof YTAP_TOPIC_CENTROIDS === 'undefined' || !centroid) return { label: 'general', score: 0 };
  let bestLabel = 'general', bestScore = -Infinity;
  for (const [topic, topicCentroid] of Object.entries(YTAP_TOPIC_CENTROIDS)) {
    let sim = 0;
    for (let i = 0; i < centroid.length; i++) sim += centroid[i] * topicCentroid[i];
    if (sim > bestScore) { bestScore = sim; bestLabel = topic; }
  }
  return { label: bestLabel, score: bestScore };
}

// Maps classifier label → mid-session genre bucket.
// music and sports deliberately absent — their clusters are too broad; they fall through
// to continuation_generic. commentary and general likewise have no dedicated cont_ bucket.
const CONT_BUCKET_MAP = {
  gaming:  'cont_gaming',
  tech:    'cont_tech',
  finance: 'cont_finance',
  science: 'cont_science',
  history: 'cont_history',
  comedy:  'cont_comedy',
  food:    'cont_food',
  film_tv: 'cont_filmtv',
};

// Resolves which bucket to play at a mid-session segment boundary, using
// narrationLabel + narrationScore + confidence gate. The cold-start fallback
// segment (pickNextColdStart) has no narrationLabel, so it always lands on
// continuation_generic — same as a bucket with no files yet (during dev).
function resolveContinuationBucket(seg) {
  if (!seg || seg.narrationLabel === undefined) return 'continuation_generic';
  if (seg.narrationScore >= NARRATION_CONFIDENCE_THRESHOLD) {
    const bucket = CONT_BUCKET_MAP[seg.narrationLabel];
    if (bucket && YTAP_NARRATION[bucket]?.length) return bucket;
  }
  return 'continuation_generic';
}

// ─── Narration (Phase 5e) ─────────────────────────────────────────────────────
// _narrationRecency and _lastNarrationTs are mirrored to chrome.storage.local
// (ytap_narration_recency / ytap_narration_last_ts). Every segment boundary
// navigates via window.location.href — a hard navigation that fully re-injects
// the content script and resets plain module state — so without persisting
// these, anti-repetition and the cooldown are inert on every segment, not just
// across a manual extension reload.

const _narrationRecency    = new Map(); // bucket → Set of recently played filenames (FIFO, size ≤ ceil(bucketSize/2))
let _lastNarrationTs       = 0;         // timestamp of the most recently started narration clip
let _currentNarrationAudio = null;
let _narrationResolve  = null;
let _narrationStateReady   = null;

function loadNarrationState() {
  if (!_narrationStateReady) {
    _narrationStateReady = Promise.all([
      getStored('ytap_narration_recency'),
      getStored('ytap_narration_last_ts'),
    ]).then(([storedRecency, storedTs]) => {
      for (const [bucket, filenames] of Object.entries(storedRecency || {})) {
        _narrationRecency.set(bucket, new Set(filenames));
      }
      _lastNarrationTs = storedTs || 0;
    });
  }
  return _narrationStateReady;
}

function saveNarrationState() {
  const recencyObj = {};
  for (const [bucket, set] of _narrationRecency.entries()) recencyObj[bucket] = [...set];
  return setStored({ ytap_narration_recency: recencyObj, ytap_narration_last_ts: _lastNarrationTs });
}

function stopNarration() {
  if (_currentNarrationAudio) {
    _currentNarrationAudio.pause();
    _currentNarrationAudio = null;
  }
  if (_narrationResolve) {
    _narrationResolve();
    _narrationResolve = null;
  }
}

async function playNarration(bucket) {
  if (typeof YTAP_NARRATION === 'undefined') return;
  const clips = YTAP_NARRATION[bucket];
  if (!clips?.length) return;

  await loadNarrationState();

  const now = Date.now();
  if (now - _lastNarrationTs < NARRATION_COOLDOWN_MS) {
    const remaining = Math.round((NARRATION_COOLDOWN_MS - (now - _lastNarrationTs)) / 1000);
    console.log(`[yt-autopilot] narration suppressed — cooldown ${remaining}s remaining`);
    return;
  }
  _lastNarrationTs = now;

  const recency   = _narrationRecency.get(bucket) || new Set();
  const exclude   = Math.ceil(clips.length / 2);
  const available = clips.length > 1 ? clips.filter(c => !recency.has(c)) : clips;
  const pool      = available.length > 0 ? available : clips; // full-reset if all excluded
  const clip      = pool[Math.floor(Math.random() * pool.length)];

  recency.add(clip);
  if (recency.size > exclude) recency.delete(recency.values().next().value); // evict oldest
  _narrationRecency.set(bucket, recency);
  await saveNarrationState();

  const audio = new Audio(chrome.runtime.getURL(`audio/${bucket}/${clip}`));
  _currentNarrationAudio = audio;
  connectNarrationToAnalyser(audio);     // wire into DJ splash analyser if active
  connectNarrationToNarrAnalyser(audio); // wire into segment narration analyser if active
  console.log('[yt-autopilot] narration:', bucket, clip);

  await new Promise(resolve => {
    _narrationResolve = resolve;
    const timer = setTimeout(() => { _currentNarrationAudio = null; _narrationResolve = null; resolve(); }, 8000);
    const done  = () => { clearTimeout(timer); _currentNarrationAudio = null; _narrationResolve = null; resolve(); };
    audio.addEventListener('ended', done, { once: true });
    audio.addEventListener('error', done, { once: true });
    audio.play().catch(err => {
      console.log('[yt-autopilot] narration autoplay blocked:', err.message);
      clearTimeout(timer);
      _currentNarrationAudio = null;
      _narrationResolve = null;
      resolve();
    });
  });
}

// ─── DJ circle UI ────────────────────────────────────────────────────────────

let _djSplashAnimId = null;
let _djAudioCtx     = null;
let _djAnalyser     = null;
let _djFreqData     = null;

// Called from playNarration() — connects the live Audio element into the
// analyser so the blob ring reacts to the actual audio waveform.
function connectNarrationToAnalyser(audioEl) {
  if (!_djAnalyser || !_djAudioCtx) return;
  try {
    if (_djAudioCtx.state === 'suspended') _djAudioCtx.resume();
    const src = _djAudioCtx.createMediaElementSource(audioEl);
    src.connect(_djAnalyser);
  } catch (e) {
    console.log('[yt-autopilot] analyser connect failed:', e.message);
  }
}

function showDJSplash() {
  if (document.getElementById('ytap-dj-splash')) return;

  // Set up Web Audio analyser — failure is non-fatal, blob still runs on harmonics
  try {
    _djAudioCtx = new AudioContext();
    _djAnalyser = _djAudioCtx.createAnalyser();
    _djAnalyser.fftSize = 256;               // 128 frequency bins
    _djAnalyser.smoothingTimeConstant = 0.82; // temporal smoothing built-in
    _djAnalyser.connect(_djAudioCtx.destination);
    _djFreqData = new Uint8Array(_djAnalyser.frequencyBinCount); // 128 values, 0–255
  } catch (e) {
    console.log('[yt-autopilot] AudioContext init failed:', e.message);
  }

  const card = document.createElement('div');
  card.id = 'ytap-dj-splash';
  document.body.appendChild(card);

  // ── Blob ring constants ──────────────────────────────────────────────────
  const SIZE      = 140;
  const CX        = SIZE / 2, CY = SIZE / 2;
  const R         = 48;          // base radius (px)
  const N         = 120;         // sample points around the perimeter
  const AMP_BASE  = R * 0.08;   // harmonic perturbation max (~3.8px)
  const AMP_AUDIO = R * 0.22;   // audio-driven perturbation max (~10.6px)
  const BINS_USED = 64;          // use the lower 64 bins (covers 0–5.5kHz, speech range)

  // Slow organic harmonics — keep the ring alive even during silence
  const H = [
    { k: 2, w: 0.40, phase: 0.00, speed:  0.90 },
    { k: 3, w: 0.30, phase: 1.20, speed: -0.60 },
    { k: 4, w: 0.20, phase: 2.50, speed:  0.40 },
    { k: 5, w: 0.10, phase: 4.00, speed: -0.70 },
  ];
  const totalW = H.reduce((s, h) => s + h.w, 0);
  H.forEach(h => { h.a = (h.w / totalW) * AMP_BASE; });

  const NS  = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width',    SIZE);
  svg.setAttribute('height',   SIZE);
  svg.setAttribute('viewBox',  `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute('overflow', 'visible'); // let glow bleed outside SVG bounds

  const blob = document.createElementNS(NS, 'path');
  blob.setAttribute('fill',            'none');
  blob.setAttribute('stroke',          '#a8c7fa');
  blob.setAttribute('stroke-width',    '4.0');
  blob.setAttribute('stroke-linecap',  'round');
  blob.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(blob);
  card.appendChild(svg);

  // Per-point smoothed audio value — EMA to prevent jitter between frames
  const smooth = new Float32Array(N);

  function frame(ts) {
    const t = ts * 0.001;

    // Pull latest frequency data
    let hasAudio = false;
    if (_djAnalyser && _djFreqData) {
      _djAnalyser.getByteFrequencyData(_djFreqData);
      let sum = 0;
      for (let i = 0; i < BINS_USED; i++) sum += _djFreqData[i];
      hasAudio = sum > 80; // ignore near-silence
    }

    const pts = new Array(N);
    for (let i = 0; i < N; i++) {
      const theta = (2 * Math.PI * i) / N;
      let r = R;

      // Slow harmonic deformation (always active)
      for (const h of H) r += h.a * Math.sin(h.k * theta + h.phase + h.speed * t);

      // Audio-reactive layer: map each point to a linearly interpolated freq bin
      if (hasAudio) {
        const binF   = (i / N) * BINS_USED;
        const b0     = Math.floor(binF);
        const b1     = Math.min(b0 + 1, BINS_USED - 1);
        const raw    = (_djFreqData[b0] * (1 - (binF - b0)) + _djFreqData[b1] * (binF - b0)) / 255;
        smooth[i]    = smooth[i] * 0.55 + raw * 0.45; // per-point EMA
        r           += smooth[i] * AMP_AUDIO;
      } else {
        smooth[i] *= 0.85; // decay toward zero on silence
        r         += smooth[i] * AMP_AUDIO;
      }

      pts[i] = [CX + r * Math.cos(theta), CY + r * Math.sin(theta)];
    }

    // Smooth closed path: Q bezier through midpoints, original points as controls
    const sx = (pts[N-1][0] + pts[0][0]) * 0.5;
    const sy = (pts[N-1][1] + pts[0][1]) * 0.5;
    let d = `M${sx.toFixed(2)} ${sy.toFixed(2)}`;
    for (let i = 0; i < N; i++) {
      const p  = pts[i];
      const nx = (pts[i][0] + pts[(i + 1) % N][0]) * 0.5;
      const ny = (pts[i][1] + pts[(i + 1) % N][1]) * 0.5;
      d += ` Q${p[0].toFixed(2)} ${p[1].toFixed(2)} ${nx.toFixed(2)} ${ny.toFixed(2)}`;
    }
    blob.setAttribute('d', d + 'Z');
    _djSplashAnimId = requestAnimationFrame(frame);
  }

  _djSplashAnimId = requestAnimationFrame(frame);
}

function hideDJSplash() {
  if (_djSplashAnimId) { cancelAnimationFrame(_djSplashAnimId); _djSplashAnimId = null; }
  if (_djAudioCtx)    { _djAudioCtx.close().catch(() => {}); _djAudioCtx = null; _djAnalyser = null; _djFreqData = null; }
  const el = document.getElementById('ytap-dj-splash');
  if (!el) return;
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 420);
}

let _narrAnimId   = null;
let _narrAudioCtx = null;
let _narrAnalyser = null;
let _narrFreqData = null;

function connectNarrationToNarrAnalyser(audioEl) {
  if (!_narrAnalyser || !_narrAudioCtx) return;
  try {
    if (_narrAudioCtx.state === 'suspended') _narrAudioCtx.resume();
    const src = _narrAudioCtx.createMediaElementSource(audioEl);
    src.connect(_narrAnalyser);
  } catch (e) {
    console.log('[yt-autopilot] narr analyser connect failed:', e.message);
  }
}

function startNarrBlobRing(container) {
  const SIZE = 110, CX = 55, CY = 55, R = 38, N = 120;
  const AMP_BASE  = R * 0.08;
  const AMP_AUDIO = R * 0.22;
  const BINS_USED = 64;

  const H = [
    { k: 2, w: 0.40, phase: 0.50, speed:  0.90 },
    { k: 3, w: 0.30, phase: 1.70, speed: -0.60 },
    { k: 4, w: 0.20, phase: 3.00, speed:  0.40 },
    { k: 5, w: 0.10, phase: 4.50, speed: -0.70 },
  ];
  const totalW = H.reduce((s, h) => s + h.w, 0);
  H.forEach(h => { h.a = (h.w / totalW) * AMP_BASE; });

  const NS  = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width',    SIZE);
  svg.setAttribute('height',   SIZE);
  svg.setAttribute('viewBox',  `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute('overflow', 'visible');

  const blob = document.createElementNS(NS, 'path');
  blob.setAttribute('fill',            'none');
  blob.setAttribute('stroke',          '#a8c7fa');
  blob.setAttribute('stroke-width',    '4.0');
  blob.setAttribute('stroke-linecap',  'round');
  blob.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(blob);
  container.appendChild(svg);

  const smooth = new Float32Array(N);

  function frame(ts) {
    const t = ts * 0.001;

    let hasAudio = false;
    if (_narrAnalyser && _narrFreqData) {
      _narrAnalyser.getByteFrequencyData(_narrFreqData);
      let sum = 0;
      for (let i = 0; i < BINS_USED; i++) sum += _narrFreqData[i];
      hasAudio = sum > 80;
    }

    const pts = new Array(N);
    for (let i = 0; i < N; i++) {
      const theta = (2 * Math.PI * i) / N;
      let r = R;
      for (const h of H) r += h.a * Math.sin(h.k * theta + h.phase + h.speed * t);
      if (hasAudio) {
        const binF = (i / N) * BINS_USED;
        const b0   = Math.floor(binF);
        const b1   = Math.min(b0 + 1, BINS_USED - 1);
        const raw  = (_narrFreqData[b0] * (1 - (binF - b0)) + _narrFreqData[b1] * (binF - b0)) / 255;
        smooth[i]  = smooth[i] * 0.55 + raw * 0.45;
        r         += smooth[i] * AMP_AUDIO;
      } else {
        smooth[i] *= 0.85;
        r         += smooth[i] * AMP_AUDIO;
      }
      pts[i] = [CX + r * Math.cos(theta), CY + r * Math.sin(theta)];
    }

    const sx = (pts[N-1][0] + pts[0][0]) * 0.5;
    const sy = (pts[N-1][1] + pts[0][1]) * 0.5;
    let d = `M${sx.toFixed(2)} ${sy.toFixed(2)}`;
    for (let i = 0; i < N; i++) {
      const p  = pts[i];
      const nx = (pts[i][0] + pts[(i + 1) % N][0]) * 0.5;
      const ny = (pts[i][1] + pts[(i + 1) % N][1]) * 0.5;
      d += ` Q${p[0].toFixed(2)} ${p[1].toFixed(2)} ${nx.toFixed(2)} ${ny.toFixed(2)}`;
    }
    blob.setAttribute('d', d + 'Z');
    _narrAnimId = requestAnimationFrame(frame);
  }

  _narrAnimId = requestAnimationFrame(frame);
}

function stopNarrBlobRing() {
  if (_narrAnimId) { cancelAnimationFrame(_narrAnimId); _narrAnimId = null; }
}

function setNarrating(active) {
  if (active) {
    // Setup audio analyser
    try {
      _narrAudioCtx = new AudioContext();
      _narrAnalyser = _narrAudioCtx.createAnalyser();
      _narrAnalyser.fftSize = 256;
      _narrAnalyser.smoothingTimeConstant = 0.82;
      _narrAnalyser.connect(_narrAudioCtx.destination);
      _narrFreqData = new Uint8Array(_narrAnalyser.frequencyBinCount);
    } catch (e) {
      console.log('[yt-autopilot] narr AudioContext failed:', e.message);
    }

    // Prepend section inside the overlay so they share the same box
    const overlayEl = document.getElementById('ytap-overlay');
    if (!overlayEl) return;
    const section = document.createElement('div');
    section.id = 'ytap-narr-section';
    overlayEl.prepend(section);
    requestAnimationFrame(() => section.classList.add('active'));
    startNarrBlobRing(section);
  } else {
    stopNarrBlobRing();
    const section = document.getElementById('ytap-narr-section');
    if (section) {
      section.classList.remove('active');
      setTimeout(() => section.remove(), 320);
    }
    if (_narrAudioCtx) { _narrAudioCtx.close().catch(() => {}); _narrAudioCtx = null; _narrAnalyser = null; _narrFreqData = null; }
  }
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
  overlay.innerHTML = `
    <div class="ytap-top">
      <div class="ytap-meta">
        <div class="ytap-channel">${escapeHtml(current.channel || '')}</div>
        <div class="ytap-title">${escapeHtml(current.title || '')}</div>
      </div>
    </div>
    <div class="ytap-controls">
      <button id="ytap-back" ${hasHistory ? '' : 'disabled'}>&#9664; Back</button>
      <button id="ytap-skip">Skip &#9654;&#9654;</button>
    </div>
  `;

  document.body.appendChild(overlay);

  const backBtn = overlay.querySelector('#ytap-back');

  backBtn.addEventListener('click', async () => {
    const prev = await popFromHistory();
    if (prev) {
      await setStored({ ytap_current: prev });
      window.location.href = `https://www.youtube.com/watch?v=${prev.videoId}`;
    }
  });

  overlay.querySelector('#ytap-skip').addEventListener('click', async () => {
    // If narration is mid-play, stop it — the pending handler will then navigate immediately
    if (_currentNarrationAudio) {
      console.log('[yt-autopilot] skip interrupted narration');
      stopNarration();
      return;
    }

    const elapsed = video.currentTime - videoStartTime;
    console.log('[yt-autopilot] skip clicked after', Math.round(elapsed), 's');
    const watchPct = video.duration > 0 ? elapsed / video.duration : 0;
    const signal = watchPct;
    await updateChannelScore(current.channel, signal);
    await pushToHistory(current);

    const seg = await getStored('ytap_current_segment');
    const isSegmentBoundary = willStartNewSegment(seg);
    console.log('[yt-autopilot] skip segment state:', seg ? `idx ${seg.segmentIndex}/${seg.videos?.length} topic=${seg.topic}` : 'null', '→ boundary:', isSegmentBoundary);

    const pick = await pickNext();
    if (pick) {
      if (isSegmentBoundary) {
        video.pause();
        setNarrating(true);
        await playNarration('skip_ack');
        setNarrating(false);
      }
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

// waitForVideo() alone gave up permanently on a single 8s miss, stranding the
// session with no overlay and no 'ended' listener since nothing else re-triggers
// initAutoplay() on the same URL. Retry a few times first; if still nothing,
// fall back to whatever <video> exists even if it never hit readyState >= 1 —
// enough to hand the user a Skip button instead of a dead tab.
async function waitForVideoWithRetries(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const video = await waitForVideo();
    if (video) return video;
    console.log(`[yt-autopilot] waitForVideo attempt ${attempt}/${maxAttempts} failed, retrying`);
  }
  const fallback = document.querySelector('video');
  if (fallback) console.log('[yt-autopilot] waitForVideo: using unready video element as last resort');
  return fallback;
}

let autoplayActive = false;
let autoplayInitUrl = '';
let _scrapeInterval = null;

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
  const seg = await getStored('ytap_current_segment');
  const isSegmentBoundary = willStartNewSegment(seg);

  const current = (await getStored('ytap_current')) || {};
  await updateChannelScore(current.channel, 1.0);
  await pushToHistory(current);

  const pick = await pickNext();
  if (pick) {
    if (isSegmentBoundary) {
      const newSeg     = await getStored('ytap_current_segment');
      const narrBucket = resolveContinuationBucket(newSeg);

      // Suppress YouTube's SPA autoplay navigation while narration plays so it
      // can't cut off the audio with its own end-screen countdown.
      const origPushState = history.pushState.bind(history);
      history.pushState = () => {};
      const blockNav = (e) => e.stopImmediatePropagation();
      document.addEventListener('yt-navigate-start', blockNav, { capture: true });

      setNarrating(true);
      await playNarration(narrBucket);
      setNarrating(false);

      history.pushState = origPushState;
      document.removeEventListener('yt-navigate-start', blockNav, { capture: true });
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

  const video = await waitForVideoWithRetries();
  if (!video) {
    console.log('[yt-autopilot] initAutoplay: no video element found after retries — giving up on', url);
    autoplayActive = false;
    autoplayInitUrl = '';
    return;
  }

  console.log('[yt-autopilot] got video element, triggering play');
  video.play().catch(err => console.log('[yt-autopilot] play() blocked:', err.message));
  video.addEventListener('ended', onVideoEnded, { once: true });
  await injectOverlay(video);
  console.log('[yt-autopilot] autoplay loop armed');

  // Periodically re-scrape the sidebar to grow the candidate pool passively.
  if (_scrapeInterval) clearInterval(_scrapeInterval);
  _scrapeInterval = setInterval(async () => {
    const running = await getStored('running');
    if (!running) { clearInterval(_scrapeInterval); _scrapeInterval = null; return; }
    const fresh = getCandidates();
    if (!fresh.length) return;
    const prev = (await getStored('ytap_candidates')) || [];
    const prevById = Object.fromEntries(prev.map(c => [c.videoId, c]));
    const withEmbed = fresh.map(c => ({ ...c, embedding: prevById[c.videoId]?.embedding }));
    const newIds = new Set(fresh.map(c => c.videoId));
    const retained = prev.filter(c => !newIds.has(c.videoId) && !(c.views > 0 && c.views < MIN_VIEWS_HARD));
    const merged = [...withEmbed, ...retained].slice(0, 100);
    await setStored({ ytap_candidates: merged });
    await updateClusters(merged.filter(c => c.embedding));
    embedCandidatesAsync(withEmbed.filter(c => !c.embedding));
    console.log('[yt-autopilot] sidebar scrape:', fresh.length, 'fresh, pool now', merged.length);
  }, 45000);
}

// ─── DJ start ─────────────────────────────────────────────────────────────────
// Shared by the PICK_NEXT message (normal start, content script already live)
// and checkPendingStart() (start was deferred across a navigation/reload
// because the content script wasn't injected yet when the popup tried).

// onPickResolved (if given) fires the instant the pick itself is known — i.e.
// before narration/navigation. PICK_NEXT's sendResponse must happen there, not
// after this function returns: window.location.href below tears down this
// context, which can drop a response sent only after navigation starts and
// make a real success look like a dead message channel to the caller.
async function runDjStartPick(onPickResolved) {
  showDJSplash();
  try {
    const pick = await pickNext();
    onPickResolved?.(pick);
    if (pick) {
      await playNarration('cold_open');
      hideDJSplash();
      await setStored({ ytap_current: pick });
      console.log('[yt-autopilot] navigating to first pick:', pick.videoId);
      window.location.href = `https://www.youtube.com/watch?v=${pick.videoId}`;
    } else {
      hideDJSplash();
    }
    return pick;
  } catch (err) {
    console.error('[yt-autopilot] DJ start pick error:', err);
    hideDJSplash();
    onPickResolved?.(null);
    return null;
  }
}

// Picks up a start that the popup couldn't deliver directly — either the
// active tab wasn't on YouTube (navigated here first) or it was on YouTube
// but predated this content script's injection (e.g. extension reloaded
// while the tab was already open). The popup sets djTabId + ytap_pending_start
// and either navigates or reloads the tab; this runs once the resulting page
// load re-injects content.js. Cleared unconditionally on read so a stale flag
// never re-fires on a later unrelated load.
async function checkPendingStart() {
  const pending = await getStored('ytap_pending_start');
  if (!pending) return;
  await setStored({ ytap_pending_start: false });

  const [djTabId, myTabId] = await Promise.all([getStored('djTabId'), getMyTabId()]);
  if (djTabId !== myTabId) {
    console.log('[yt-autopilot] pending start flag set but this is not the DJ tab — ignoring');
    return;
  }

  console.log('[yt-autopilot] resuming pending DJ start');
  await setStored({ running: true });
  await runDjStartPick();
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PICK_NEXT') {
    console.log('[yt-autopilot] PICK_NEXT received');
    runDjStartPick(pick => { try { sendResponse({ pick }); } catch (_) {} });
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
    const retained = prev.filter(c => !newIds.has(c.videoId) && !(c.views > 0 && c.views < MIN_VIEWS_HARD));
    const merged = [...freshWithEmbed, ...retained].slice(0, 100);
    await setStored({ ytap_candidates: merged });
    await updateClusters(merged.filter(c => c.embedding));
    embedCandidatesAsync(freshWithEmbed.filter(c => !c.embedding));
    console.log('[yt-autopilot] feed scrape:', candidates.length, 'fresh +', retained.length, 'retained =', merged.length, 'total');
  }, 1500);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function warmNarrationColdOpen() {
  if (typeof YTAP_NARRATION === 'undefined') return;
  for (const clip of (YTAP_NARRATION['cold_open'] || [])) {
    const a = new Audio(chrome.runtime.getURL(`audio/cold_open/${clip}`));
    a.load();
  }
}

warmNarrationColdOpen();
loadNarrationState(); // pre-hydrate recency/cooldown from storage so the first playNarration() call doesn't wait on it
scrapeAndEmbedIfFeed();
checkPendingStart();
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
