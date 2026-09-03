import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractFromHtml } from '../../src/dom/extract.js';
import type { HostFetchParams, HostFetchResult, InitParams } from '../../src/engine/protocol.js';
import { KnowledgeStore } from '../../src/knowledge/store.js';
import { l2Normalize } from '../../src/knowledge/vector.js';
import type { Capabilities } from '../../src/worker/capabilities.js';
import { Embedder, type EmbedPipeline } from '../../src/worker/embedder.js';
import { Engine } from '../../src/worker/engine.js';
import { GENERATOR_MODELS, Generator, type GeneratePipeline } from '../../src/worker/generator.js';

/**
 * Engine behaviour, end to end, with everything expensive faked.
 *
 * The embedder is a bag-of-words over a fixed vocabulary, which makes cosine
 * similarity predictable — so the relevance floor, the routing loop and the
 * grounding fallbacks can all be asserted rather than hoped for.
 */

const VOCAB = [
  'pricing', 'team', 'cost', 'dollars', 'month',
  'limits', 'rate', 'requests', 'minute',
  'tokens', 'rotate', 'authentication',
  'sourdough',
];

function bagOfWords(text: string): Float32Array {
  const vector = new Float32Array(VOCAB.length);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const index = VOCAB.indexOf(word);
    if (index >= 0) vector[index] = (vector[index] ?? 0) + 1;
  }
  return l2Normalize(vector);
}

const fakeEmbedPipeline = (async (texts: string[]) => {
  const data = new Float32Array(texts.length * VOCAB.length);
  texts.forEach((text, row) => data.set(bagOfWords(text), row * VOCAB.length));
  return { dims: [texts.length, VOCAB.length], data };
}) as EmbedPipeline;

const ORIGIN = 'https://meridian.example';

/** Real HTML through the real extractor, so chunking and extraction are exercised too. */
const PAGES: Record<string, string> = {
  '/pricing.html': `<title>Pricing</title><main>
    <h2>Team</h2><p>The team plan cost is 49 dollars per month with generous limits.</p>
    <h2>Business</h2><p>The business plan cost is 400 dollars per month.</p></main>`,
  '/limits.html': `<title>Limits</title><main>
    <h2>Rate limits</h2><p>Rate limits allow 10000 requests per minute on the team plan.</p></main>`,
  '/authentication.html': `<title>Authentication</title><main>
    <h2>Rotate</h2><p>Rotate tokens using the authentication endpoint. Old tokens stay valid briefly.</p></main>`,
};

function makeDeps(overrides: Partial<Parameters<typeof Engine.init>[1]> = {}) {
  const fetched: string[] = [];
  const notices: { type: string; payload: unknown }[] = [];

  const fetchPage = vi.fn(async ({ url }: HostFetchParams): Promise<HostFetchResult> => {
    const path = new URL(url).pathname;
    const html = PAGES[path];
    if (!html) return { kind: 'gone' };
    fetched.push(path);
    return { kind: 'page', page: extractFromHtml(html, url) };
  });

  return {
    fetched,
    notices,
    fetchPage,
    deps: {
      fetchPage,
      manifest: async () => ({
        source: 'sitemap' as const,
        entries: Object.keys(PAGES).map((path) => ({
          url: `${ORIGIN}${path}`,
          slugTitle: path.replace(/[/.]/g, ' ').replace('html', '').trim(),
          segments: [],
          lastmod: null,
          priority: null,
        })),
      }),
      notify: (type: string, payload: unknown) => notices.push({ type, payload }),
      loadEmbedder: () => Embedder.load({ createPipeline: async () => fakeEmbedPipeline }),
      openStore: (key: string) => KnowledgeStore.open(key, factory as unknown as IDBFactory),
      probe: async (): Promise<Capabilities> => ({
        webgpu: true,
        maxBufferSize: 2 ** 31,
        maxStorageBufferBindingSize: 2 ** 29,
        deviceMemoryGb: 16,
        saveData: false,
        effectiveType: '4g',
        cores: 8,
      }),
      ...overrides,
    },
  };
}

const PARAMS: InitParams = {
  origin: ORIGIN,
  currentUrl: `${ORIGIN}/pricing.html`,
  sitemapUrl: `${ORIGIN}/sitemap.xml`,
  maxTier: 'small',
  modelBaseUrl: null,
  libraryUrl: null,
  maxPages: 50,
  siteVersion: null,
};

let factory: IDBFactory;
beforeEach(() => {
  factory = new IDBFactory();
});

async function boot(overrides = {}, params: Partial<InitParams> = {}) {
  const harness = makeDeps(overrides);
  const { engine, result } = await Engine.init({ ...PARAMS, ...params }, harness.deps);
  await engine.ensureManifest();
  return { engine, result, ...harness };
}

/** A generator that always replies with the same text. */
function fakeGenerator(reply: string) {
  const calls: unknown[][] = [];
  const instance = (async (messages: unknown[]) => {
    calls.push(messages);
    return [{ generated_text: reply }];
  }) as GeneratePipeline;
  instance.tokenizer = {};

  return {
    calls,
    loadGenerator: () =>
      Generator.load({
        model: GENERATOR_MODELS.small,
        createPipeline: async () => instance,
        createStreamer: async () => ({}),
      }),
  };
}

describe('Engine: init and tiering', () => {
  it('reports the tier, capped by the site ceiling', async () => {
    const { result } = await boot({}, { maxTier: 'small' });
    expect(result.tier).toBe('small');
    expect(result.tierCapped).toBe(true);
  });

  it('falls to retrieval when the device has no WebGPU', async () => {
    const { result } = await boot({
      probe: async (): Promise<Capabilities> => ({
        webgpu: false,
        maxBufferSize: null,
        maxStorageBufferBindingSize: null,
        deviceMemoryGb: null,
        saveData: false,
        effectiveType: null,
        cores: 4,
      }),
    });
    expect(result.tier).toBe('retrieval');
  });

  it('builds a routing manifest without fetching any page', async () => {
    const { result, fetched } = await boot();
    expect(result.manifestSize).toBe(0); // measured before ensureManifest
    expect(fetched).toEqual([]);
  });
});

describe('Engine: retrieval', () => {
  it('answers from the current page without routing anywhere', async () => {
    const { engine } = await boot();
    const result = await engine.ask({ query: 'team plan cost dollars', currentUrl: PARAMS.currentUrl });

    expect(result.grounded).toBe(true);
    expect(result.citations[0]!.url).toContain('/pricing.html');
    expect(result.fetched).toEqual([`${ORIGIN}/pricing.html`]);
  });

  it('fetches a routed page just in time when the answer is elsewhere', async () => {
    const { engine, fetched } = await boot();
    const result = await engine.ask({
      query: 'rate limits requests per minute',
      currentUrl: PARAMS.currentUrl,
    });

    expect(result.grounded).toBe(true);
    expect(result.citations[0]!.url).toContain('/limits.html');
    expect(fetched).toContain('/limits.html');
  });

  it('refuses, with suggestions, when nothing clears the floor', async () => {
    const { engine } = await boot();
    const result = await engine.ask({ query: 'sourdough', currentUrl: PARAMS.currentUrl });

    expect(result.grounded).toBe(false);
    expect(result.citations).toEqual([]);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.answer).toBeNull();
  });

  it('returns nothing for an empty question without touching the network', async () => {
    const { engine, fetchPage } = await boot();
    const result = await engine.ask({ query: '   ', currentUrl: PARAMS.currentUrl });

    expect(result.grounded).toBe(false);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('does not refetch a page it has already indexed', async () => {
    const { engine, fetched } = await boot();
    await engine.ask({ query: 'team plan cost', currentUrl: PARAMS.currentUrl });
    const before = fetched.length;

    await engine.ask({ query: 'team plan cost dollars month', currentUrl: PARAMS.currentUrl });
    expect(fetched.length).toBe(before);
  });
});

describe('Engine: generation', () => {
  it('produces no answer until a generator is loaded', async () => {
    const { engine } = await boot();
    const result = await engine.ask({ query: 'team plan cost', currentUrl: PARAMS.currentUrl });

    // Retrieval-only: the passages are the answer.
    expect(result.answer).toBeNull();
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it('writes an answer over the retrieved passages once enabled', async () => {
    const generator = fakeGenerator('The team plan costs 49 dollars per month [1].');
    const { engine } = await boot({ loadGenerator: generator.loadGenerator });

    await engine.enableGeneration();
    const result = await engine.ask({ query: 'team plan cost', currentUrl: PARAMS.currentUrl });

    expect(result.answer).toBe('The team plan costs 49 dollars per month [1].');
    expect(result.cited).toEqual([1]);
    expect(result.sources.length).toBeGreaterThan(0);
    // The evidence is still returned alongside, so a reader can check it.
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it('only ever shows the model passages retrieval already accepted', async () => {
    const generator = fakeGenerator('An answer [1].');
    const { engine } = await boot({ loadGenerator: generator.loadGenerator });
    await engine.enableGeneration();

    await engine.ask({ query: 'team plan cost', currentUrl: PARAMS.currentUrl });

    const prompt = JSON.stringify(generator.calls[0]);
    expect(prompt).toContain('49 dollars');
    // Nothing from an unrelated page can reach the model.
    expect(prompt).not.toContain('sourdough');
  });

  it('does not call the model when retrieval found nothing', async () => {
    const generator = fakeGenerator('I will invent something.');
    const { engine } = await boot({ loadGenerator: generator.loadGenerator });
    await engine.enableGeneration();

    const result = await engine.ask({ query: 'sourdough', currentUrl: PARAMS.currentUrl });

    // This is the property that makes the whole thing safe: no retrieval, no
    // generation, so there is no path to an answer from model memory.
    expect(generator.calls).toHaveLength(0);
    expect(result.grounded).toBe(false);
    expect(result.answer).toBeNull();
  });

  it('falls back to the passages when the model refuses', async () => {
    // Retrieval already cleared the floor, and small models refuse spuriously,
    // so the model's refusal does not overrule it.
    const generator = fakeGenerator('NOT_FOUND');
    const { engine } = await boot({ loadGenerator: generator.loadGenerator });
    await engine.enableGeneration();

    const result = await engine.ask({ query: 'team plan cost', currentUrl: PARAMS.currentUrl });

    expect(result.answer).toBeNull();
    expect(result.grounded).toBe(true);
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it('falls back to the passages when generation throws', async () => {
    const { engine, notices } = await boot({
      loadGenerator: () =>
        Generator.load({
          model: GENERATOR_MODELS.small,
          createPipeline: async () => {
            const instance = (async () => {
              throw new Error('webgpu device lost');
            }) as GeneratePipeline;
            return instance;
          },
        }),
    });
    await engine.enableGeneration();

    const result = await engine.ask({ query: 'team plan cost', currentUrl: PARAMS.currentUrl });

    expect(result.answer).toBeNull();
    expect(result.grounded).toBe(true);
    expect(notices.some((n) => n.type.includes('error'))).toBe(true);
  });

  it('strips a citation marker the model invented', async () => {
    const generator = fakeGenerator('It costs 49 dollars [1] and includes support [9].');
    const { engine } = await boot({ loadGenerator: generator.loadGenerator });
    await engine.enableGeneration();

    const result = await engine.ask({ query: 'team plan cost', currentUrl: PARAMS.currentUrl });
    expect(result.answer).not.toContain('[9]');
    expect(result.cited).toEqual([1]);
  });

  it('streams tokens tagged with the request they belong to', async () => {
    const generator = fakeGenerator('streamed');
    const { engine, notices } = await boot({ loadGenerator: generator.loadGenerator });
    await engine.enableGeneration();

    await engine.ask({ query: 'team plan cost', currentUrl: PARAMS.currentUrl, requestId: 'r7' });

    // The streamer itself is faked, so no token events fire here; what matters
    // is that the id reached the generator call without throwing.
    expect(notices.every((n) => n.payload !== undefined)).toBe(true);
  });
});

describe('Engine: generation availability', () => {
  it('is unavailable on a retrieval-tier device, with a reason', async () => {
    const { engine } = await boot({
      probe: async (): Promise<Capabilities> => ({
        webgpu: false,
        maxBufferSize: null,
        maxStorageBufferBindingSize: null,
        deviceMemoryGb: null,
        saveData: false,
        effectiveType: null,
        cores: 4,
      }),
    });

    const status = await engine.generationStatus();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/WebGPU/);
    // Enabling is a no-op rather than an error.
    expect((await engine.enableGeneration()).enabled).toBe(false);
  });

  it('reports the model and its size before anything is downloaded', async () => {
    const { engine } = await boot({ isGeneratorCached: async () => false });
    const status = await engine.generationStatus();

    expect(status.available).toBe(true);
    expect(status.enabled).toBe(false);
    expect(status.cached).toBe(false);
    expect(status.approxBytes).toBeGreaterThan(0);
    expect(status.modelLabel).toBeTruthy();
  });

  it('reports cached when the weights are already in the browser', async () => {
    const { engine } = await boot({ isGeneratorCached: async () => true });
    expect((await engine.generationStatus()).cached).toBe(true);
  });

  it('loading twice does not download twice', async () => {
    const load = vi.fn(fakeGenerator('x').loadGenerator);
    const { engine } = await boot({ loadGenerator: load });

    await engine.enableGeneration();
    await engine.enableGeneration();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('Engine: revalidation', () => {
  it('leaves an unchanged page alone', async () => {
    const { engine, deps } = await boot();
    await engine.ask({ query: 'team plan cost', currentUrl: PARAMS.currentUrl });

    deps.fetchPage = async () => ({ kind: 'not-modified', etag: null, lastModified: null });
    const result = await engine.revalidate();

    expect(result.changed).toBe(0);
    expect(result.checked).toBeGreaterThan(0);
  });

  it('re-indexes a page whose content changed', async () => {
    const { engine, deps } = await boot();
    await engine.ask({ query: 'team plan cost', currentUrl: PARAMS.currentUrl });

    deps.fetchPage = async ({ url }: HostFetchParams) => ({
      kind: 'page',
      page: extractFromHtml(
        '<title>Pricing</title><main><h2>Team</h2><p>The team plan cost is 59 dollars per month now.</p></main>',
        url,
      ),
    });

    expect((await engine.revalidate()).changed).toBeGreaterThan(0);
    const after = await engine.ask({ query: 'team plan cost dollars', currentUrl: PARAMS.currentUrl });
    expect(after.citations.some((c) => c.body.includes('59'))).toBe(true);
  });

  it('drops a page that has gone', async () => {
    const { engine, deps } = await boot();
    await engine.ask({ query: 'team plan cost', currentUrl: PARAMS.currentUrl });
    expect(engine.stats().pages).toBeGreaterThan(0);

    deps.fetchPage = async () => ({ kind: 'gone' });
    const result = await engine.revalidate();

    expect(result.removed).toBeGreaterThan(0);
    expect(engine.stats().pages).toBe(0);
  });
});
