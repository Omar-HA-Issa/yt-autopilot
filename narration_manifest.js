// Maps narration bucket → array of MP3 filenames under audio/{bucket}/.
// Loaded as a content script before content.js.
//
// ── New buckets (Stage 3 rewrite) ────────────────────────────────────────────
// cold_open            — single clip at DJ start; genre NOT named
// continuation_generic — mid-session, below confidence threshold or unmatched genre
// cont_<genre>         — mid-session, above threshold for that genre; names the genre
// skip_ack             — fires at segment boundary when the user skips
//
// music and sports have NO dedicated cont_ bucket; they fall through to
// continuation_generic (their clusters are too thematically broad to name confidently).
//
// ── Legacy buckets (kept for fallback / old path compatibility) ───────────────
// intro, gaming, tech, finance, science, history, comedy, music, sports, food,
// film_tv, commentary, general — untouched; audio files remain on disk.
//
// Files are filled in by generate_narration.js after lines are written and approved.

const YTAP_NARRATION = {
  // ── DJ start ────────────────────────────────────────────────────────────────
  cold_open:            [],  // ~15 lines — cold open, genre NOT named

  // ── Mid-session: genre-flavored continuations ────────────────────────────────
  cont_gaming:          [],  // ~6-8 lines
  cont_tech:            [],  // ~6-8 lines
  cont_finance:         [],  // ~6-8 lines
  cont_science:         [],  // ~6-8 lines
  cont_history:         [],  // ~6-8 lines
  cont_comedy:          [],  // ~6-8 lines
  cont_food:            [],  // ~6-8 lines
  cont_filmtv:          [],  // ~6-8 lines  (folder: audio/cont_filmtv/)

  // ── Mid-session: generic fallback ───────────────────────────────────────────
  continuation_generic: [],  // ~25 lines — below threshold or music/sports/unmatched

  // ── Skip acknowledgement ────────────────────────────────────────────────────
  skip_ack:             [],  // ~15 lines

  // ── Legacy (keep; referenced by old path and existing audio files) ───────────
  intro:       ['int01.mp3', 'int02.mp3', 'int03.mp3'],
  gaming:      ['gam01.mp3', 'gam02.mp3', 'gam03.mp3'],
  tech:        ['tec01.mp3', 'tec02.mp3', 'tec03.mp3'],
  finance:     ['fin01.mp3', 'fin02.mp3', 'fin03.mp3'],
  science:     ['sci01.mp3', 'sci02.mp3', 'sci03.mp3'],
  history:     ['his01.mp3', 'his02.mp3', 'his03.mp3'],
  comedy:      ['com01.mp3', 'com02.mp3', 'com03.mp3'],
  music:       ['mus01.mp3', 'mus02.mp3', 'mus03.mp3'],
  sports:      ['spt01.mp3', 'spt02.mp3', 'spt03.mp3'],
  food:        ['fod01.mp3', 'fod02.mp3', 'fod03.mp3'],
  film_tv:     ['ftv01.mp3', 'ftv02.mp3', 'ftv03.mp3'],
  commentary:  ['cmt01.mp3', 'cmt02.mp3', 'cmt03.mp3'],
  general:     ['gen01.mp3', 'gen02.mp3', 'gen03.mp3'],
};
