# YouTube Autopilot

## What this is
A Chrome extension that removes the "what do I watch" decision on YouTube.
You click Start, it picks a video from your subscriptions, plays it, and
when it ends (or you hit Skip) it automatically picks the next one — like
Spotify DJ, but for your YouTube subscriptions feed. No menu, no scrolling,
no choosing. It learns what you actually watch vs. skip and gets better
over time.

## Core product decisions (don't relitigate these without a good reason)

- **No OAuth, no backend, no LLM API calls.** Everything runs client-side.
  We deliberately killed the OAuth/YouTube-Data-API approach because:
  - it requires Google app verification before strangers can install it
  - it doesn't actually buy personalization (no watch-history endpoint exists
    via the API anyway — Google doesn't expose that to third parties)
  - DOM-scraping the already-logged-in page gives us the same candidate
    data (subscriptions feed) with zero setup friction for any installer
  - Tradeoff we accepted: scraping is more fragile to YouTube redesigns
    than an API would be. This is ongoing maintenance, not a one-time risk.

- **No thumbs-up/down button.** Explicit rating UI was cut because nobody
  reliably uses it (confirmed via self-report, not assumption). The real
  signal comes from **implicit behavior**: did the person skip the video
  quickly, or watch it / let it play to completion. That's free signal,
  zero extra user action.

- **Continuous autoplay queue, not one-pick-at-a-time.** A "click for your
  next suggestion" button is just shuffle with extra steps and doesn't
  solve decision paralysis (you're still making a choice every video).
  The whole value proposition requires the DJ to keep running
  automatically until the user explicitly stops it.

- **Personalization signal sources, in order of how much they're used:**
  1. Subscriptions feed = candidate pool (everyone has this, zero setup)
  2. Implicit watched/skipped signal per channel = primary learning signal
  3. (Optional, v2+) Liked Videos / Watch Later = bonus signal IF the user
     actually has populated lists — many users (including the original
     target user) don't, so the system must work fine with zero data here.
  4. (Optional, v2+) Title embeddings for content-similarity scoring and
     segment clustering (grouping a few similar videos together before
     switching topics, mimicking how Spotify DJ runs themed segments
     rather than narrating before every single track).

- **Storage persistence rules:**
  - Recent-picks list (anti-repeat memory): short rolling window
    (~20-30 entries), session-ish, NOT meant to persist forever or the
    candidate pool eventually empties out.
  - Taste profile / channel scores: persists forever in
    `chrome.storage.local`, but updates via an exponential moving average
    (small step size, e.g. α = 0.05–0.1) rather than a flat running total,
    so recent behavior matters more than stale history without ever fully
    discarding the past.

- **Naming:** extension is "YouTube Autopilot", repo is `yt-autopilot`,
  personal GitHub account, private for now (no secrets in the repo either
  way since there's no API key — flip to public once the core loop
  actually works end to end).

- **Tab scoping:** only one DJ session can run at a time. `djTabId` in
  `chrome.storage.local` tracks which tab owns the DJ. Other tabs see
  "Start DJ" in the popup and their `initAutoplay()` bails out. Starting
  the DJ in a new tab takes over from any existing session.

- **Session vs persistent storage:**
  - `recentPicks` cleared on every new DJ session start (popup click),
    so the anti-repeat pool refreshes each time.
  - `ytap_channel_scores` persists forever (the taste profile).
  - `running` + `djTabId` reset on browser startup via `onStartup`.

## Architecture

```
yt-autopilot/
├── manifest.json     # MV3, permissions: storage + activeTab, host: youtube.com
├── background.js     # service worker — resets state on startup,
│                      # answers GET_TAB_ID messages from content scripts
├── content.js        # the real brain: scrape, pick, inject overlay,
│                      # monitor playback, score channels, update storage
├── content.css        # styling for the injected in-page overlay (bottom-right)
├── popup.html/.js     # toolbar icon — Start/Stop control ONLY.
│                      # Dark UI, closes immediately after action.
│                      # Narration + Skip button live in the in-page
│                      # overlay (content.js), NOT the popup, because the
│                      # popup closes the instant focus moves to the video.
└── icons/
```

**Storage keys in use:**
- `running` — boolean, is the DJ active
- `djTabId` — tab ID that owns the current DJ session
- `recentPicks` — array of videoIds, cleared each session (anti-repeat)
- `ytap_candidates` — candidate pool `{title, channel, videoId, embedding?}[]`, scraped from feed and reused on watch pages; embeddings written back async by offscreen document
- `ytap_current` — current video object `{title, channel, videoId}`
- `ytap_history` — back-stack of played videos (max 50)
- `ytap_channel_scores` — `{channelName: score}` taste profile, persists forever
- `ytap_taste_vector` — `number[384]` EMA of watched-video embeddings, persists forever, null until first natural video end
- `ytap_current_segment` — `{topic: string, videos: VideoObj[], segmentIndex: number}`, cleared on DJ session start

Key architectural fact: since there's no OAuth/API, almost all real logic
lives in `content.js` (it has eyes on the DOM). `background.js` stays thin.

State has to survive page navigation, because every auto-advance to a new
video is a full page load — content.js re-runs from scratch each time, so
"is the DJ currently running," the recent-picks list, and the taste profile
all live in `chrome.storage.local`, never in page-local JS variables.

## Phased build plan

- [x] **Phase 0 — Skeleton.** manifest.json + empty background.js,
  content.js, content.css, popup.html. Load unpacked in
  chrome://extensions, confirm it installs with zero errors on
  youtube.com. Don't skip — isolates plumbing bugs from logic bugs.

- [x] **Phase 1 — Scraping.** Content script reads the subscriptions
  feed / homepage DOM, extracts `{title, channel, videoId}` per visible
  video card into a `getCandidates()` function. Console-log and verify
  clean output before moving on.

- [x] **Phase 2 — Dumb pick + storage.** `chrome.storage.local` helpers
  for recent-picks. Pick logic: filter recent picks out of candidates,
  weighted-random over the remainder (recency-only, no embeddings yet).
  Trigger manually from the popup, confirm sane non-repeating picks.

- [x] **Phase 3 — Playback controls + autoplay loop.** Overlay injected
  bottom-right, styled in the spirit of Spotify DJ's now-playing card
  with animated visualizer bars. Transport controls:
  - **Back** — pops from history stack, re-navigates to previous video
  - **Pause/Play** — controls native `<video>` element directly, stays
    in sync with YouTube's own controls via play/pause event listeners
  - **Skip** — records elapsed time, fires score update, picks next
  - Post-roll ads handled — waits for `.ad-showing` to clear before
    advancing. State-across-navigation via `chrome.storage.local`.

- [x] **Phase 4 — Signal feedback.** Per-channel EMA scoring (α = 0.1,
  default score 0.5). Skip < 40% of video → signal 0.0 (score drops).
  Natural video end → signal 1.0 (score rises). Pick algorithm replaced
  with weighted random using channel scores. Scores persist forever in
  `ytap_channel_scores`. This is the point where it's a genuinely
  different product from "shuffle."

- [x] **Phase 5a — transformers.js integration.** Offscreen document
  architecture (content script → background → offscreen) runs
  `all-MiniLM-L6-v2` (quantized, 22MB, bundled in repo). Model files
  committed under `models/Xenova/all-MiniLM-L6-v2/`. WASM + transformers
  bundle copied to extension root via `scripts/setup_assets.js`.
  `embedCandidatesAsync()` fires from `pickNext()` — fire-and-forget,
  offscreen embeds all candidates and background writes embeddings back
  into `ytap_candidates`. No user-visible latency.

- [x] **Phase 5b — embedding-based candidate weighting.** Taste vector
  (`ytap_taste_vector`, 384-float, EMA α=0.15) updated on every natural
  video end. Pick weight = `0.4 × channel_EMA + 0.6 × cosine_sim_to_taste`.
  Graceful degradation: falls back to channel-score-only when embeddings
  aren't ready yet.

- [x] **Phase 5c — clustering + topic taxonomy.** `topic_classifier.js`
  provides `YTAP_CLASSIFY(titles[]) → string` via keyword matching across
  10 buckets (gaming, tech, finance, science, history, comedy, music,
  sports, food, pop_culture) + general fallback. `formSegment()` picks an
  anchor via blended weighting, then fills up to 3 videos by cosine
  similarity to the anchor (threshold 0.2). `ytap_current_segment`
  persists the active segment across page navigations. `pickNext()` drains
  the current segment before forming a new one. Segment boundary logged on
  natural video end — narration call placeholder in place for 5e.
  Feed pages proactively scrape + embed candidates via
  `scrapeAndEmbedIfFeed()` so embeddings are ready before the DJ starts.

- [ ] **Phase 5d — audio asset pipeline.** Write ~100-150 narration lines
  across 10 topic buckets + general. Generate MP3s via ElevenLabs
  (pre-generated, no runtime API calls). Bundle under `audio/{topic}/`.
  `narration_manifest.js` content script exposes `YTAP_NARRATION` mapping
  table. Naming: `{3-char-abbrev}{nn}.mp3` (e.g. `gam01.mp3`, `his03.mp3`).

- [ ] **Phase 5e — narration playback.** `playNarration(topic)` fires at
  segment boundaries (natural end only, not skip). Awaited before
  navigation — 8s hard cap. Anti-repeat: avoids replaying the same clip
  back-to-back. Autoplay policy failures silently skip narration.

- [ ] **Phase 6 — Polish + share.** Narration template variety (avoid
  repetitive phrasing), minimal styling pass, test with 2-3 friends
  sideloaded (no Web Store, no OAuth verification needed for
  personal/known users). Decide afterward whether public Web Store
  publishing is worth pursuing.

## Known risks / things that will need revisiting

- YouTube's DOM changes periodically; scraping selectors WILL break
  occasionally and need small fixes. Expected maintenance, not a bug.
- Distinguishing "user paused to do something else" from "user is done
  watching" is a real edge case — currently not handled, deferred.
- If the person manually clicks a different video themselves mid-session,
  decide whether the DJ queue should resume after or treat that as an
  implicit stop. Not yet decided.
