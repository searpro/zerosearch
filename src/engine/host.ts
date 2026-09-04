import { extractFromHtml } from '../dom/extract.js';
import { PoliteFetcher, SkippedError } from '../dom/fetcher.js';
import { whenIdle } from '../dom/idle.js';
import { parseSitemap } from '../dom/manifest.js';
import { describeUrl } from '../dom/manifest.js';
import { parseRobots } from '../knowledge/robots.js';
import type { ManifestEntry } from '../knowledge/types.js';
import { HOST, type HostFetchParams, type HostFetchResult, type HostManifestResult } from './protocol.js';
import type { RpcPeer } from './rpc.js';

/**
 * The main thread's half of the crawl.
 *
 * The worker decides *what* to fetch and *when*; this decides whether it is
 * permitted and turns HTML into text. The split exists because a worker has no
 * DOM, and it turns out to be the better arrangement anyway — the browser's own
 * parser is native and beats anything we could bundle.
 */

export interface HostOptions {
  origin: string;
  sitemapUrl: string;
  maxPages: number;
  currentUrl: string;
  fetcher?: PoliteFetcher;
}

/** Nested sitemap indexes are followed, but not indefinitely. */
const MAX_SITEMAP_DEPTH = 3;

export class Host {
  #options: HostOptions;
  #fetcher: PoliteFetcher;
  #robotsLoaded = false;

  constructor(options: HostOptions) {
    this.#options = options;
    this.#fetcher = options.fetcher ?? new PoliteFetcher({ origin: options.origin });
  }

  /** Wire this host up to answer the worker's callbacks. */
  register(peer: RpcPeer): void {
    peer.handle<HostFetchParams, HostFetchResult>(HOST.fetchPage, (params) => this.fetchPage(params));
    peer.handle<void, HostManifestResult>(HOST.manifest, () => this.manifest());
  }

  async fetchPage({ url, etag, lastModified, priority }: HostFetchParams): Promise<HostFetchResult> {
    await this.#ensureRobots();

    // Reading ahead waits for the browser to have nothing better to do. The
    // visitor came for the host page; a background crawl that costs them
    // dropped frames has taken more than it gives. `whenIdle` has a timeout, so
    // a permanently busy page still makes progress, just slowly.
    if (priority === 'background') await whenIdle(2000);

    try {
      const response = await this.#fetcher.fetchPage(url, { etag, lastModified });

      if (response.notModified) {
        return { kind: 'not-modified', etag: response.etag, lastModified: response.lastModified };
      }
      if (response.html === null) {
        // A 404 or 500. The page is simply not available to index.
        return { kind: 'gone' };
      }

      return {
        kind: 'page',
        page: extractFromHtml(response.html, url, {
          etag: response.etag,
          lastModified: response.lastModified,
        }),
      };
    } catch (error) {
      if (error instanceof SkippedError) return { kind: 'skip', reason: error.reason };
      return { kind: 'skip', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Build the routing manifest: every URL the site publishes, with a readable
   * title guessed from its slug. No page is fetched — this is cheap enough to
   * do for hundreds of URLs, and it is what makes just-in-time crawling
   * possible at all.
   */
  async manifest(): Promise<HostManifestResult> {
    await this.#ensureRobots();

    const seen = new Set<string>();
    const entries: ManifestEntry[] = [];
    const queue: { url: string; depth: number }[] = [{ url: this.#options.sitemapUrl, depth: 0 }];
    const visitedSitemaps = new Set<string>();

    while (queue.length > 0 && entries.length < this.#options.maxPages) {
      const next = queue.shift()!;
      if (next.depth > MAX_SITEMAP_DEPTH || visitedSitemaps.has(next.url)) continue;
      visitedSitemaps.add(next.url);

      const xml = await this.#fetcher.fetchText(next.url);
      if (!xml) continue;

      let parsed;
      try {
        parsed = parseSitemap(xml, next.url);
      } catch {
        // A malformed sitemap is not fatal; we fall back to the current page.
        continue;
      }

      for (const nested of parsed.sitemaps) {
        queue.push({ url: nested, depth: next.depth + 1 });
      }

      for (const entry of parsed.urls) {
        if (entries.length >= this.#options.maxPages) break;
        if (seen.has(entry.url)) continue;
        // robots and same-origin are enforced here rather than at fetch time,
        // so disallowed pages never even enter the routing manifest.
        if (!this.#fetcher.allows(entry.url)) continue;
        seen.add(entry.url);
        entries.push(entry);
      }
    }

    if (entries.length > 0) return { entries, source: 'sitemap' };

    // No sitemap, or nothing usable in it. The current page alone is a poor
    // index but it is honest, and better than refusing to work at all.
    const current = this.#options.currentUrl;
    return {
      entries: [{ url: current, ...describeUrl(current), lastmod: null, priority: null }],
      source: 'current-page',
    };
  }

  async #ensureRobots(): Promise<void> {
    if (this.#robotsLoaded) return;
    this.#robotsLoaded = true;

    const text = await this.#fetcher.fetchText(new URL('/robots.txt', this.#options.origin).href);
    this.#fetcher.setRobots(text ? parseRobots(text) : null);
  }
}
