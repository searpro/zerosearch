import type {
  AskParams,
  AskResult,
  BuildManifestResult,
  Citation,
  HostFetchParams,
  HostFetchResult,
  HostManifestResult,
  IndexProgress,
  InitParams,
  InitResult,
  GenerationStatus,
  RevalidateResult,
  StatsResult,
  Suggestion,
} from '../engine/protocol.js';
import { EVENT } from '../engine/protocol.js';
import { CHUNKER_VERSION, chunkPage } from '../knowledge/chunk.js';
import { HybridIndex } from '../knowledge/hybrid.js';
import { KnowledgeStore, type StoredManifestEntry, type StoredPage, buildCacheKey } from '../knowledge/store.js';
import type { Chunk, ExtractedPage } from '../knowledge/types.js';
import type { Tier } from '../types.js';
import { processAnswer, statesUnsupportedNumber } from '../chat/answer.js';
import { buildPrompt } from '../chat/prompt.js';
import { type Capabilities, probe as probeCapabilities, selectTier } from './capabilities.js';
import { Embedder, type EmbedderOptions } from './embedder.js';
import { Generator, type GeneratorOptions, modelForTier } from './generator.js';

/**
 * The indexing and retrieval engine.
 *
 * Lives in the worker but is written against injected dependencies, so its
 * behaviour — routing, just-in-time fetching, the relevance floor — can be
 * tested without a Worker, a network, or a model download.
 */

/**
 * Extraction shape version. Part of the cache key alongside the chunker and the
 * embedder, so changing what we pull out of a page invalidates what we stored.
 */
export const EXTRACTOR_VERSION = 1;

/**
 * Minimum cosine similarity for a passage to count as an answer.
 *
 * Deliberately applied to cosine rather than the fused rank score: RRF numbers
 * are only comparable within one result set, whereas cosine means the same
 * thing every time. A genuinely relevant MiniLM chunk lands around 0.4-0.7;
 * unrelated text sits near zero. Answering below this floor is how a strictly
 * grounded assistant starts inventing things.
 */
export const RELEVANCE_FLOOR = 0.28;

/**
 * Lexical score is deliberately NOT a grounding signal.
 *
 * It looks like it should be — a passage literally containing the rare terms
 * you asked about is evidence — but BM25 sums over query terms, so a longer
 * question accumulates score from several mediocre matches and any absolute
 * threshold lets junk through. Measured on the demo corpus, an absolute
 * lexical floor admitted citations at cosine 0.02.
 *
 * The same objection as for RRF applies: those numbers are not comparable
 * across queries. Cosine is, so cosine is what gates. Lexical retrieval still
 * earns its place in *ranking* through fusion, which is rank-based and immune
 * to this.
 */

export interface EngineDeps {
  fetchPage(params: HostFetchParams): Promise<HostFetchResult>;
  manifest(): Promise<HostManifestResult>;
  notify(type: string, payload: unknown): void;
  loadEmbedder?(options: EmbedderOptions): Promise<Embedder>;
  loadGenerator?(options: GeneratorOptions): Promise<Generator>;
  isGeneratorCached?(modelId: string): Promise<boolean>;
  openStore?(cacheKey: string): Promise<KnowledgeStore>;
  probe?(): Promise<Capabilities>;
}

export class Engine {
  #params: InitParams;
  #deps: EngineDeps;
  #embedder: Embedder;
  #store: KnowledgeStore;
  #tier: Tier;
  #tierReason: string;
  #tierCapped: boolean;

  /** Chunk-level index: finds passages. */
  #chunks = new Map<string, Chunk>();
  #chunkIndex: HybridIndex;
  /** Page-level index over the sitemap: decides what is worth fetching at all. */
  #manifest = new Map<string, StoredManifestEntry>();
  #routeIndex: HybridIndex;
  #pages = new Map<string, StoredPage>();

  #currentPageIndexed = false;
  #generator: Generator | null = null;

  private constructor(
    params: InitParams,
    deps: EngineDeps,
    embedder: Embedder,
    store: KnowledgeStore,
    tier: { tier: Tier; reason: string; capped: boolean },
  ) {
    this.#params = params;
    this.#deps = deps;
    this.#embedder = embedder;
    this.#store = store;
    this.#tier = tier.tier;
    this.#tierReason = tier.reason;
    this.#tierCapped = tier.capped;
    this.#chunkIndex = new HybridIndex(embedder.dim);
    this.#routeIndex = new HybridIndex(embedder.dim);
  }

  static async init(params: InitParams, deps: EngineDeps): Promise<{ engine: Engine; result: InitResult }> {
    const capabilities = await (deps.probe ?? probeCapabilities)();
    const tier = selectTier(capabilities, params.maxTier);

    // The embedder must load before the store opens: its id is part of the
    // cache key, and opening under the wrong key would keep incomparable vectors.
    const loadEmbedder = deps.loadEmbedder ?? ((options) => Embedder.load(options));
    const embedder = await loadEmbedder({
      modelBaseUrl: params.modelBaseUrl,
      // Embedding is cheap either way, and staying on WASM at the retrieval
      // tier avoids pulling the larger WebGPU runtime for no benefit.
      device: tier.tier === 'retrieval' ? 'wasm' : 'auto',
      onProgress: (progress) => deps.notify(EVENT.modelProgress, progress),
    });

    const cacheKey = buildCacheKey({
      origin: params.origin,
      embedderId: embedder.id,
      chunkerVersion: CHUNKER_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      siteVersion: params.siteVersion,
    });

    const openStore = deps.openStore ?? ((key: string) => KnowledgeStore.open(key));
    const store = await openStore(cacheKey);

    const engine = new Engine(params, deps, embedder, store, tier);
    await engine.#hydrate();

    return {
      engine,
      result: {
        tier: tier.tier,
        tierReason: tier.reason,
        tierCapped: tier.capped,
        embedderId: embedder.id,
        fromCache: engine.#chunks.size > 0,
        wasReset: store.wasReset,
        pages: engine.#pages.size,
        chunks: engine.#chunks.size,
        manifestSize: engine.#manifest.size,
      },
    };
  }

  /** Rebuild the in-memory indexes from whatever survived in IndexedDB. */
  async #hydrate(): Promise<void> {
    const [pages, chunks, vectors, manifest] = await Promise.all([
      this.#store.getAllPages(),
      this.#store.getAllChunks(),
      this.#store.getAllVectors(),
      this.#store.getManifest(),
    ]);

    for (const page of pages) this.#pages.set(page.url, page);

    for (const chunk of chunks) {
      const vector = vectors.get(chunk.id);
      // A chunk with no vector cannot be retrieved densely; skipping keeps the
      // two indexes consistent rather than half-populated.
      if (!vector || vector.length !== this.#embedder.dim) continue;
      this.#chunks.set(chunk.id, chunk);
      this.#chunkIndex.add(chunk.id, chunk.text, vector);
    }

    for (const entry of manifest) {
      this.#manifest.set(entry.url, entry);
      if (entry.vector && entry.vector.length === this.#embedder.dim) {
        this.#routeIndex.add(entry.url, routeText(entry), entry.vector);
      }
    }

    this.#currentPageIndexed = this.#pages.has(this.#params.currentUrl);
  }

  /**
   * Reuse a recent manifest if there is one, otherwise build it.
   *
   * The stored manifest is shared across tabs and navigations, so a visitor
   * clicking through a site pays for the sitemap once rather than on every page
   * view. `maxAgeMs` is a backstop; per-page freshness is handled by
   * `revalidate`, which is far cheaper.
   */
  async ensureManifest({ maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}): Promise<BuildManifestResult> {
    const meta = await this.#store.getMeta();
    const fresh = meta.manifestBuiltAt !== null && Date.now() - meta.manifestBuiltAt < maxAgeMs;

    if (fresh) {
      const stored = await this.#store.getManifest();
      if (stored.length > 0) {
        // Another tab may have built this after we hydrated, so take it now.
        this.#loadManifest(stored);
        return { entries: stored.length, source: 'cache' };
      }
    }
    return await this.buildManifest();
  }

  /**
   * Fetch the sitemap and embed every URL's slug and path.
   *
   * No page is fetched here. Hundreds of short strings embed in seconds, and
   * the result is enough to decide which pages a question is about — which is
   * the whole premise of crawling lazily.
   */
  async buildManifest(): Promise<BuildManifestResult> {
    const { entries, source } = await this.#deps.manifest();
    this.#deps.notify(EVENT.indexStart, { source, urls: entries.length });

    const texts = entries.map((entry) => routeText(entry));
    const vectors = await this.#embedder.embed(texts, { batchSize: 32 });

    const stored: StoredManifestEntry[] = entries.map((entry, i) => ({ ...entry, vector: vectors[i]! }));

    this.#loadManifest(stored);
    await this.#store.putManifest(stored);
    await this.#store.setMeta({ manifestBuiltAt: Date.now() });

    this.#progress({ done: entries.length, total: entries.length, phase: 'manifest' });
    return { entries: entries.length, source };
  }

  /**
   * Answer a question.
   *
   * Retrieval runs against whatever is already indexed; when that does not
   * clear the relevance floor, the routing index decides which unfetched pages
   * are worth pulling in, and retrieval runs again. Fetching is capped so one
   * question cannot turn into a crawl of the whole site.
   */
  async ask({ query, currentUrl, maxFetch = 3, requestId }: AskParams): Promise<AskResult> {
    const started = Date.now();
    const fetched: string[] = [];

    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return {
        grounded: false,
        citations: [],
        suggestions: [],
        fetched,
        tookMs: 0,
        answer: null,
        sources: [],
        cited: [],
      };
    }

    const queryVector = await this.#embedder.embedOne(trimmed);

    // The page the visitor is looking at is nearly always worth having. This is
    // not a routing guess, so it deliberately does not spend the routing budget
    // — otherwise the current page eats a third of it on every cold question.
    if (!this.#currentPageIndexed && currentUrl) {
      this.#currentPageIndexed = true;
      if (await this.#indexPage(currentUrl)) fetched.push(currentUrl);
    }

    let matches = this.#chunkIndex.search(queryVector, trimmed, { limit: 6 });

    if (!matches.some(isGrounded)) {
      const candidates = this.#routeIndex
        .search(queryVector, trimmed, { limit: maxFetch * 3 })
        .map((match) => match.id)
        .filter((url) => !this.#pages.has(url));

      let spent = 0;
      for (const url of candidates) {
        if (spent >= maxFetch) break;
        if (!(await this.#indexPage(url))) continue;
        spent += 1;
        fetched.push(url);

        // Re-check after every page rather than after the batch. Before a page
        // has been fetched, routing has only its URL slug to go on — so the
        // right page is often not the first guess, and stopping at the first
        // miss loses answers that are two places further down. Checking each
        // time also means a lucky first guess returns immediately.
        matches = this.#chunkIndex.search(queryVector, trimmed, { limit: 6 });
        if (matches.some(isGrounded)) break;
      }
    }

    // Filter per passage, not per query. Once one passage qualifies it would be
    // easy to return the whole result set, but then a citation scoring 0.09 is
    // shown next to one scoring 0.64 as though both supported the answer.
    const citations: Citation[] = [];
    for (const match of matches) {
      if (!isGrounded(match)) continue;
      const chunk = this.#chunks.get(match.id);
      if (!chunk) continue;
      const page = this.#pages.get(chunk.url);
      citations.push({
        chunkId: chunk.id,
        url: chunk.url,
        title: page?.title ?? chunk.headingPath[0] ?? chunk.url,
        headingPath: chunk.headingPath,
        body: chunk.body,
        score: match.score,
        dense: match.dense,
      });
    }

    const written = await this.#write(trimmed, citations, requestId);

    return {
      grounded: citations.length > 0,
      citations,
      // With nothing above the floor we offer pages rather than the least-bad
      // passage. A confident wrong citation is worse than saying we did not find it.
      suggestions: citations.length > 0 ? [] : this.#suggest(queryVector, trimmed),
      fetched,
      tookMs: Date.now() - started,
      ...written,
    };
  }

  /**
   * Re-check indexed pages against the server and re-index what changed.
   *
   * Cheap because lazy crawling means only a handful of pages are ever indexed,
   * and because a conditional GET answers 304 for everything untouched.
   */
  async revalidate(): Promise<RevalidateResult> {
    const pages = [...this.#pages.values()];
    let changed = 0;
    let removed = 0;

    for (const page of pages) {
      const result = await this.#deps.fetchPage({
        url: page.url,
        etag: page.etag,
        lastModified: page.lastModified,
      });

      if (result.kind === 'not-modified' || result.kind === 'skip') continue;

      if (result.kind === 'gone') {
        await this.#dropPage(page.url);
        removed += 1;
        continue;
      }

      // The hash is the real check: a server can return 200 with identical
      // content, and re-embedding an unchanged page is pure waste.
      if (result.page.hash === page.hash) continue;

      await this.#storePage(result.page);
      changed += 1;
    }

    await this.#store.setMeta({ revalidatedAt: Date.now() });
    return { checked: pages.length, changed, removed };
  }

  /**
   * Load the generative model.
   *
   * Separate from `init` on purpose: this is a ~300MB download, and the
   * visitor decides whether to spend it. Idempotent — a second call returns
   * the already-loaded model.
   */
  async enableGeneration(): Promise<GenerationStatus> {
    const model = modelForTier(this.#tier);
    if (!model) return await this.generationStatus();
    if (this.#generator) return await this.generationStatus();

    const load = this.#deps.loadGenerator ?? ((options: GeneratorOptions) => Generator.load(options));
    this.#generator = await load({
      model,
      modelBaseUrl: this.#params.modelBaseUrl,
      libraryUrl: this.#params.libraryUrl,
      onProgress: (progress) => this.#deps.notify(EVENT.modelProgress, progress),
    });

    return await this.generationStatus();
  }

  async generationStatus(): Promise<GenerationStatus> {
    const model = modelForTier(this.#tier);
    if (!model) {
      return {
        available: false,
        enabled: false,
        cached: false,
        modelLabel: null,
        approxBytes: 0,
        reason: this.#tierReason,
      };
    }

    const isCached =
      this.#deps.isGeneratorCached ?? (() => Generator.isCached(model, this.#params.libraryUrl));

    return {
      available: true,
      enabled: this.#generator !== null,
      // A returning visitor already paid for the download; asking again is noise.
      cached: this.#generator !== null || (await isCached(model.id)),
      modelLabel: model.label,
      approxBytes: model.approxBytes,
      reason: this.#tierReason,
    };
  }

  stats(): StatsResult {
    return {
      pages: this.#pages.size,
      chunks: this.#chunks.size,
      manifestSize: this.#manifest.size,
      embedderId: this.#embedder.id,
      tier: this.#tier,
    };
  }

  get tierInfo(): { tier: Tier; reason: string; capped: boolean } {
    return { tier: this.#tier, reason: this.#tierReason, capped: this.#tierCapped };
  }

  /** Fetch, extract, chunk, embed and store one page. Returns false if skipped. */
  async #indexPage(url: string): Promise<boolean> {
    const existing = this.#pages.get(url);
    const result = await this.#deps.fetchPage({
      url,
      etag: existing?.etag,
      lastModified: existing?.lastModified,
    });

    if (result.kind !== 'page') return false;
    if (result.page.text.trim().length === 0) return false;

    await this.#storePage(result.page);
    this.#progress({ done: this.#pages.size, total: this.#manifest.size || this.#pages.size, url, phase: 'pages' });
    return true;
  }

  async #storePage(page: ExtractedPage): Promise<void> {
    const chunks = chunkPage(page);
    if (chunks.length === 0) return;

    const vectors = await this.#embedder.embed(chunks.map((c) => c.text));

    const stored: StoredPage = {
      url: page.url,
      title: page.title,
      description: page.description,
      category: page.category,
      hash: page.hash,
      etag: page.etag,
      lastModified: page.lastModified,
      fetchedAt: page.fetchedAt,
      chunkIds: chunks.map((c) => c.id),
    };

    await this.#store.putPage(stored, chunks, vectors);

    // Replace rather than append: re-indexing a shrunken page would otherwise
    // leave chunks that cite content no longer on it.
    this.#dropChunks(page.url);
    this.#pages.set(page.url, stored);
    chunks.forEach((chunk, i) => {
      this.#chunks.set(chunk.id, chunk);
      this.#chunkIndex.add(chunk.id, chunk.text, vectors[i]!);
    });

    await this.#improveRouting(page);
  }

  /**
   * Upgrade a manifest entry from its URL slug to the page's real title and
   * description, now that we have actually seen it. Free, and it makes routing
   * better for every later question.
   */
  async #improveRouting(page: ExtractedPage): Promise<void> {
    const entry = this.#manifest.get(page.url);
    if (!entry) return;

    const upgraded: StoredManifestEntry = { ...entry, slugTitle: page.title };
    const text = [page.title, page.description ?? '', entry.segments.join(' ')].join(' ').trim();
    upgraded.vector = await this.#embedder.embedOne(text);

    this.#manifest.set(page.url, upgraded);
    this.#routeIndex.add(page.url, text, upgraded.vector);
    await this.#store.putManifest([...this.#manifest.values()]);
  }

  /**
   * Turn retrieved passages into prose, when a model is loaded.
   *
   * Note what this cannot do: it only ever sees passages retrieval already
   * cleared, so there is no path where the model answers from its own
   * knowledge. The worst it can do is misread a passage the reader can see
   * directly underneath.
   */
  async #write(
    query: string,
    citations: Citation[],
    requestId: string | undefined,
  ): Promise<Pick<AskResult, 'answer' | 'sources' | 'cited'>> {
    const empty = { answer: null, sources: [] as Citation[], cited: [] as number[] };
    if (!this.#generator || citations.length === 0) return empty;

    const { messages, sources } = buildPrompt(query, citations);

    try {
      const raw = await this.#generator.generate(messages, {
        onToken: requestId
          ? (text) => this.#deps.notify(EVENT.token, { requestId, text })
          : undefined,
      });

      const processed = processAnswer(raw, sources.length);

      // The model refusing does not overrule retrieval. Those passages already
      // cleared the relevance floor, and small models refuse spuriously — so
      // fall back to showing the passages rather than claiming nothing was
      // found. Never the other way round: retrieval refusing is final.
      if (processed.refused) return { ...empty, sources };

      // A figure that is not in the sources was invented. Showing the passages
      // instead is strictly better than a fluent answer with a wrong number in
      // it, which is the failure a reader is least likely to catch.
      if (statesUnsupportedNumber(processed.text, sources.map((s) => s.body).join(' '))) {
        this.#deps.notify(EVENT.error, {
          scope: 'generate',
          message: 'answer stated a figure absent from its sources; showing passages instead',
        });
        return { ...empty, sources };
      }

      return { answer: processed.text, sources, cited: processed.cited };
    } catch (error) {
      // Generation is an enhancement over the passages, never a prerequisite.
      this.#deps.notify(EVENT.error, {
        scope: 'generate',
        message: error instanceof Error ? error.message : String(error),
      });
      return { ...empty, sources };
    }
  }

  /** Replace the routing index wholesale from a set of manifest entries. */
  #loadManifest(entries: StoredManifestEntry[]): void {
    this.#manifest.clear();
    this.#routeIndex.clear();
    for (const entry of entries) {
      this.#manifest.set(entry.url, entry);
      if (entry.vector && entry.vector.length === this.#embedder.dim) {
        this.#routeIndex.add(entry.url, routeText(entry), entry.vector);
      }
    }
  }

  #suggest(queryVector: Float32Array, query: string): Suggestion[] {
    return this.#routeIndex
      .search(queryVector, query, { limit: 3 })
      .map((match) => {
        const entry = this.#manifest.get(match.id);
        return { url: match.id, title: entry?.slugTitle ?? match.id };
      });
  }

  async #dropPage(url: string): Promise<void> {
    await this.#store.deletePage(url);
    this.#dropChunks(url);
    this.#pages.delete(url);
  }

  #dropChunks(url: string): void {
    this.#chunkIndex.removeByPrefix(`${url}#`);
    for (const id of [...this.#chunks.keys()]) {
      if (id.startsWith(`${url}#`)) this.#chunks.delete(id);
    }
  }

  #progress(progress: IndexProgress): void {
    this.#deps.notify(EVENT.indexProgress, progress);
  }
}

/**
 * Whether one passage is strong enough to cite.
 *
 * Either retriever can carry it. Dense similarity catches paraphrase, which is
 * most questions; lexical score catches exact identifiers, which is what small
 * embedding models are worst at and what people type most literally.
 */
function isGrounded(match: { dense: number }): boolean {
  return match.dense >= RELEVANCE_FLOOR;
}

/** What the routing index searches over before a page has ever been fetched. */
function routeText(entry: StoredManifestEntry | { slugTitle: string; segments: string[] }): string {
  return [entry.slugTitle, ...entry.segments].join(' ').trim();
}
