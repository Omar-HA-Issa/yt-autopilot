// Maps topic bucket → array of MP3 filenames under audio/{topic}/.
// Loaded as a content script before content.js.

const YTAP_NARRATION = {
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
