/**
 * Worker entry.
 *
 * Owns everything expensive and everything stateful: transformers.js, the
 * embedder, the chunker, the index, and retrieval. It also drives the crawl
 * schedule — but it cannot do the crawling itself.
 *
 * Workers have no DOM: no `document`, no `DOMParser`, no
 * `createHTMLDocument`. Readability therefore cannot run here. Instead the
 * worker *asks* the main thread for a page and gets extracted text back, which
 * is also the faster arrangement — the browser's own HTML parser is native and
 * beats any JS parser we could bundle. See `tsconfig.worker.json`, which drops
 * the DOM lib so this constraint is enforced at compile time.
 */

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'ping') {
    ctx.postMessage({ type: 'pong', version: '0.0.0' });
  }
});

ctx.postMessage({ type: 'worker:ready' });
