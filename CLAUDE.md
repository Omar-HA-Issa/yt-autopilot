# yt-autopilot

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

- **Naming:** repo is `yt-autopilot`, personal GitHub account, private
  for now (no secrets in the repo either way since there's no API key —
  flip to public once the core loop actually works end to end).

## Architecture

```
yt-autopilot/
├── manifest.json     # MV3, permissions: storage only, host: youtube.com
├── background.js     # service worker — minimal, mostly message relay
├── content.js        # the real brain: scrape, pick, inject overlay,
│                      # monitor playback, update storage
├── content.css        # styling for the injected in-page overlay
├── popup.html/.js     # toolbar icon — Start/Stop control ONLY.
│                      # Narration + Skip button live in the in-page
│                      # overlay (content.js), NOT the popup, because the
│                      # popup closes the instant focus moves to the video.
└── icons/
```

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

- [ ] **Phase 2 — Dumb pick + storage.** `chrome.storage.local` helpers
  for recent-picks. Pick logic: filter recent picks out of candidates,
  weighted-random over the remainder (recency-only, no embeddings yet).
  Trigger manually from the popup, confirm sane non-repeating picks.

- [ ] **Phase 3 — Playback + autoplay loop.** On pick: navigate to video,
  autoplay, inject overlay (narration line + Skip button). Monitor
  playback time to classify skip vs. watched. On skip or video-end,
  auto-pick the next candidate and repeat. This is the highest-engineering-
  risk phase — state-across-navigation and playback monitoring both live
  here.

- [ ] **Phase 4 — Signal feedback.** Wire watched/skipped events into a
  per-channel score in storage (EMA update, see persistence rules above).
  Bias future picks toward higher-scoring channels. This is the point
  where it's a genuinely different product from "shuffle," not before.

- [ ] **Phase 5 — NLP layer (optional, only after 1-4 are solid).**
  Client-side embeddings (transformers.js) on candidate titles. Replace
  recency-only weighting with similarity-to-taste-profile weighting.
  Add segment clustering: group ~3-4 similar candidates, narrate once per
  segment instead of once per video. Skip entirely if 1-4 already feels
  good — this is polish, not core.

- [ ] **Phase 6 — Polish + share.** Narration template variety (avoid
  repetitive phrasing), minimal styling pass, test with 2-3 friends
  sideloaded (no Web Store, no OAuth verification needed for
  personal/known users). Decide afterward whether public Web Store
  publishing is worth pursuing.

## Known risks / things that will need revisiting

- YouTube's DOM changes periodically; scraping selectors WILL break
  occasionally and need small fixes. Expected maintenance, not a bug.
- Distinguishing "user paused to do something else" from "user is done
  watching" in playback monitoring is a real edge case, not yet solved —
  revisit during Phase 3.
- If the person manually clicks a different video themselves mid-session,
  decide whether the DJ queue should resume after or treat that as an
  implicit stop. Not yet decided.
