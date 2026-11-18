# YouTube Autopilot

## What this is
A Chrome extension that removes the "what do I watch" decision on YouTube.
You click Start, it picks a video and plays it, and when it ends (or you
hit Skip) it automatically picks the next one — like Spotify DJ, but for
YouTube. Starts from your subscriptions and YouTube feed, then follows what
you actually watch vs. skip and gets better over time. No menu, no
scrolling, no choosing.

---

## Where things stand

- **Selection engine (v2): complete and live.** `pickNextNew()` in `content.js`
  is the only picker — Stage 4 dead-code deletion is done. The old topic-classifier/
  taste-vector legacy path (`pickNextLegacy`, `formSegment`, `weightedPick`,
  `blendedWeight`, `candidateTopic`, `updateTasteVector`, `TOPIC_ADJACENCY`,
  `topic_classifier.js`) is fully removed, along with its storage keys
  (`ytap_taste_vectors`, `ytap_taste_watch_counts`, `ytap_last_segment_topic`) and
  the legacy narration manifest buckets.

- **Cold-start fallback replaces the legacy picker.** A brand-new install (no
  clusters warm yet) no longer falls back to the topic-classifier system —
  instead `pickNextNew()` tries a direct, awaited embed-and-cluster retry
  (`coldStartEmbedAndCluster()`), and only drops to a lightweight weighted-random
  pick by channel score + view count (`pickNextColdStart()`) if that still isn't
  enough. See [Cold-start fallback](#cold-start-fallback) below.

- **Narration (Stage 3): complete.** Session-position/confidence-based lines
  (see [Narration system](#narration-system-stage-3) below), 126 lines generated
  via ElevenLabs, `narration_manifest.js` is now purely the 11 live buckets (legacy
  12-topic buckets removed — their audio was already deleted from disk).

- **Open item — continuing next session:** narration audio pacing. ElevenLabs
  `speed` in `scripts/generate_narration.js` went default `1.0` → `0.85` (test) →
  settled at `0.9`. Whether the lines themselves should also be lengthened (they
  run 9–17 words) was raised but deferred — pick up there.

---

## Selection system (v2 — what actually runs)

### Candidate pool
Scraped from three sources, merged into `ytap_candidates` (max 100 entries):
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

4. **Cold-start gate** — if clusters aren't warm yet (`centroids.length < CLUSTER_K`),
   try the cold-start embed-and-cluster retry once (see
   [Cold-start fallback](#cold-start-fallback)), then re-enter this loop. If still
   not warm after that, drop to `pickNextColdStart()`.

5. **Runt guard** — per cluster: `available` = members present in pool with
   embeddings. Skip any cluster where `available.length < SEGMENT_SIZE`. If this
   leaves zero eligible clusters, same cold-start gate as step 4 applies.

6. **Per-cluster stats**:
   - `affinity` = mean over available members of `nearestAnchorScore(embedding, anchors)`
     (= `sim × weight` to nearest taste anchor). Defaults to 0.5 when no anchors exist.
   - `coherence` = mean cosine of members to their cluster centroid.
   - `penalty` = `RECENTLY_PLAYED_PENALTY (1.5)` if this was the last-chosen cluster, else 0.

7. **COHERENCE_FLOOR quarantine** — clusters with `coherence < COHERENCE_FLOOR (0.40)`
   are excluded from the main softmax pool. Logged as `v2 quarantine: cluster N
   (coherence X.XXX)`. Discovery is exempt — it can still explore quarantined clusters.

8. **Discovery branch** (10% chance after 5+ completions): picks a cluster near
   `lastCluster` by centroid cosine, preferring the one with fewest recent picks.

9. **Softmax cluster selection** (main path):
   `logit = (affinity × coherence^COHERENCE_WEIGHT − penalty) / TEMPERATURE`
   Numerically stable (subtract max before exp). Falls back to full `clusterInfos`
   if all clusters are below `COHERENCE_FLOOR`.

10. **Pool resolution** (`resolveExclusionPool` — shared with the cold-start
    fallback picker, see below): hard-excludes any video in `recentPicks` OR
    `ytap_watched` from the within-cluster pick pool. If exclusion leaves fewer
    than `SEGMENT_SIZE` fresh candidates, relaxes oldest-first (by
    `max(recentTs, watchedTs)` ascending) until the pool is refillable. Logs
    starvation events. Never returns empty — absolute fallback is all available
    members.

11. **Anchor pick** (within cluster): score each candidate in the resolved pool as
    `(1 − VIEW_PRIOR_WEIGHT) × (sim × weight × channelScore) + VIEW_PRIOR_WEIGHT × viewPrior`,
    then weighted-random sample.

12. **Fill** (videos 2–3 of segment): sort remaining pool members by score, take top
    `FILL_TOP_N (5)`, weighted-random sample without replacement. Top-N gate preserves
    coherence; randomness within it breaks deterministic repeats.

13. **Persist** segment, update `ytap_last_cluster`, call `addToRecentPicks(anchor.videoId)`.
    Note: only the anchor is added here — fill videos (2–3) get added to `recentPicks`
    when actually drained/served, not at segment-formation time.

### Cold-start fallback

Fires only when `pickNextNew()` finds clusters aren't usable yet — in practice,
only on a brand-new install's very first pick, before `CLUSTER_K` candidates have
been embedded and clustered.

1. **`coldStartEmbedAndCluster()`** — embeds whatever candidates are still missing
   an embedding directly via the awaited `EMBED` message (not the fire-and-forget
   `EMBED_AND_STORE` path used everywhere else), bounded by
   `COLD_START_EMBED_TIMEOUT_MS (15s)`. Writes the results back to
   `ytap_candidates` and runs `updateClusters()` once on the result.
2. `pickNextNew()` retries itself once (`coldStartRetried` guard — no infinite loop).
3. **`pickNextColdStart()`** — last resort if clusters are still not usable after
   the retry (embed timed out, still < `CLUSTER_K` embedded, or no eligible
   cluster survives the runt guard). Weighted-random pick by channel score + log
   view count only — no clustering, no topics. Persists a 1-video
   `ytap_current_segment` (no `narrationLabel`, so narration falls through to
   `continuation_generic`) and adds the pick to `recentPicks` like any other pick.

The DJ splash / cold-open narration is already showing during this window, so a
few extra seconds of wait on the very first pick is acceptable. Both steps log
which path was taken.

### Scoring / feedback loop
- **Natural end** (`signal = 1.0`): channel score rises (EMA `ALPHA_CHANNEL = 0.10`),
  taste anchor nudged, video written to `ytap_watched` with current timestamp,
  `ytap_total_completions` incremented.
- **Skip** (`signal = watchPct`, 0–1): channel score adjusts proportionally. No anchor
  update on skip.

### De-duplication
Two independent layers, both enforced via `resolveExclusionPool()` (shared by
the v2 cluster picker and the cold-start fallback picker):
- **`recentPicks`** — `{id, ts}[]`, max 100, persisted across sessions, 30-day TTL.
  Entries age out on read. **Not cleared on DJ restart** (DJ restart clears
  `ytap_current_segment` only). Hard-excludes from pick pool; starvation fallback
  relaxes oldest-first.
- **`ytap_watched`** — `{videoId: timestamp}`, 90-day TTL, written on every natural
  completion. Longer-lived suppression that outlasts recentPicks age-out. Same
  starvation fallback rules.

---

## Narration system (Stage 3)

Rewritten from per-topic lines to session-position/confidence-based lines — the old
system named genres with confidence the clustering doesn't have, described mechanisms
("subscriptions") the tool doesn't use, and played two clips back-to-back at DJ start.

**11 buckets, 126 lines total**, all under `audio/<bucket>/`:
- `cold_open` (16) — plays once at DJ start only. No genre named.
- `cont_gaming` / `cont_tech` / `cont_finance` / `cont_science` / `cont_history` /
  `cont_comedy` / `cont_food` / `cont_filmtv` (8 each) — mid-session, genre named but
  softened ("history-flavored"), used when classification confidence clears the gate.
- `continuation_generic` (30) — mid-session, below-confidence or unmatched genre
  (also covers music/sports, which have no dedicated bucket — too thematically broad).
- `skip_ack` (16) — plays only when a skip forms a **new segment** (not on every skip;
  mid-segment skips that just drain the queue stay silent).

**Runtime wiring** (`content.js`):
- `classifyForNarration(centroid)` — cosine-classifies the chosen cluster's centroid
  against `YTAP_TOPIC_CENTROIDS` (`topic_centroids.js`, 12 topics including `general`).
  Audio-only; never touches selection.
- `resolveContinuationBucket(seg)` — applies `NARRATION_CONFIDENCE_THRESHOLD (0.40)`
  via `CONT_BUCKET_MAP` to pick `cont_<genre>` or fall back to `continuation_generic`.
  A segment with no `narrationLabel` (the cold-start fallback's segment shape)
  always falls through to `continuation_generic` too.
- `playNarration(bucket)` — picks a clip, excluding the last `ceil(bucketSize/2)`
  played (FIFO), full-reset only if literally everything is excluded. Applies
  `NARRATION_COOLDOWN_MS (20s)` cross-bucket suppression.
- **Persistence**: `_narrationRecency` / `_lastNarrationTs` mirror to
  `ytap_narration_recency` / `ytap_narration_last_ts` — every segment boundary is a
  hard navigation (`window.location.href`) that fully re-injects the content script
  and resets plain module state, so without persisting these, anti-repetition and
  the cooldown would be inert on every segment, not just a manual reload.

**Generation**: `scripts/generate_narration.js` reads every `audio/**/*.txt`, calls
ElevenLabs (`eleven_multilingual_v2`), writes the `.mp3` alongside it with the same
basename — filenames are fully determined by the `.txt` scripts, so the manifest can
be (and was) filled in before generation ran. Skips any `.txt` with an existing `.mp3`,
so reruns are cheap/safe. Current `VOICE_SETTINGS.speed = 0.9` (default is `1.0`,
range `0.7–1.2`) — tuned down because the voice was reading too fast at default.

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
| `POOL_BOOTSTRAP_THRESHOLD` | 30 | embedded candidates below this → bootstrap fires |
| `FILL_TOP_N` | 5 | top candidates eligible for weighted-random fill |
| `COLD_START_EMBED_TIMEOUT_MS` | 15,000 | timeout on the direct awaited embed retry before falling to the lightweight pick |
| `RECENT_PICKS_MAX` | 100 | rolling cap on recentPicks array |
| `RECENT_PICKS_TTL_MS` | 30 days | age-out for recentPicks entries |
| `WATCHED_TTL_MS` | 90 days | suppression window for completed videos |
| `NARRATION_CONFIDENCE_THRESHOLD` | 0.40 | min cosine to nearest topic centroid to use genre (`cont_*`) narration |
| `NARRATION_COOLDOWN_MS` | 20,000 | suppress narration if another clip played within this window |

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
  and bundled under `audio/<bucket>/`. No API key ever touches the browser.

- **Tab scoping.** Only one DJ session runs at a time. `djTabId` tracks
  which tab owns it. Starting the DJ in a new tab takes over from any
  existing session.

- **Storage persistence model:**
  - `recentPicks` — persists across restarts, 30-day age-out, NOT cleared on start
  - `ytap_current_segment` — cleared on every new DJ session start
  - `ytap_channel_scores` — persists, decays 10% toward neutral each start
  - `ytap_clusters` / `ytap_taste_anchors` / `ytap_watched` — persist indefinitely
  - `ytap_narration_recency` / `ytap_narration_last_ts` — persist indefinitely,
    mirror in-memory narration state across hard navigations
  - `running` + `djTabId` — reset on browser startup via `onStartup`

---

## Architecture

```
yt-autopilot/
├── manifest.json          # MV3, permissions: storage + activeTab + offscreen
│                          #   web_accessible_resources: audio/*/*.mp3 (wildcard,
│                          #   covers any bucket folder name without edits)
├── background.js          # service worker — resets state on startup,
│                          #   routes GET_TAB_ID / EMBED / EMBED_AND_STORE
│                          #   messages between content script and offscreen
├── offscreen.html/.js     # runs all-MiniLM-L6-v2 (ONNX/WASM) for embeddings;
│                          #   input is "{channel}: {title}", normalize: true
├── content.js             # the real brain: scrape, cluster, pick, overlay,
│                          #   playback, channel scoring, taste anchors,
│                          #   narration, bootstrap, cold-start fallback, de-dup
├── content.css            # styling for the injected overlay (bottom-right)
├── topic_centroids.js     # auto-generated 384-float centroid per topic (12
│                          #   topics incl. general); regenerate via
│                          #   `node scripts/generate_centroids.js`. Read only
│                          #   by classifyForNarration() — audio labeling, never
│                          #   the selection path.
├── narration_manifest.js  # YTAP_NARRATION — maps bucket → [clip filenames];
│                          #   11 live buckets, one per Stage 3 narration system
├── popup.html/.js         # toolbar icon — Start/Stop + Reset taste profile +
│                          #   pool-thin warning when embedded < 30
├── audio/                 # pre-generated MP3s + source .txt scripts, one
│                          #   subfolder per narration bucket:
│   ├── cold_open/         #   16 clips — co01-16.mp3
│   ├── cont_gaming/       #   8 clips  — cgam01-08.mp3
│   ├── cont_tech/         #   8 clips  — ctec01-08.mp3
│   ├── cont_finance/      #   8 clips  — cfin01-08.mp3
│   ├── cont_science/      #   8 clips  — csci01-08.mp3
│   ├── cont_history/      #   8 clips  — chis01-08.mp3
│   ├── cont_comedy/       #   8 clips  — ccom01-08.mp3
│   ├── cont_food/         #   8 clips  — cfod01-08.mp3
│   ├── cont_filmtv/       #   8 clips  — cftv01-08.mp3
│   ├── continuation_generic/ # 30 clips — cg01-30.mp3
│   └── skip_ack/          #   16 clips — sk01-16.mp3
├── models/Xenova/all-MiniLM-L6-v2/   # quantized ONNX model (bundled, ~22MB)
└── scripts/
    ├── setup_assets.js        # copies WASM + transformers bundle to extension root
    ├── download_model.js      # one-time: fetches all-MiniLM-L6-v2 into models/
    ├── generate_centroids.js  # re-embeds topic descriptions → topic_centroids.js
    └── generate_narration.js  # batch-generates MP3s via ElevenLabs API;
                                #   ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID env vars
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
| `ytap_narration_recency` | `{bucket: filename[]}` — mirrors `_narrationRecency`, survives hard navigations |
| `ytap_narration_last_ts` | timestamp of last narration play — mirrors `_lastNarrationTs` for cooldown |

---

## Known issues / active improvement areas

- **Narration audio pacing** — `speed = 0.9` in `generate_narration.js` fixed the
  "reading too fast" complaint; whether the lines also need to be lengthened
  (currently 9–17 words) is still open. Pick up here next session.

- **YouTube DOM changes** — scraping selectors in `getCandidates()` will break
  occasionally. `getCandidates()` in `content.js` is the place to fix them.
  `ytInitialData` path in `fetchFeedCandidates()` (`richGridRenderer` → `richItemRenderer`
  → `videoRenderer`) carries the same risk.

- **"User paused to do something else" vs "done watching"** — not handled.
  The DJ treats any natural video end as a completed watch (signal 1.0). Deferred.

- **Manual navigation mid-session** — if the user clicks a different video
  themselves, the DJ resumes after it. Whether this is correct is undecided.

- **Candidate pool stalls** — if feed fetch and sidebar both return empty (e.g.,
  on a page the extension doesn't scrape), the pool stays thin and the cold-start
  fallback keeps firing on every pick. Bootstrap partially mitigates this but not fully.

- **Anchor cold start** — with < 3 completions, anchors are single-video point
  estimates and affinity is noisy. The DJ defaults all-cluster affinity to 0.5 when
  no anchors exist. Improves naturally with use.
