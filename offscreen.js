// Offscreen document — runs the embedding model in a full window context
// (URL.createObjectURL + WASM available here, unlike service workers).
// Communicates with background.js via a named port.

import { pipeline, env } from './transformers.min.js';

env.backends.onnx.wasm.wasmPaths = new URL('./', import.meta.url).href;
env.localModelPath = new URL('models/', import.meta.url).href;
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;

let embedder = null;

async function getEmbedder() {
  if (!embedder) {
    console.log('[yt-autopilot] offscreen: loading embedding model…');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
    console.log('[yt-autopilot] offscreen: model ready');
  }
  return embedder;
}

const port = chrome.runtime.connect({ name: 'offscreen-embedder' });

port.onMessage.addListener(async (msg) => {
  if (msg.type === 'EMBED') {
    try {
      const model = await getEmbedder();
      const embeddings = [];
      for (const text of msg.texts) {
        const out = await model(text, { pooling: 'mean', normalize: true });
        embeddings.push(Array.from(out.data));
      }
      port.postMessage({ type: 'EMBED_RESULT', id: msg.id, embeddings });
    } catch (err) {
      console.error('[yt-autopilot] offscreen embed error:', err.message);
      port.postMessage({ type: 'EMBED_ERROR', id: msg.id, error: err.message });
    }
    return;
  }

  if (msg.type === 'EMBED_AND_STORE') {
    // Compute embeddings and send back to background — background handles storage.
    try {
      const model = await getEmbedder();
      const embeddings = new Map();
      for (const c of msg.candidates) {
        const out = await model(c.title, { pooling: 'mean', normalize: true });
        embeddings.set(c.videoId, Array.from(out.data));
      }
      port.postMessage({
        type: 'EMBED_AND_STORE_RESULT',
        embeddings: Object.fromEntries(embeddings),
      });
      console.log('[yt-autopilot] offscreen: embedded', embeddings.size, 'candidates');
    } catch (err) {
      console.error('[yt-autopilot] offscreen EMBED_AND_STORE error:', err.message);
    }
  }
});
