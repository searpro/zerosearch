import type { Tier } from '../types.js';
import type { ExtractedPage, ManifestEntry } from '../knowledge/types.js';

/**
 * The contract across the worker boundary.
 *
 * It runs both ways. The main thread drives indexing and asking; the worker
 * calls back for anything needing a DOM — fetching pages, extracting them, and
 * parsing sitemap XML — because it has none of its own.
 */

/** Called on the worker, by the main thread. */
export const WORKER = {
  init: 'worker:init',
  ensureManifest: 'worker:ensureManifest',
  ask: 'worker:ask',
  revalidate: 'worker:revalidate',
  stats: 'worker:stats',
} as const;

/** Called on the main thread, by the worker. */
export const HOST = {
  fetchPage: 'host:fetchPage',
  manifest: 'host:manifest',
} as const;

/** Fire-and-forget notifications from the worker. */
export const EVENT = {
  modelProgress: 'evt:modelProgress',
  indexStart: 'evt:indexStart',
  indexProgress: 'evt:indexProgress',
  indexDone: 'evt:indexDone',
  error: 'evt:error',
} as const;

export interface InitParams {
  origin: string;
  currentUrl: string;
  sitemapUrl: string;
  maxTier: Tier;
  modelBaseUrl: string | null;
  maxPages: number;
  siteVersion: string | null;
}

export interface InitResult {
  tier: Tier;
  tierReason: string;
  tierCapped: boolean;
  embedderId: string;
  /** True when usable knowledge was already in IndexedDB. */
  fromCache: boolean;
  /** True when a cache-key change forced a wipe. */
  wasReset: boolean;
  pages: number;
  chunks: number;
  manifestSize: number;
}

export interface BuildManifestResult {
  entries: number;
  /**
   * `cache` means a manifest built earlier (possibly by another tab) was still
   * fresh and was reused rather than refetched.
   */
  source: 'sitemap' | 'current-page' | 'cache';
}

export interface AskParams {
  query: string;
  currentUrl: string;
  /** Cap on pages fetched just-in-time to answer this one question. */
  maxFetch?: number;
}

export interface Citation {
  chunkId: string;
  url: string;
  title: string;
  headingPath: string[];
  body: string;
  score: number;
  /** Cosine similarity — the interpretable number the relevance floor uses. */
  dense: number;
}

export interface Suggestion {
  url: string;
  title: string;
}

export interface AskResult {
  /** False when nothing cleared the relevance floor. */
  grounded: boolean;
  citations: Citation[];
  /** Offered instead of an answer when `grounded` is false. */
  suggestions: Suggestion[];
  /** URLs fetched just-in-time while answering. */
  fetched: string[];
  tookMs: number;
}

export interface RevalidateResult {
  checked: number;
  changed: number;
  removed: number;
}

export interface StatsResult {
  pages: number;
  chunks: number;
  manifestSize: number;
  embedderId: string;
  tier: Tier;
}

export interface HostFetchParams {
  url: string;
  etag?: string | null;
  lastModified?: string | null;
}

export type HostFetchResult =
  | { kind: 'page'; page: ExtractedPage }
  | { kind: 'not-modified'; etag: string | null; lastModified: string | null }
  | { kind: 'gone' }
  | { kind: 'skip'; reason: string };

export interface HostManifestResult {
  entries: ManifestEntry[];
  source: 'sitemap' | 'current-page';
}

export interface IndexProgress {
  done: number;
  total: number;
  url?: string;
  phase: 'manifest' | 'pages';
}
