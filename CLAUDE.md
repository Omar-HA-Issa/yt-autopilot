# YouTube Autopilot

## What this is
A Chrome extension that removes the "what do I watch" decision on YouTube.
You click Start, it picks a video from your subscriptions, plays it, and
when it ends (or you hit Skip) it automatically picks the next one — like
Spotify DJ, but for your YouTube subscriptions feed. No menu, no scrolling,
no choosing. It learns what you actually watch vs. skip and gets better
over time.

---

## Overhaul status (read this first)

The selection engine has been fully replaced. Stage 2 is **complete and verified**
on a clean run: no repeats across segments, affinity correctly learns taste (history
cluster affinity climbed 0.038 → 0.169 across completions), coherent same-cluster
blocks (history block hit coherence 0.583), proper cluster branching, COHERENCE_FLOOR
quarantine firing, and de-dup suppression working.

**What runs today:** `pickNextNew()` behind `USE_NEW_PICKER = true`. The legacy
`pickNextLegacy()` / `formSegment()` path is still present but only reachable as a
fallback when clusters aren't ready. **Do not build on the legacy path.** It will be
deleted in Stage 4.

### Remaining work
- **Stage 3** — Narration rewiring: at segment boundary, take the chosen cluster's
  centroid, cosine-classify it against the 12 narration centroids in
  `topic_centroids.js`, use the closest label to select the MP3 folder. The
  classification must NOT appear anywhere in the selection path — narration label
  is audio-only.
- **Stage 4** — Dead-code deletion: remove `formSegment`, `weightedPick`,
  `blendedWeight`, `candidateTopic`, `updateTasteVector`, `TOPIC_ADJACENCY`,
  `SIM_THRESHOLD`, `TASTE_ALPHA`, all `YTAP_CLASSIFY_VEC` call sites in selection,
  and the deprecated storage keys (`ytap_taste_vectors`, `ytap_taste_watch_counts`,
  `ytap_last_segment_topic`).

---

## Current selection system (v2 — what actually runs)

### Candidate pool
Scraped from two sources, merged into `ytap_candidates` (max 100 entries):
- **Feed scrape** (`scrapeAndEmbedIfFeed`): fires 1.5 s after page load on any
  non-watch YouTube page. Reads DOM video cards.
- **Sidebar scrape**: fires every 45 s during playback from the watch-page sidebar.
- **Bootstrap** (`bootstrapPool`): fires at DJ start when embedded pool < 30. Fetches
  `/feed/subscriptions` and parses `ytInitialData` (server-rendered JSON blob) to
  extract candidates without a visible tab. Falls through to an immediate sidebar
  scrape regardless. Treats < 5 extracted candidates as auth/consent failure and logs
  the distinction.

Candidates are filtered on entry: min 5 min duration, min 40k views, no live/Shorts
overlay, no news-pattern titles. Embeddings (`"{channel}: {title}"` → 384-float
all-MiniLM-L6-v2 via offscreen ONNX) are computed async and written back.

### Clustering
`updateClusters(embeddedCandidates)` maintains warm-started k-means (k = `CLUSTER_K`):
- **Cold start**: deferred until ≥ `CLUSTER_K` embedded candidates exist. Uses
  k-means++ initialization, then assigns all candidates.
- **Warm start**: each new candidate is assigned to the nearest centroid by cosine
  similarity; the centroid is nudged with EMA (`ALPHA_CENTROID = 0.10`) and
  re-normalized.

Called whenever the candidate pool changes (feed scrape, sidebar scrape, bootstrap).

### Taste anchors
`ytap_taste_anchors`: up to `ANCHOR_MAX = 10` anchors, each `{centroid: number[384], weight: number}`.

On natural video end (`signal = 1.0`), `updateTasteAnchors(embedding)` is called:
- Finds the nearest existing anchor by cosine.
- If `nearestSim >= ANCHOR_NEW_THRESHOLD (0.50)` and `nearestSim <= ANCHOR_SKIP_SIM (0.95)`:
  nudge centroid with EMA (`ALPHA_ANCHOR_VEC = 0.15`), bump weight (`ALPHA_ANCHOR_WEIGHT = 0.20`).
- If `nearestSim > ANCHOR_SKIP_SIM`: degenerate no-op nudge (anchor already
  aligned to this video) — bump weight only, skip vector update. Logs `skip sim=X.XXX`.
- If `nearestSim < ANCHOR_NEW_THRESHOLD` and `anchors.length < ANCHOR_MAX`: create
  new anchor seeded at the video's embedding.
- If pool full: nudge nearest anyway (no eviction).

Anchors are **independent from clusters**. Clusters = availability structure.
Anchors = preference signal. They are intentionally kept separate.

### Pick loop (`pickNextNew`)

1. **Drain** current segment if `segmentIndex < videos.length` — navigate within
   the stored segment before forming a new one.

2. **Bootstrap check** — if embedded pool < `POOL_BOOTSTRAP_THRESHOLD (30)`, call
   `bootstrapPool()` before proceeding.

3. **Load state** in parallel: clusters, candidates, channel scores, taste anchors,
   recentPicks, ytap_watched, last cluster, total completions.

4. **Runt guard** — per cluster: `available` = members present in pool with
   embeddings. Skip any cluster where `available.length < SEGMENT_SIZE`.

5. **Per-cluster stats**:
   - `affinity` = mean over available members of `nearestAnchorScore(embedding, anchors)`
     (= `sim × weight` to nearest taste anchor). Defaults to 0.5 when no anchors exist.
   - `coherence` = mean cosine of members to their cluster centroid.
   - `penalty` = `RECENTLY_PLAYED_PENALTY (1.5)` if this was the last-chosen cluster, else 0.

6. **COHERENCE_FLOOR quarantine** — clusters with `coherence < COHERENCE_FLOOR (0.40)`
   are excluded from the main softmax pool. Logged as `v2 quarantine: cluster N
   (coherence X.XXX)`. Discovery is exempt — it can still explore quarantined clusters.

7. **Discovery branch** (10% chance after 5+ completions): picks a cluster near
   `lastCluster` by centroid cosine, preferring the one with fewest recent picks.

8. **Softmax cluster selection** (main path):
   `logit = (affinity × coherence^COHERENCE_WEIGHT − penalty) / TEMPERATURE`
   Numerically stable (subtract max before exp). Falls back to full `clusterInfos`
   if all clusters are below `COHERENCE_FLOOR`.

9. **Pool resolution** (`resolveClusterPool`): hard-excludes any video in
   `recentPicks` OR `ytap_watched` from the within-cluster pick pool. If exclusion
   leaves fewer than `SEGMENT_SIZE` fresh candidates, relaxes oldest-first (by
   `max(recentTs, watchedTs)` ascending) until the pool is refillable. Logs starvation
   events. Never returns empty — absolute fallback is all available members.

10. **Anchor pick** (within cluster): score each candidate in the resolved pool as
    `(1 − VIEW_PRIOR_WEIGHT) × (sim × weight × channelScore) + VIEW_PRIOR_WEIGHT × viewPrior`,
    then weighted-random sample.

11. **Fill** (videos 2–3 of segment): sort remaining pool members by score, take top
    `FILL_TOP_N (5)`, weighted-random sample without replacement. Top-N gate preserves
    coherence; randomness within it breaks deterministic repeats.

12. **Persist** segment, update `ytap_last_cluster`, call `addToRecentPicks(anchor.videoId)`.

### Scoring / feedback loop
- **Natural end** (`signal = 1.0`): channel score rises (EMA `ALPHA_CHANNEL = 0.10`),
  legacy taste vector updated (will be removed in Stage 4), taste anchor nudged,
  video written to `ytap_watched` with current timestamp.
- **Skip** (`signal = watchPct`, 0–1): channel score adjusts proportionally. No anchor
  update on skip.

### De-duplication
Two independent layers:
- **`recentPicks`** — `{id, ts}[]`, max 100, persisted across sessions, 30-day TTL.
  Entries age out on read. **Not cleared on DJ restart** (DJ restart clears
  `ytap_current_segment` only). Hard-excludes from pick pool; starvation fallback
  relaxes oldest-first.
- **`ytap_watched`** — `{videoId: timestamp}`, 90-day TTL, written on every natural
  completion. Longer-lived suppression that outlasts recentPicks age-out. Same
  starvation fallback rules.

---

## Tunable constants (current values)

| Constant | Value | What it controls |
|----------|-------|-----------------|
| `CLUSTER_K` | 10 | number of k-means clusters |
| `SEGMENT_SIZE` | 3 | videos per segment; also runt-guard minimum |
| `TEMPERATURE` | 0.4 | softmax temperature for cluster selection |
| `RECENTLY_PLAYED_PENALTY` | 1.5 | subtracted from logit for last-played cluster |
| `COHERENCE_WEIGHT` | 1.0 | coherence exponent in softmax (0 = off) |
| `COHERENCE_FLOOR` | 0.40 | hard-quarantine threshold; below this = excluded from main softmax |
| `DISCOVERY_RATE` | 0.10 | probability of picking a nearby under-watched cluster |
| `VIEW_PRIOR_WEIGHT` | 0.15 | weight of log-view-count in within-cluster score |
| `ANCHOR_NEW_THRESHOLD` | 0.50 | min cosine to nearest anchor before creating a new one |
| `ANCHOR_SKIP_SIM` | 0.95 | above this sim, skip vector nudge (degenerate no-op guard) |
| `ANCHOR_MAX` | 10 | maximum number of taste anchors |
| `ALPHA_CENTROID` | 0.10 | EMA: cluster centroid nudge toward new members |
| `ALPHA_ANCHOR_VEC` | 0.15 | EMA: taste-anchor vector nudge on completion |
| `ALPHA_ANCHOR_WEIGHT` | 0.20 | EMA: taste-anchor weight bump on hit |
| `ALPHA_CHANNEL` | 0.10 | EMA: channel score |
| `USE_NEW_PICKER` | true | set false to fall back to legacy pick loop for A/B |
| `POOL_BOOTSTRAP_THRESHOLD` | 30 | embedded candidates below this → bootstrap fires |
| `FILL_TOP_N` | 5 | top candidates eligible for weighted-random fill |
| `RECENT_PICKS_MAX` | 100 | rolling cap on recentPicks array |
| `RECENT_PICKS_TTL_MS` | 30 days | age-out for recentPicks entries |
| `WATCHED_TTL_MS` | 90 days | suppression window for completed videos |

---

## Core product decisions (don't relitigate without a good reason)

- **No OAuth, no backend, no LLM API calls.** Everything runs client-side.
  DOM-scraping the already-logged-in page gives the same candidate data as
  an API would, with zero setup friction. Tradeoff: scraping is fragile to
  YouTube DOM changes — this is ongoing maintenance, not a one-time risk.

- **No thumbs-up/down button.** Signal comes from implicit behavior only:
  did the user skip early, or watch to the end? That's free signal, zero
  extra user action.

- **Continuous autoplay queue.** The DJ keeps running automatically until
  explicitly stopped. One-pick-at-a-time doesn't solve decision paralysis.

- **No runtime ElevenLabs API calls.** Narration MP3s are pre-generated
  and bundled under `audio/{topic}/`. No API key ever touches the browser.

- **Tab scoping.** Only one DJ session runs at a time. `djTabId` tracks
  which tab owns it. Starting the DJ in a new tab takes over from any
  existing session.

- **Storage persistence model:**
  - `recentPicks` — persists across restarts, 30-day age-out, NOT cleared on start
  - `ytap_current_segment` — cleared on every new DJ session start
  - `ytap_channel_scores` — persists, decays 10% toward neutral each start
  - `ytap_clusters` / `ytap_taste_anchors` / `ytap_watched` — persist indefinitely
  - `running` + `djTabId` — reset on browser startup via `onStartup`

---

## Architecture

```
yt-autopilot/
├── manifest.json          # MV3, permissions: storage + activeTab + offscreen
├── background.js          # service worker — resets state on startup,
│                          #   routes GET_TAB_ID / EMBED / EMBED_AND_STORE
│                          #   messages between content script and offscreen
├── offscreen.html/.js     # runs all-MiniLM-L6-v2 (ONNX/WASM) for embeddings;
│                          #   input is "{channel}: {title}", normalize: true
├── content.js             # the real brain: scrape, cluster, pick, overlay,
│                          #   playback, channel scoring, taste anchors,
│                          #   narration, bootstrap, de-dup
├── content.css            # styling for the injected overlay (bottom-right)
├── topic_classifier.js    # YTAP_CLASSIFY_VEC + YTAP_CLASSIFY — used for
│                          #   NARRATION label selection only (Stage 3).
│                          #   NOT used in selection path.
├── topic_centroids.js     # auto-generated 384-float centroid per topic;
│                          #   regenerate via `node scripts/generate_centroids.js`
├── narration_manifest.js  # YTAP_NARRATION — maps topic → [clip filenames]
├── popup.html/.js         # toolbar icon — Start/Stop + Reset taste profile +
│                          #   pool-thin warning when embedded < 30
├── audio/                 # pre-generated MP3s, 3 clips per topic bucket
│   ├── intro/             #   int01-03.mp3
│   ├── gaming/            #   gam01-03.mp3
│   ├── tech/              #   tec01-03.mp3
│   ├── finance/           #   fin01-03.mp3
│   ├── science/           #   sci01-03.mp3
│   ├── history/           #   his01-03.mp3
│   ├── comedy/            #   com01-03.mp3
│   ├── music/             #   mus01-03.mp3
│   ├── sports/            #   spt01-03.mp3
│   ├── food/              #   fod01-03.mp3
│   ├── film_tv/           #   ftv01-03.mp3
│   ├── commentary/        #   cmt01-03.mp3
│   └── general/           #   gen01-03.mp3
├── models/Xenova/all-MiniLM-L6-v2/   # quantized ONNX model (bundled, ~22MB)
├── scripts/
│   ├── setup_assets.js        # copies WASM + transformers bundle to extension root
│   ├── generate_centroids.js  # re-embeds topic descriptions → topic_centroids.js
│   └── generate_narration.js  # batch-generates MP3s via ElevenLabs API
└── icons/
```

---

## Storage keys

| Key | Description |
|-----|-------------|
| `running` | boolean — is the DJ active |
| `djTabId` | tab ID that owns the current session |
| `recentPicks` | `{id, ts}[]` max 100, persists across sessions, 30-day age-out |
| `ytap_candidates` | `{title, channel, videoId, views, embedding?}[]` max 100 |
| `ytap_current` | current video object being played |
| `ytap_history` | back-stack of played videos, max 50 |
| `ytap_channel_scores` | `{channel: score}` EMA 0–1, persists, decays 10% on start |
| `ytap_clusters` | `{centroids: number[][], members: {[idx]: videoId[]}}` — warm k-means state |
| `ytap_taste_anchors` | `{centroid: number[384], weight: number}[]` max 10 — preference signal |
| `ytap_total_completions` | total naturally-ended videos (used for discovery gate) |
| `ytap_last_cluster` | index of last segment's cluster (for penalty + discovery) |
| `ytap_current_segment` | `{clusterIdx, videos, segmentIndex}` — cleared on session start |
| `ytap_watched` | `{videoId: timestamp}` — 90-day completed-video suppression |

---

## DEPRECATED — pending Stage 4 deletion — do not build on

The following keys and functions exist in `content.js` but belong to the legacy
selection path (`pickNextLegacy` / `formSegment`). They will be deleted in Stage 4.
Do not reference them in new code or rely on them being present.

**Storage keys (legacy only):**
| Key | Description |
|-----|-------------|
| `ytap_taste_vectors` | `{topic: number[384]}` per-topic EMA taste vectors |
| `ytap_taste_watch_counts` | `{topic: number}` natural-end counts per topic |
| `ytap_last_segment_topic` | last segment's topic string |

**Functions (legacy only):**
- `formSegment()` — builds a 3-video segment using topic classification + taste vectors
- `weightedPick()` — weighted random pick using topic-blended scores
- `blendedWeight()` — blends channel score with per-topic cosine similarity
- `candidateTopic()` — calls `YTAP_CLASSIFY_VEC` / `YTAP_CLASSIFY` to label a video
- `updateTasteVector()` — EMA-updates the per-topic taste vector
- `TOPIC_ADJACENCY` map — defines which topics are "adjacent" for discovery
- `YTAP_CLASSIFY_VEC` call sites in the selection path

**What the legacy system did (for reference only):**
Picked an anchor via `blendedWeight(channelScore + cosineSim(embedding, tasteVector[topic]) + viewCount)`,
filled up to 3 by cosine similarity to anchor (threshold 0.30), classified the segment
by embedding dot-product against 12 pre-computed topic centroids, ran discovery by
jumping to an adjacent topic from `TOPIC_ADJACENCY`. This is no longer the active path.

---

## Known issues / active improvement areas

- **YouTube DOM changes** — scraping selectors in `getCandidates()` will break
  occasionally. `getCandidates()` in `content.js` is the place to fix them.
  `ytInitialData` path in `fetchFeedCandidates()` (`richGridRenderer` → `richItemRenderer`
  → `videoRenderer`) carries the same risk.

- **"User paused to do something else" vs "done watching"** — not handled.
  The DJ treats any natural video end as a completed watch (signal 1.0). Deferred.

- **Manual navigation mid-session** — if the user clicks a different video
  themselves, the DJ resumes after it. Whether this is correct is undecided.

- **Candidate pool stalls** — if feed fetch and sidebar both return empty (e.g.,
  on a page the extension doesn't scrape), the DJ will fall back to legacy then stall
  if legacy also has no candidates. Bootstrap partially mitigates this but not fully.

- **Anchor cold start** — with < 3 completions, anchors are single-video point
  estimates and affinity is noisy. The DJ defaults all-cluster affinity to 0.5 when
  no anchors exist. Improves naturally with use.
