# Autopilot for YouTube

A Chrome extension that removes the "what do I watch" decision on YouTube.
Click **Start DJ** and it picks a video and plays it, and when it ends (or
you hit Skip) it automatically queues up the next one — like a Spotify DJ,
but for YouTube. Starts from your subscriptions and YouTube feed, then
follows what you actually watch versus skip and gets better the more you
use it. No menu, no scrolling, no choosing.

---

## Features

- **One button.** Start DJ, and YouTube becomes a continuous, autoplaying
  queue built from your subscriptions and YouTube feed — no manual picking
  required.
- **Learns your taste from behavior, not ratings.** There's no thumbs-up or
  thumbs-down. Watching a video to the end is a positive signal; skipping
  early is a negative one. That's it.
- **Coherent "blocks," not random shuffling.** Videos are grouped into topic
  clusters under the hood, so the queue tends to stay in a vibe for a few
  videos at a time instead of whiplashing between unrelated topics — while
  still occasionally branching out to nearby topics you haven't watched much.
- **Spoken narration between videos.** Short pre-recorded voice lines play at
  DJ start, between segments, and on a skip, so transitions don't feel silent
  or robotic. Lines are genre-aware when confidence is high, generic
  otherwise — it never pretends to know more than it does.
- **Runs entirely in your browser.** No account, no backend server, no API
  keys shipped to users, no data leaving your machine except the normal
  requests your browser already makes to YouTube.

## How it works (short version)

1. **Gathering candidates.** The extension reads whichever YouTube feed page
   you're on (usually your home feed) and the video sidebar while something's
   playing (rescraped every 45 seconds) directly from the page — the same
   page your browser already has loaded when you're logged into YouTube. If
   that pool gets thin, it also fetches your subscriptions feed in the
   background. All of it is filtered — no Shorts, livestreams, very short or
   low-view videos, or obvious news-ticker titles.
2. **Understanding what a video is "about."** Each candidate's title and
   channel name is turned into a numeric embedding (a small on-device ML
   model, running fully locally — nothing is sent to a server) so that
   similar videos end up numerically close to each other.
3. **Grouping into clusters.** Those embeddings are grouped into clusters —
   loose topic buckets discovered automatically from whatever's currently in
   your pool, not from a fixed list of genres.
4. **Learning your taste.** Every time you finish a video, the extension
   nudges a small set of "taste anchors" toward that video's embedding, and
   raises a score for that channel. Skipping early does the opposite, in
   proportion to how much of the video you actually watched.
5. **Picking what's next.** When it's time for a new segment, the DJ weighs
   each cluster by how well it matches your taste anchors and how internally
   coherent it currently is, picks one (occasionally branching into something
   adjacent to keep things fresh), and fills a short run of videos from it —
   always skipping anything you've picked or watched recently.
6. **Narrating the transition.** A short voice line plays to bridge into the
   next block — genre-flavored if the system is confident about what the new
   block is, generic otherwise.

If you're looking for the full mechanical detail — exact formulas, tunable
constants, storage schema, edge cases — see [`CLAUDE.md`](./CLAUDE.md), which
is written for someone actively developing the extension rather than using it.

## Installation (unpacked / developer mode)

This extension isn't published on the Chrome Web Store — you load it directly
from source.

1. Clone this repository.
2. Install dependencies and fetch bundled assets:
   ```
   npm install
   npm run setup           # copies the WASM runtime + transformers.js bundle into the repo root
   npm run download-model  # fetches the ~22MB quantized embedding model into models/
   ```
3. In Chrome, go to `chrome://extensions`, enable **Developer mode** (top
   right), click **Load unpacked**, and select the repository folder.
4. Pin the extension to your toolbar for easy access.

## Usage

1. Go to `youtube.com` and open the extension popup.
2. Click **Start DJ**. The DJ takes over the current tab, picks a video, and
   starts playing it.
3. Let it run — videos advance automatically when one ends. Use the on-page
   overlay to **Skip**, **Pause**, or go **Back**.
4. Click **Stop DJ** in the popup at any time to hand control back.
5. If the popup shows a "pool thin" warning, open your subscriptions or home
   feed for a bit so the extension has more videos to learn from and cluster.
6. **Reset taste profile** (in the popup) clears everything the DJ has
   learned — channel scores, taste anchors, clusters, watch/skip history, and
   recent picks — if you want it to start over from scratch. Your
   subscriptions themselves are untouched, since those live on YouTube, not
   in the extension.

## Privacy

- No OAuth, no backend server, no account of any kind.
- No LLM or third-party API calls at runtime. The embedding model and all
  narration audio are bundled with the extension and run/play entirely
  locally.
- The only network requests are the ones your browser already makes to
  YouTube to load feed pages (home, subscriptions, sidebar) and video pages.
- Everything the extension learns (channel scores, taste anchors, watch
  history for de-duplication) is stored locally via `chrome.storage.local`
  and never transmitted anywhere.

## Project structure

```
yt-autopilot/
├── manifest.json          # Chrome extension manifest (MV3)
├── background.js          # service worker — tab tracking, embedding relay
├── offscreen.html/.js     # runs the embedding model (needs a full window context)
├── content.js             # the extension's logic: scraping, clustering,
│                          #   picking, playback, narration, learning
├── content.css            # styling for the on-page overlay
├── topic_centroids.js     # precomputed topic vectors, used for narration labeling only
├── narration_manifest.js  # maps narration situations to audio clip filenames
├── popup.html/.js         # the toolbar popup UI
├── audio/                 # pre-recorded narration clips (ElevenLabs), by bucket
├── models/                # bundled on-device embedding model (ONNX)
├── scripts/               # one-off setup/build scripts (see below)
└── LICENSE
```

## Development

Useful scripts (see `package.json`):

| Command | What it does |
|---|---|
| `npm run setup` | Copies the WASM runtime + transformers.js bundle into the repo root so the extension can load them. |
| `npm run download-model` | Downloads the quantized `all-MiniLM-L6-v2` embedding model into `models/`. |
| `npm run gen-centroids` | Regenerates `topic_centroids.js` from the topic description strings (needed if you change those strings). |
| `npm run gen-narration` | Batch-generates narration MP3s from the `.txt` scripts under `audio/` via the ElevenLabs API (requires `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` env vars; safe to rerun — skips any `.txt` that already has an `.mp3`). |

After changing `content.js`, `background.js`, `popup.*`, or `manifest.json`,
reload the extension from `chrome://extensions` (the refresh icon on the
extension's card) to pick up the changes.

For the full architecture, the exact selection algorithm, tunable constants,
storage schema, and known issues/limitations, see [`CLAUDE.md`](./CLAUDE.md).

## License

MIT — see [LICENSE](./LICENSE).
