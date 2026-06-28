// Keyword-based topic classifier for segment narration.
// Provides YTAP_CLASSIFY(titles: string[]) → topic string.
// Loaded as a content script before content.js — runs in the same isolated world.

const _YTAP_TAXONOMY = {
  gaming:      ['game', 'gaming', 'gamer', 'gameplay', 'walkthrough', 'playthrough',
                'speedrun', 'minecraft', 'fortnite', 'roblox', 'valorant', 'fps', 'rpg',
                'esports', 'stream', 'console', 'ps5', 'xbox', 'nintendo', 'twitch',
                'pvp', "let's play", 'lets play', 'achievement', 'dlc', 'raid', 'boss fight',
                'loot', 'playstation', 'steam', 'mmo', 'moba', 'battle royale', 'open world',
                'indie game', 'retro game', 'emulator', 'replay', 'mod ', 'modded',
                'patch notes', 'early access', 'game review', 'video game',
                'bannerlord', 'mount and blade', 'total war', 'age of empires',
                'crusader kings', 'hearts of iron', 'strategy game', 'grand strategy',
                'turn-based', ' rts ', 'real-time strategy', 'wargame', 'civilization vi',
                'civilization v', 'civ 6', 'civ 5', 'stellaris', 'europa universalis'],

  tech:        ['programming', 'coding', 'software', 'developer', 'python', 'javascript',
                'typescript', ' ai ', 'llm', 'machine learning', 'deep learning', 'linux',
                'terminal', 'open source', ' api ', 'database', 'backend', 'frontend',
                'computer', 'tutorial', 'browser', 'chrome', 'firefox', 'opera',
                'privacy', 'vpn', 'cybersecurity', 'hack', 'exploit', 'vulnerability',
                'iphone', 'android', 'smartphone', 'apple', 'microsoft', 'google',
                'startup', 'robotics', 'automation', 'cloud', 'hardware', 'benchmark',
                'gpu', 'cpu', ' chip', 'semiconductor', 'chatgpt', 'openai', 'gemini',
                'data science', 'neural network', 'github', 'docker', 'aws', 'azure',
                'windows', 'macos', 'tech review', 'unboxing'],

  finance:     ['stock', 'investing', 'crypto', 'bitcoin', 'ethereum', 'trading', ' market',
                'finance', ' money', 'wealth', 'portfolio', 'dividend', 'etf', 'revenue',
                'budget', 'financial', 'recession', 'inflation', 'economy',
                'real estate', 'housing market', ' bank', 'debt', 'mortgage', 'hedge fund',
                ' tax', 'retirement', 'passive income', 'side hustle', 'wall street',
                'interest rate', 'federal reserve', 'bankruptcy', ' salary', 'millionaire',
                'billionaire', 'scam', 'fraud', 'ponzi', 'ruined financially',
                'trading academy', 'venture capital', 'startup funding', 'insurance'],

  science:     ['science', 'physics', 'chemistry', 'biology', 'space', 'nasa', 'astronomy',
                'quantum', 'research', 'experiment', 'discovery', 'climate', 'evolution',
                'universe', 'engineering', 'mathematics', 'psychology',
                'genetics', ' dna', ' gene', 'medical', 'vaccine', 'black hole', 'galaxy',
                'civilization of ', 'ancient civilization',
                ' planet', 'mars', 'neuroscience', 'nuclear', 'fossil', 'prehistoric',
                'ocean', 'marine', 'ecology', 'environment', 'particle', 'relativity',
                'scientific', 'anatomy', 'surgery', 'disease', 'cancer', 'stem cell'],

  history:     ['history', 'historical', ' war', 'empire',
                'documentary history', 'revolution', ' century', 'historical figure',
                'wwii', 'ww2', 'ww1', 'wwi', 'world war', 'cold war',
                'dynasty', 'battle of ', 'battle at ', 'great battle', 'famous battle',
                'colonel', 'siege', 'troops',
                'genocide', 'massacre', 'atrocity', 'overthrew', 'overthrow',
                'coup', 'assassination', 'assassin', 'colonial', 'colonialism', 'slavery',
                'enslaved', 'uprising', 'rebellion', 'archive', 'kingdom',
                'monarchy', 'treaty', 'occupation', 'resistance', 'historical drama',
                'military history', 'historical documentary'],

  comedy:      ['funny', 'comedy', 'humor', 'laugh', 'joke', 'hilarious', 'meme', 'prank',
                'sketch', 'parody', 'roast', 'stand-up', 'standup', 'fails', ' lol',
                'try not to laugh', 'bloopers', 'satire', 'cringe', 'fails compilation',
                'funny compilation', 'awkward', 'spoof', 'gag', 'trolling', 'punchline',
                'comedic', 'skit', 'improv', 'sitcom'],

  music:       ['music', ' song', 'album', 'concert', 'live performance', 'cover song',
                'remix', 'producer', ' beat', 'rap', 'hip hop', 'jazz', 'classical',
                'guitar', 'piano', 'singer', 'artist', 'playlist',
                'music video', ' mv ', 'lyrics', ' band ', 'rock ', ' pop ', 'r&b',
                'soul', 'country', 'grammy', 'vinyl', 'recording studio', 'tour ',
                'metal', 'punk', 'indie', 'funk', 'orchestra', 'choir', 'vocals',
                'bass ', 'drums', 'mixing', 'mastering', 'sample', 'freestyle'],

  sports:      ['sports', 'football', 'basketball', 'soccer', 'tennis', ' nba', ' nfl', ' mlb',
                'highlights', ' match', 'tournament', 'athlete', 'fitness', 'workout', 'gym',
                'running', 'cycling', 'boxing', ' mma',
                'baseball', 'volleyball', 'swimming', 'golf', 'cricket', 'rugby', 'hockey',
                ' nhl', 'formula 1', ' f1 ', 'racing', 'olympic', 'championship', 'league',
                'weightlifting', 'marathon', ' goal', 'touchdown', 'draft', 'transfer',
                'training', 'coach', 'season ', 'playoff', 'finals', 'world cup',
                'ufc', 'wrestling', 'triathlon', 'obstacle course'],

  food:        ['recipe', 'cooking', ' food', 'restaurant', 'chef', 'kitchen', 'baking',
                'cuisine', ' meal', 'dinner', 'lunch', 'breakfast', 'taste test',
                'mukbang', 'street food', 'eating',
                'grilling', ' bbq', 'barbecue', 'vegan', 'vegetarian', 'keto',
                'dessert', ' cake', 'cookie', ' bread', 'snack', 'pizza', 'burger',
                'sushi', 'ramen', 'nutrition', ' diet', 'pastry', 'cocktail', ' wine',
                ' beer', 'grocery', 'meal prep', 'food review', 'fast food', 'healthy'],

  film_tv:     ['movie', ' film', 'tv show', 'series', 'netflix', 'disney', 'marvel', 'anime',
                'manga', 'trailer', 'actor', 'director', 'oscar', 'emmy', 'bafta',
                'golden globe', 'streaming', 'hbo', 'hulu', 'amazon prime', 'superhero',
                'box office', 'sequel', 'remake', 'franchise', 'rewatch', 'based on',
                'cinematic', 'plot twist', 'ending explained', 'movie review', 'film review',
                'show review', 'animated film', 'documentary film', 'short film'],

  commentary:  ['exposed', 'cancelled', 'cancel', 'viral', 'influencer', 'youtube drama',
                'creator drama', 'internet drama', 'drama', 'controversy',
                'video essay', 'deep dive', 'iceberg', 'podcast',
                'commentary', ' rant', 'responding to', 'my response', 'hot take',
                'unpopular opinion', 'reaction video', 'reacting to', 'callout',
                'tiktok drama', 'exposing', 'the truth about', 'why i left',
                'what happened to', 'the problem with', 'we need to talk about'],
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

// Embedding-based classifier — uses pre-computed topic centroid vectors (topic_centroids.js).
// Both the candidate embedding and centroids are L2-normalized, so cosine sim = dot product.
// Falls back to null if centroids aren't loaded yet.
function YTAP_CLASSIFY_VEC(vector) {
  if (typeof YTAP_TOPIC_CENTROIDS === 'undefined' || !vector) return null;
  let best = 'general', bestSim = -Infinity;
  for (const [topic, centroid] of Object.entries(YTAP_TOPIC_CENTROIDS)) {
    let sim = 0;
    for (let i = 0; i < vector.length; i++) sim += vector[i] * centroid[i];
    if (sim > bestSim) { bestSim = sim; best = topic; }
  }
  return best;
}
