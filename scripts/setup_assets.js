// Copies transformers.js static assets from node_modules into the extension root.
// Run once after `npm install`: node scripts/setup_assets.js

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'node_modules', '@xenova', 'transformers', 'dist');
const DEST = path.join(__dirname, '..');

const FILES = [
  'transformers.min.js',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd.wasm',
  'ort-wasm-threaded.wasm',
  'ort-wasm.wasm',
];

let ok = 0;
for (const file of FILES) {
  const src = path.join(SRC, file);
  const dest = path.join(DEST, file);
  if (!fs.existsSync(src)) {
    console.error(`MISSING: ${src} — run npm install first`);
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  const kb = Math.round(fs.statSync(dest).size / 1024);
  console.log(`copied ${file} (${kb} KB)`);
  ok++;
}
console.log(`\n${ok}/${FILES.length} files copied to extension root.`);
console.log('Commit these files to the repo — they are static distribution artifacts.');
