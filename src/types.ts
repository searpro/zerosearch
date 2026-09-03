/** Runtime capability tiers, cheapest first. See the tier table in the plan. */
export type Tier = 'retrieval' | 'small' | 'standard';

export const TIERS: readonly Tier[] = ['retrieval', 'small', 'standard'] as const;

/** True when `a` is at most as capable as `b`. */
export function tierAtMost(a: Tier, b: Tier): boolean {
  return TIERS.indexOf(a) <= TIERS.indexOf(b);
}

/** Pick the less capable of two tiers. */
export function minTier(a: Tier, b: Tier): Tier {
  return tierAtMost(a, b) ? a : b;
}

export type Preload = 'idle' | 'open' | 'never';
export type Position = 'bottom-right' | 'bottom-left';
export type Theme = 'auto' | 'light' | 'dark';

/**
 * How eagerly to load the generative model.
 *
 * `ask` is the default because the model is a ~300MB download. Spending that
 * much of a visitor's connection without being asked is not defensible, so the
 * widget offers it and they decide once.
 */
export type Generate = 'ask' | 'auto' | 'never';

export interface WebAIConfig {
  /** Where the site's URL manifest lives. Resolved against the document base URL. */
  sitemapUrl: string;
  /**
   * Ceiling on the runtime tier. Defaults to `small` — we never push a
   * ~450MB download at a visitor unless the site explicitly opts in.
   */
  maxTier: Tier;
  /** Base URL to load model weights from. `null` uses the transformers.js default (HF CDN). */
  modelBaseUrl: string | null;
  /** Where to load the transformers.js module from. `null` uses the pinned CDN default. */
  libraryUrl: string | null;
  /** Whether written answers are offered, loaded immediately, or disabled. */
  generate: Generate;
  /** A prebuilt static index to try before crawling anything. */
  indexUrl: string | null;
  /** Cap on how many sitemap URLs enter the routing manifest. */
  maxPages: number;
  /** Hard cache-buster. Bump on deploy to discard all stored knowledge for this origin. */
  version: string | null;
  /** When to load the embedder and build the routing manifest. */
  preload: Preload;
  /** Render the built-in widget. `false` gives a headless engine. */
  widget: boolean;
  position: Position;
  theme: Theme;
  accent: string;
  /** Overrides the worker URL derived from the script tag's own src. */
  workerUrl: string | null;
  debug: boolean;
}

/** Everything the engine can report. Consumed by the widget and by `onEvent`. */
export type WebAIEventMap = {
  'ready': { tier: Tier };
  'tier': { tier: Tier; reason: string; capped: boolean };
  'index:start': { source: 'prebuilt' | 'crawl'; urls: number };
  'index:progress': { done: number; total: number; url?: string };
  'index:done': { pages: number; chunks: number; fromCache: boolean };
  'model:progress': { name: string; loaded: number; total: number };
  'generation:ready': { modelLabel: string };
  'answer:token': { requestId: string; text: string };
  'open': Record<string, never>;
  'close': Record<string, never>;
  'error': { scope: string; message: string; cause?: unknown };
};

export type WebAIEventName = keyof WebAIEventMap;

/** A single event, in the shape handed to the wildcard `onEvent` hook. */
export type WebAIEvent = {
  [K in WebAIEventName]: { type: K; payload: WebAIEventMap[K] };
}[WebAIEventName];
