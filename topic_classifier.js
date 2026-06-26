// Keyword-based topic classifier for segment narration.
// Provides YTAP_CLASSIFY(titles: string[]) → topic string.
// Loaded as a content script before content.js — runs in the same isolated world.

const _YTAP_TAXONOMY = {
  gaming:      ['game', 'gaming', 'gamer', 'gameplay', 'walkthrough', 'playthrough',
                'speedrun', 'minecraft', 'fortnite', 'roblox', 'valorant', 'fps', 'rpg',
                'esports', 'stream', 'console', 'ps5', 'xbox', 'nintendo', 'twitch'],
  tech:        ['programming', 'coding', 'software', 'developer', 'python', 'javascript',
                'typescript', ' ai ', 'llm', 'machine learning', 'deep learning', 'linux',
                'terminal', 'open source', ' api ', 'database', 'backend', 'frontend',
                'computer', 'tutorial', 'browser', 'chrome', 'firefox', 'opera',
                'privacy', 'vpn', 'cybersecurity', 'hack', 'exploit', 'vulnerability'],
  finance:     ['stock', 'investing', 'crypto', 'bitcoin', 'ethereum', 'trading', ' market',
                'finance', ' money', 'wealth', 'portfolio', 'dividend', 'etf', 'revenue',
                'budget', 'financial', 'recession', 'inflation', 'economy'],
  science:     ['science', 'physics', 'chemistry', 'biology', 'space', 'nasa', 'astronomy',
                'quantum', 'research', 'experiment', 'discovery', 'climate', 'evolution',
                'universe', 'engineering', 'mathematics', 'psychology'],
  history:     ['history', 'historical', 'ancient', 'medieval', ' war', 'empire',
                'civilization', 'documentary', 'revolution', ' century', 'president',
                'wwii', 'ww2', 'roman', 'viking', 'cold war', 'dynasty', 'battle',
                'general ', 'colonel', 'siege', 'troops', 'buried'],
  comedy:      ['funny', 'comedy', 'humor', 'laugh', 'joke', 'hilarious', 'meme', 'prank',
                'sketch', 'parody', 'roast', 'stand-up', 'standup', 'fails', ' lol'],
  music:       ['music', ' song', 'album', 'concert', 'live performance', 'cover song',
                'remix', 'producer', ' beat', 'rap', 'hip hop', 'jazz', 'classical',
                'guitar', 'piano', 'singer', 'artist', 'playlist'],
  sports:      ['sports', 'football', 'basketball', 'soccer', 'tennis', ' nba', ' nfl', ' mlb',
                'highlights', ' match', 'tournament', 'athlete', 'fitness', 'workout', 'gym',
                'running', 'cycling', 'boxing', ' mma'],
  food:        ['recipe', 'cooking', ' food', 'restaurant', 'chef', 'kitchen', 'baking',
                'cuisine', ' meal', 'dinner', 'lunch', 'breakfast', 'taste test',
                'mukbang', 'street food', 'eating'],
  pop_culture: ['movie', ' film', 'tv show', 'series', 'netflix', 'disney', 'marvel', 'anime',
                'manga', ' review', 'trailer', 'reaction', 'celebrity', 'drama', 'oscar',
                'actor', 'director'],
};

function YTAP_CLASSIFY(titles) {
  const lower = titles.map(t => ' ' + t.toLowerCase() + ' ');
  const scores = {};
  for (const [topic, keywords] of Object.entries(_YTAP_TAXONOMY)) {
    scores[topic] = 0;
    for (const title of lower) {
      for (const kw of keywords) {
        if (title.includes(kw)) { scores[topic]++; break; } // one hit per title per topic
      }
    }
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'general';
}
