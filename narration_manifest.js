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
  cold_open: [
    'co01.mp3', 'co02.mp3', 'co03.mp3', 'co04.mp3', 'co05.mp3', 'co06.mp3', 'co07.mp3', 'co08.mp3',
    'co09.mp3', 'co10.mp3', 'co11.mp3', 'co12.mp3', 'co13.mp3', 'co14.mp3', 'co15.mp3', 'co16.mp3',
  ],

  // ── Mid-session: genre-flavored continuations ────────────────────────────────
  cont_gaming:  ['cgam01.mp3', 'cgam02.mp3', 'cgam03.mp3', 'cgam04.mp3', 'cgam05.mp3', 'cgam06.mp3', 'cgam07.mp3', 'cgam08.mp3'],
  cont_tech:    ['ctec01.mp3', 'ctec02.mp3', 'ctec03.mp3', 'ctec04.mp3', 'ctec05.mp3', 'ctec06.mp3', 'ctec07.mp3', 'ctec08.mp3'],
  cont_finance: ['cfin01.mp3', 'cfin02.mp3', 'cfin03.mp3', 'cfin04.mp3', 'cfin05.mp3', 'cfin06.mp3', 'cfin07.mp3', 'cfin08.mp3'],
  cont_science: ['csci01.mp3', 'csci02.mp3', 'csci03.mp3', 'csci04.mp3', 'csci05.mp3', 'csci06.mp3', 'csci07.mp3', 'csci08.mp3'],
  cont_history: ['chis01.mp3', 'chis02.mp3', 'chis03.mp3', 'chis04.mp3', 'chis05.mp3', 'chis06.mp3', 'chis07.mp3', 'chis08.mp3'],
  cont_comedy:  ['ccom01.mp3', 'ccom02.mp3', 'ccom03.mp3', 'ccom04.mp3', 'ccom05.mp3', 'ccom06.mp3', 'ccom07.mp3', 'ccom08.mp3'],
  cont_food:    ['cfod01.mp3', 'cfod02.mp3', 'cfod03.mp3', 'cfod04.mp3', 'cfod05.mp3', 'cfod06.mp3', 'cfod07.mp3', 'cfod08.mp3'],
  cont_filmtv:  ['cftv01.mp3', 'cftv02.mp3', 'cftv03.mp3', 'cftv04.mp3', 'cftv05.mp3', 'cftv06.mp3', 'cftv07.mp3', 'cftv08.mp3'],  // folder: audio/cont_filmtv/

  // ── Mid-session: generic fallback ───────────────────────────────────────────
  continuation_generic: [
    'cg01.mp3', 'cg02.mp3', 'cg03.mp3', 'cg04.mp3', 'cg05.mp3', 'cg06.mp3', 'cg07.mp3', 'cg08.mp3',
    'cg09.mp3', 'cg10.mp3', 'cg11.mp3', 'cg12.mp3', 'cg13.mp3', 'cg14.mp3', 'cg15.mp3', 'cg16.mp3',
    'cg17.mp3', 'cg18.mp3', 'cg19.mp3', 'cg20.mp3', 'cg21.mp3', 'cg22.mp3', 'cg23.mp3', 'cg24.mp3',
    'cg25.mp3', 'cg26.mp3', 'cg27.mp3', 'cg28.mp3', 'cg29.mp3', 'cg30.mp3',
  ],

  // ── Skip acknowledgement ────────────────────────────────────────────────────
  skip_ack: [
    'sk01.mp3', 'sk02.mp3', 'sk03.mp3', 'sk04.mp3', 'sk05.mp3', 'sk06.mp3', 'sk07.mp3', 'sk08.mp3',
    'sk09.mp3', 'sk10.mp3', 'sk11.mp3', 'sk12.mp3', 'sk13.mp3', 'sk14.mp3', 'sk15.mp3', 'sk16.mp3',
  ],

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
