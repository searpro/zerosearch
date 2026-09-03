import { type Robots, isAllowed } from '../knowledge/robots.js';
import { whenIdle } from './idle.js';

/**
 * The crawler's network layer.
 *
 * Three constraints shape it, and all three are non-negotiable:
 *
 *  - **Privacy.** Requests go out with `credentials: 'omit'`. A logged-in
 *    visitor's personalised pages must never reach the index, which is
 *    persisted to IndexedDB and shown to whoever uses the browser next.
 *  - **Politeness.** Every visitor with a cold cache is a crawler hitting the
 *    origin. Concurrency is capped, requests are spaced, and each one waits for
 *    an idle moment first, so the host page and its server both stay responsive.
 *  - **Containment.** Same-origin only, HTML only, and a hard byte ceiling, so
 *    a single pathological URL cannot exhaust memory.
 */

export interface FetchedPage {
  url: string;
  status: number;
  /** Null when the server answered 304, or the response was not usable HTML. */
  html: string | null;
  notModified: boolean;
  etag: string | null;
  lastModified: string | null;
}

export interface FetcherOptions {
  origin: string;
  /** Parallel requests. Two is polite and still keeps the queue moving. */
  concurrency?: number;
  /** Minimum gap between the start of one request and the next. */
  delayMs?: number;
  /** Hard ceiling on a single response body. */
  maxBytes?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class SkippedError extends Error {
  override readonly name = 'SkippedError';
  readonly reason: 'cross-origin' | 'robots' | 'not-html' | 'too-large';
  constructor(reason: SkippedError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

export class PoliteFetcher {
  readonly origin: string;
  #concurrency: number;
  #delayMs: number;
  #maxBytes: number;
  #timeoutMs: number;
  #fetch: typeof fetch;

  #robots: Robots | null = null;
  #active = 0;
  #queue: (() => void)[] = [];
  #lastStart = 0;

  constructor(options: FetcherOptions) {
    this.origin = options.origin;
    this.#concurrency = Math.max(1, options.concurrency ?? 2);
    this.#delayMs = Math.max(0, options.delayMs ?? 150);
    this.#maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.#timeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  setRobots(robots: Robots | null): void {
    this.#robots = robots;
  }

  /** True when this URL is one we are permitted to fetch at all. */
  allows(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.origin !== this.origin) return false;
    if (this.#robots && !isAllowed(this.#robots, parsed.pathname + parsed.search)) return false;
    return true;
  }

  /**
   * Fetch a page for indexing. Pass the stored validators to get a cheap 304
   * when nothing changed — that is what makes content-hash revalidation
   * affordable on every boot.
   */
  async fetchPage(
    url: string,
    { etag, lastModified, signal }: { etag?: string | null; lastModified?: string | null; signal?: AbortSignal } = {},
  ): Promise<FetchedPage> {
    if (!this.allows(url)) {
      const reason = new URL(url, this.origin).origin !== this.origin ? 'cross-origin' : 'robots';
      throw new SkippedError(reason, `refusing to fetch ${url} (${reason})`);
    }

    const headers: Record<string, string> = { Accept: 'text/html,application/xhtml+xml' };
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;

    const response = await this.#request(url, headers, signal);

    const responseEtag = response.headers.get('etag');
    const responseLastModified = response.headers.get('last-modified');

    if (response.status === 304) {
      return {
        url,
        status: 304,
        html: null,
        notModified: true,
        etag: responseEtag ?? etag ?? null,
        lastModified: responseLastModified ?? lastModified ?? null,
      };
    }

    if (!response.ok) {
      return { url, status: response.status, html: null, notModified: false, etag: null, lastModified: null };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
      throw new SkippedError('not-html', `${url} is ${contentType}, not HTML`);
    }

    return {
      url,
      status: response.status,
      html: await this.#readCapped(response, url),
      notModified: false,
      etag: responseEtag,
      lastModified: responseLastModified,
    };
  }

  /** Plain text fetch for robots.txt and sitemaps. Returns null on any failure. */
  async fetchText(url: string, { signal }: { signal?: AbortSignal } = {}): Promise<string | null> {
    try {
      const response = await this.#request(url, { Accept: 'text/plain,application/xml,text/xml,*/*' }, signal);
      if (!response.ok) return null;
      return await this.#readCapped(response, url);
    } catch {
      // A missing robots.txt or sitemap is normal and must not be fatal.
      return null;
    }
  }

  async #request(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    const release = await this.#acquire();
    try {
      // Never compete with whatever the visitor is actually doing.
      await whenIdle();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        return await this.#fetch(url, {
          headers,
          signal: controller.signal,
          // The anonymous view of the page. Anything else risks indexing one
          // user's private content and serving it to the next.
          credentials: 'omit',
          redirect: 'follow',
          mode: 'same-origin',
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    } finally {
      release();
    }
  }

  /** Read the body but stop at the ceiling rather than buffering whatever arrives. */
  async #readCapped(response: Response, url: string): Promise<string> {
    const declared = Number(response.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > this.#maxBytes) {
      throw new SkippedError('too-large', `${url} declares ${declared} bytes`);
    }

    if (!response.body) return await response.text();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let total = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.#maxBytes) {
          throw new SkippedError('too-large', `${url} exceeded ${this.#maxBytes} bytes`);
        }
        parts.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      // Releasing lets the connection be reused, and cancels on the throw path.
      reader.releaseLock();
    }

    parts.push(decoder.decode());
    return parts.join('');
  }

  /** Concurrency cap plus a minimum spacing between request starts. */
  async #acquire(): Promise<() => void> {
    if (this.#active >= this.#concurrency) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#active += 1;

    const wait = this.#lastStart + this.#delayMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.#lastStart = Date.now();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#queue.shift()?.();
    };
  }
}
