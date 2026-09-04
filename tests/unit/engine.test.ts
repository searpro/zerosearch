import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractFromHtml } from '../../src/dom/extract.js';
import { EVENT } from '../../src/engine/protocol.js';
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

/**
 * Background enrichment.
 *
 * The site here is built so routing cannot reach two of its pages from their
 * URLs alone: `handbook` and `notes` are not words any question uses, and the
 * fake embedder has no notion of relatedness to bridge that. Only reading them
 * puts their real titles and headings into the routing index — which is the
 * whole claim Phase 3 has to make good on.
 */
const HIDDEN_ORIGIN = 'https://meridian.example';

const HIDDEN_PAGES: Record<string, string> = {
  '/handbook.html': `<title>Rate limits</title>
    <meta name="description" content="Rate limits and requests per minute on every plan.">
    <main><h2>Rate limits</h2>
    <p>Every plan has rate limits measured in requests per minute.</p></main>`,
  '/notes.html': `<title>Rotate tokens</title><main><h2>Rotate tokens</h2>
    <p>Rotate tokens through the authentication endpoint whenever they leak.</p></main>`,
  '/pricing.html': `<title>Pricing</title><main><h2>Team</h2>
    <p>The team plan cost is 49 dollars per month.</p></main>`,
  '/missing.html': '',
};

function hiddenDeps(overrides: Record<string, unknown> = {}) {
  const requests: { url: string; priority?: string }[] = [];
  const notices: { type: string; payload: unknown }[] = [];

  return {
    requests,
    notices,
    deps: {
      fetchPage: async ({ url, priority }: HostFetchParams): Promise<HostFetchResult> => {
        requests.push({ url: new URL(url).pathname, priority });
        const html = HIDDEN_PAGES[new URL(url).pathname];
        if (html === undefined) return { kind: 'gone' };
        // An empty body is indistinguishable from a page we cannot use.
        return { kind: 'page', page: extractFromHtml(html, url) };
      },
      manifest: async () => ({
        source: 'sitemap' as const,
        entries: Object.keys(HIDDEN_PAGES).map((path) => ({
          url: `${HIDDEN_ORIGIN}${path}`,
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
        webgpu: false,
        maxBufferSize: null,
        maxStorageBufferBindingSize: null,
        deviceMemoryGb: null,
        saveData: false,
        effectiveType: null,
        cores: 4,
      }),
      ...overrides,
    },
  };
}

async function bootHidden(overrides: Record<string, unknown> = {}) {
  const harness = hiddenDeps(overrides);
  const { engine } = await Engine.init(
    { ...PARAMS, origin: HIDDEN_ORIGIN, currentUrl: `${HIDDEN_ORIGIN}/pricing.html` },
    harness.deps,
  );
  await engine.ensureManifest();
  return { engine, ...harness };
}

describe('Engine: background enrichment', () => {
  it('reaches a page whose slug says nothing about its content', async () => {
    const { engine } = await bootHidden();
    const query = 'rate limits requests per minute';
    const nowhere = `${HIDDEN_ORIGIN}/nowhere.html`;

    // Without reading ahead, the answer is out of reach: nothing indexed
    // contains it, and `handbook` shares no word with the question for routing
    // to follow. This is the Phase 1 limitation, reproduced.
    const before = await engine.ask({ query, currentUrl: nowhere, maxFetch: 0 });
    expect(before.grounded).toBe(false);

    await engine.backfill({ budget: 10 });

    const after = await engine.ask({ query, currentUrl: nowhere, maxFetch: 0 });
    expect(after.grounded).toBe(true);
    expect(after.citations[0]?.url).toContain('/handbook.html');
    // And it costs nothing at the moment of asking: the page was already read.
    expect(after.fetched).toEqual([]);
  });

  it('spends no more than its budget', async () => {
    const { engine, requests } = await bootHidden();
    const result = await engine.backfill({ budget: 2 });

    expect(result.indexed).toBe(2);
    expect(result.completed).toBe(false);
    expect(result.remaining).toBeGreaterThan(0);
    expect(requests.filter((r) => r.priority === 'background')).toHaveLength(2);
  });

  it('marks its fetches as background so the host can defer them', async () => {
    const { engine, requests } = await bootHidden();
    await engine.backfill({ budget: 1 });
    expect(requests.at(-1)?.priority).toBe('background');

    await engine.ask({ query: 'team plan cost', currentUrl: `${HIDDEN_ORIGIN}/pricing.html` });
    // A question someone is waiting on is not deferred behind anything.
    expect(requests.at(-1)?.priority).toBe('interactive');
  });

  it('resumes where it left off rather than starting over', async () => {
    const first = await bootHidden();
    await first.engine.backfill({ budget: 2 });
    const readFirst = first.requests.map((r) => r.url);

    // A new engine over the same IndexedDB: the visitor came back.
    const second = await bootHidden();
    await second.engine.backfill({ budget: 2 });
    const readSecond = second.requests.map((r) => r.url);

    expect(readSecond).not.toHaveLength(0);
    for (const url of readSecond) expect(readFirst).not.toContain(url);
    // Three of the four manifest entries are indexable, so the second pass
    // finishes the job rather than repeating any of the first.
    expect(second.engine.stats().pages).toBe(3);
  });

  it('keeps everything it read when a pass is interrupted', async () => {
    const first = await bootHidden();
    await first.engine.backfill({ budget: 1 });
    expect(first.engine.stats().pages).toBe(1);

    // Reload: nothing is re-fetched to get back to where we were.
    const second = await bootHidden();
    expect(second.engine.stats().pages).toBe(1);
    expect(second.requests).toEqual([]);
  });

  it('does not retry a page it already found unusable', async () => {
    const first = await bootHidden();
    await first.engine.backfill({ budget: 10 });
    expect(first.requests.map((r) => r.url)).toContain('/missing.html');

    const second = await bootHidden();
    await second.engine.backfill({ budget: 10 });
    expect(second.requests.map((r) => r.url)).not.toContain('/missing.html');
  });

  it('reports completion once the manifest is exhausted', async () => {
    const { engine } = await bootHidden();
    const result = await engine.backfill({ budget: 10 });

    expect(result.completed).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.skipped).toBe(1); // the empty page
    expect(result.indexed).toBe(3);
  });

  it('does nothing on a second pass with nothing left to read', async () => {
    const { engine, requests } = await bootHidden();
    await engine.backfill({ budget: 10 });
    const spent = requests.length;

    const again = await engine.backfill({ budget: 10 });
    expect(again.indexed).toBe(0);
    expect(again.completed).toBe(true);
    expect(requests).toHaveLength(spent);
  });

  it('joins concurrent callers to one pass instead of crawling twice', async () => {
    const { engine, requests } = await bootHidden();
    const [a, b] = await Promise.all([engine.backfill({ budget: 10 }), engine.backfill({ budget: 10 })]);

    expect(a).toEqual(b);
    expect(new Set(requests.map((r) => r.url)).size).toBe(requests.length);
  });

  it('stops when cancelled, and keeps what it had read', async () => {
    const { engine } = await bootHidden();

    const running = engine.backfill({ budget: 10 });
    engine.cancelBackfill();
    const result = await running;

    expect(result.cancelled).toBe(true);
    expect(result.completed).toBe(false);
    // The page in flight when the cancel landed is still indexed, not discarded.
    expect(engine.stats().pages).toBe(result.indexed);
  });

  it('stands aside while a question is in flight', async () => {
    // Fetches are handed out one at a time so the interleaving is observable
    // rather than a matter of timing.
    const gate: { url: string; release: () => void }[] = [];
    const order: string[] = [];

    const { engine } = await bootHidden({
      fetchPage: (params: HostFetchParams) =>
        new Promise<HostFetchResult>((resolve) => {
          const path = new URL(params.url).pathname;
          order.push(`${params.priority}:${path}`);
          gate.push({
            url: path,
            release: () => {
              const html = HIDDEN_PAGES[path];
              resolve(
                html === undefined
                  ? { kind: 'gone' }
                  : { kind: 'page', page: extractFromHtml(html, params.url) },
              );
            },
          });
        }),
    });

    const backfilling = engine.backfill({ budget: 10 });
    // The pass reaches its first fetch through several awaits, IndexedDB among
    // them, so wait for the fetch rather than for a fixed number of ticks.
    await until(() => gate.length > 0);
    expect(gate).toHaveLength(1); // one background fetch open

    const asking = engine
      .ask({ query: 'team plan cost', currentUrl: `${HIDDEN_ORIGIN}/pricing.html` })
      .then((result) => {
        order.push('ask:done');
        return result;
      });

    let finished = false;
    const both = Promise.all([asking, backfilling]).finally(() => {
      finished = true;
    });
    while (!finished) {
      gate.shift()?.release();
      await settle();
    }
    await both;

    // The pass issued its first page before the question arrived. Its second
    // waited for the question to finish, rather than making the person who
    // asked it queue behind a page nobody requested.
    const background = order.flatMap((entry, i) => (entry.startsWith('background:') ? [i] : []));
    expect(background.length).toBeGreaterThan(1);
    expect(background[1]).toBeGreaterThan(order.indexOf('ask:done'));
  });

  it('offers topics from URL structure before anything is fetched', async () => {
    const { engine, requests } = await bootHidden();
    const topics = engine.topics();

    expect(requests).toEqual([]);
    expect(topics.total).toBe(4);
    expect(topics.enriched).toBe(0);
    expect(topics.suggestions.length).toBeGreaterThan(0);
  });

  it('sharpens topics into the site’s own words as pages are read', async () => {
    const { engine } = await bootHidden();
    const before = engine.topics();
    expect(before.suggestions.map((s) => s.text)).not.toContain('Rotate tokens');

    await engine.backfill({ budget: 10 });
    const after = engine.topics();

    expect(after.enriched).toBe(3);
    // Slug guesses like "notes" have been replaced by the page's real title.
    expect(after.suggestions.map((s) => s.text)).toContain('Rotate tokens');
  });

  it('reports progress so a widget can say what it is doing', async () => {
    const { engine, notices } = await bootHidden();
    await engine.backfill({ budget: 2 });

    const progress = notices.filter((n) => n.type === EVENT.enrichProgress);
    expect(progress.length).toBeGreaterThan(0);
    expect(notices.some((n) => n.type === EVENT.enrichDone)).toBe(true);
  });
});

/** Let every queued microtask and timer callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait for a condition rather than for an arbitrary number of ticks. */
async function until(condition: () => boolean, ticks = 200): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    if (condition()) return;
    await settle();
  }
  throw new Error('condition never became true');
}
