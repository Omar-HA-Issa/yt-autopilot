// Downloads Xenova/all-MiniLM-L6-v2 (quantized) from HuggingFace into models/.
// Run once: node scripts/download_model.js
// Files are committed to the repo — end users get them with the extension.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const DEST_DIR = path.join(__dirname, '..', 'models', MODEL_ID);

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
];

// Follows redirects before opening the file, so no partial writes on 3xx responses.
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      const kb = Math.round(fs.statSync(destPath).size / 1024);
      console.log(`  skip  ${path.relative(path.join(__dirname, '..'), destPath)} (${kb} KB)`);
      return resolve();
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    function fetch(u, redirects) {
      if (redirects > 10) return reject(new Error('too many redirects'));
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // drain so socket is freed
          const location = res.headers.location;
          const resolved = location.startsWith('http') ? location : new URL(location, u).href;
          return fetch(resolved, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        // Only create the file once we have a 200
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            const kb = Math.round(fs.statSync(destPath).size / 1024);
            console.log(`  saved ${path.relative(path.join(__dirname, '..'), destPath)} (${kb} KB)`);
            resolve();
          });
        });
        file.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      }).on('error', reject);
    }

    fetch(url, 0);
  });
}

async function main() {
  console.log(`Downloading ${MODEL_ID} → models/${MODEL_ID}/\n`);
  for (const file of FILES) {
    await download(`${BASE_URL}/${file}`, path.join(DEST_DIR, file));
  }
  console.log('\nDone. Commit the models/ directory to the repo.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
