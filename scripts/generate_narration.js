// Batch-generates MP3s for all narration lines under audio/.
// Usage: ELEVENLABS_API_KEY=xxx ELEVENLABS_VOICE_ID=xxx node scripts/generate_narration.js
//
// Reads every .txt file in audio/**/, calls ElevenLabs TTS, saves .mp3 alongside it.
// Already-generated .mp3 files are skipped so reruns are safe.

const fs = require('fs');
const path = require('path');
const https = require('https');

const API_KEY  = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

if (!API_KEY || !VOICE_ID) {
  console.error('Missing env vars. Run as:');
  console.error('  ELEVENLABS_API_KEY=xxx ELEVENLABS_VOICE_ID=xxx node scripts/generate_narration.js');
  process.exit(1);
}

const VOICE_SETTINGS = {
  stability:         0.35,
  similarity_boost:  0.80,
  style:             0.35,
  use_speaker_boost: true,
  speed:             0.9, // eleven_multilingual_v2 default is 1.0 (range 0.7-1.2); slowed down, was reading too fast
};

function collectTxtFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectTxtFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.txt')) results.push(full);
  }
  return results.sort();
}

function generateMp3(text, outputPath) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: VOICE_SETTINGS,
    });

    const options = {
      hostname: 'api.elevenlabs.io',
      path:     `/v1/text-to-speech/${VOICE_ID}`,
      method:   'POST',
      headers: {
        'xi-api-key':    API_KEY,
        'Content-Type':  'application/json',
        'Accept':        'audio/mpeg',
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', d => err += d);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${err}`)));
        return;
      }
      const out = fs.createWriteStream(outputPath);
      res.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const audioDir = path.join(__dirname, '..', 'audio');
  const txtFiles = collectTxtFiles(audioDir);

  console.log(`Found ${txtFiles.length} script files.\n`);

  for (const txtPath of txtFiles) {
    const mp3Path = txtPath.replace(/\.txt$/, '.mp3');
    const label   = path.relative(audioDir, txtPath);

    if (fs.existsSync(mp3Path)) {
      console.log(`  skip  ${label} (mp3 already exists)`);
      continue;
    }

    const text = fs.readFileSync(txtPath, 'utf8').trim();
    process.stdout.write(`  gen   ${label} ... `);

    try {
      await generateMp3(text, mp3Path);
      console.log('done');
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }

    // ElevenLabs free tier rate limit: ~2 req/s to be safe
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\nAll done.');
}

main();
