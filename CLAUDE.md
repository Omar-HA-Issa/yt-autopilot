# YouTube Autopilot

## What this is
A Chrome extension that removes the "what do I watch" decision on YouTube.
You click Start, it picks a video from your subscriptions, plays it, and
when it ends (or you hit Skip) it automatically picks the next one — like
Spotify DJ, but for your YouTube subscriptions feed. No menu, no scrolling,
no choosing. It learns what you actually watch vs. skip and gets better
over time.

## Status
Core build is complete. Work is now bug fixes, classifier tuning, and UX polish.
No new architectural features are planned.

## Core product decisions (don't relitigate these without a good reason)

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

- **Session vs persistent storage:**
  - `recentPicks` — cleared on every new DJ session start
  - `ytap_channel_scores` — persists, decays 10% toward neutral each start
  - `ytap_taste_vectors` / `ytap_taste_watch_counts` — persist forever
  - `running` + `djTabId` — reset on browser startup via `onStartup`

## Architecture

```
yt-autopilot/
├── manifest.json          # MV3, permissions: storage + activeTab + offscreen
├── background.js          # service worker — resets state on startup,
│                          #   routes GET_TAB_ID / EMBED / EMBED_AND_STORE
│                          #   messages between content script and offscreen
├── offscreen.html/.js     # runs all-MiniLM-L6-v2 (ONNX/WASM) for embeddings;
│                          #   handles EMBED and EMBED_AND_STORE messages
├── content.js             # the real brain: scrape, pick, overlay, playback,
│                          #   channel scoring, taste vectors, narration,
│                          #   segment formation, discovery mode
├── content.css            # styling for the injected overlay (bottom-right)
├── topic_classifier.js    # two classifiers loaded as content scripts:
│                          #   YTAP_CLASSIFY_VEC(vec) → topic (embedding dot-product,
│                          #     primary) and YTAP_CLASSIFY(titles[]) → topic
│                          #     (keyword fallback, 12 buckets + general)
├── topic_centroids.js     # auto-generated — 384-float centroid per topic,
│                          #   compatible with all-MiniLM-L6-v2; regenerate
│                          #   via `node scripts/generate_centroids.js`
├── narration_manifest.js  # YTAP_NARRATION — maps topic → [clip filenames]
├── popup.html/.js         # toolbar icon — Start/Stop + Reset taste profile
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

## How the pick / segment system works

1. **Candidate pool** — scraped from the subscriptions feed on page load and
   from the watch-page sidebar every 45 seconds during playback. Merged into
   `ytap_candidates` (max 100), min 20k views enforced. Embeddings are
   computed async by the offscreen document and written back.

2. **Segment formation** (`formSegment`)
   - Picks an anchor video via blended weight (channel EMA score + cosine
     similarity to the per-topic taste vector + log-normalized view count).
   - Fills up to 3 total videos by cosine similarity to the anchor (threshold
     0.30). No topic constraint on fill — pure similarity.
   - Classifies the segment topic: `YTAP_CLASSIFY_VEC` (centroid dot-product)
     first, keyword fallback second.
   - **Discovery mode** (10% chance after 5+ watched videos): picks from an
     adjacent unexplored topic instead of the dominant one, using
     `TOPIC_ADJACENCY` map. Introduces novelty without feeling random.

3. **Draining** — `pickNext()` drains the current segment in order before
   forming a new one. Segment state survives page navigation via
   `ytap_current_segment` in storage.

4. **Scoring** — on natural video end: signal = 1.0 → channel score rises,
   per-topic taste vector updated (EMA α=0.15), watch count incremented.
   On skip: signal = watchPct (continuous 0–1) → channel score adjusts
   proportionally.

5. **Narration** — plays at DJ start (intro clip) and at segment boundaries.
   At natural end: fires before navigation. At skip: video is paused, clip
   plays, then navigation. Narration is interruptible: pressing Skip while a
   clip is playing stops the audio immediately and navigates. Anti-repeat per
   clip, 8s hard cap.

## Storage keys

| Key | Description |
|-----|-------------|
| `running` | boolean — is the DJ active |
| `djTabId` | tab ID that owns the current session |
| `recentPicks` | videoId[] max 25, cleared each session |
| `ytap_candidates` | `{title, channel, videoId, views, embedding?}[]` max 100 |
| `ytap_current` | current video object |
| `ytap_history` | back-stack of played videos, max 50 |
| `ytap_channel_scores` | `{channel: score}` EMA, persists, decays on start |
| `ytap_taste_vectors` | `{topic: number[384]}` per-topic EMA taste vectors |
| `ytap_taste_watch_counts` | `{topic: number}` natural-end counts per topic |
| `ytap_current_segment` | `{topic, videos, segmentIndex}`, cleared on session start |
| `ytap_last_segment_topic` | last segment's topic, used for topic diversity |

## Known issues / active improvement areas

- **Topic classifier accuracy** — `YTAP_CLASSIFY_VEC` (embedding dot-product
  against pre-computed centroids) is the primary classifier; keyword matching
  in `YTAP_CLASSIFY` is the fallback. Both can misclassify edge cases.
  Centroid descriptions in `scripts/generate_centroids.js` are the tuning
  lever — edit and re-run `node scripts/generate_centroids.js` to regenerate
  `topic_centroids.js`. Keyword lists in `topic_classifier.js` are the
  fallback tuning lever.

- **YouTube DOM changes** — scraping selectors will break occasionally.
  `getCandidates()` in `content.js` is the place to fix them.

- **"User paused to do something else" vs "done watching"** — not handled.
  The DJ treats any natural video end as a completed watch (signal 1.0).
  Deferred.

- **Manual navigation mid-session** — if the user clicks a different video
  themselves, the DJ resumes after it. Whether this is correct is undecided.

- **Candidate pool stalls** — if both feed and watch sidebar return empty
  (e.g., on a page the extension doesn't scrape), the DJ will stall.
