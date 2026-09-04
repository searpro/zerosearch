import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeStore, buildCacheKey } from '../../src/knowledge/store.js';
import type { Chunk } from '../../src/knowledge/types.js';

let factory: IDBFactory;

// A fresh backing store per test; otherwise cache-key tests leak into each other.
beforeEach(() => {
  factory = new IDBFactory();
});

const KEY = buildCacheKey({
  origin: 'https://meridian.example',
  embedderId: 'Xenova/all-MiniLM-L6-v2@q8',
  chunkerVersion: 1,
  extractorVersion: 1,
  enrichmentVersion: 1,
  siteVersion: null,
});

const open = (key = KEY) => KnowledgeStore.open(key, factory as unknown as IDBFactory);

const chunk = (url: string, i: number): Chunk => ({
  id: `${url}#${i}`,
  url,
  index: i,
  headingPath: ['Pricing'],
  text: `Pricing › chunk ${i}`,
  body: `chunk ${i}`,
});

const vector = (n: number) => Float32Array.from([n, n + 1, n + 2]);

const page = (url: string, chunkIds: string[], hash = 'h1') => ({
  url,
  title: 'Pricing',
  description: null,
  category: null,
  hash,
  etag: 'W/"1"',
  lastModified: null,
  fetchedAt: 1,
  chunkIds,
});

describe('KnowledgeStore, round trips', () => {
  it('stores and reads back a page with its chunks and vectors', async () => {
    const store = await open();
    const url = 'https://meridian.example/pricing.html';
    const chunks = [chunk(url, 0), chunk(url, 1)];

    await store.putPage(
      page(url, chunks.map((c) => c.id)),
      chunks,
      [vector(1), vector(2)],
    );

    expect((await store.getPage(url))?.title).toBe('Pricing');
    expect(await store.getAllChunks()).toHaveLength(2);

    const vectors = await store.getAllVectors();
    expect(vectors.size).toBe(2);
    expect([...vectors.get(`${url}#1`)!]).toEqual([2, 3, 4]);
    store.close();
  });

  it('stores and reads back the routing manifest', async () => {
    const store = await open();
    await store.putManifest([
      { url: 'https://meridian.example/a.html', slugTitle: 'A', segments: [], lastmod: null, priority: null },
      {
        url: 'https://meridian.example/b.html',
        slugTitle: 'B',
        segments: ['docs'],
        lastmod: '2026-01-01',
        priority: 0.8,
        vector: vector(9),
      },
    ]);

    const manifest = await store.getManifest();
    expect(manifest).toHaveLength(2);
    expect([...manifest.find((e) => e.slugTitle === 'B')!.vector!]).toEqual([9, 10, 11]);
    store.close();
  });

  it('replaces the manifest wholesale rather than merging', async () => {
    const store = await open();
    const entry = (url: string) => ({ url, slugTitle: 'x', segments: [], lastmod: null, priority: null });

    await store.putManifest([entry('https://meridian.example/a'), entry('https://meridian.example/b')]);
    await store.putManifest([entry('https://meridian.example/c')]);

    expect((await store.getManifest()).map((e) => e.url)).toEqual(['https://meridian.example/c']);
    store.close();
  });

  it('persists across reopen', async () => {
    const url = 'https://meridian.example/a.html';
    const first = await open();
    await first.putPage(page(url, [`${url}#0`]), [chunk(url, 0)], [vector(1)]);
    await first.setMeta({ manifestBuiltAt: 12345 });
    first.close();

    const second = await open();
    expect((await second.getMeta()).manifestBuiltAt).toBe(12345);
    expect(await second.getAllChunks()).toHaveLength(1);
    expect(second.wasReset).toBe(false);
    second.close();
  });
});

describe('KnowledgeStore, invalidation', () => {
  it('wipes content when the cache key changes', async () => {
    const url = 'https://meridian.example/a.html';
    const first = await open();
    await first.putPage(page(url, [`${url}#0`]), [chunk(url, 0)], [vector(1)]);
    first.close();

    // A different embedder produces vectors that are not comparable with the
    // stored ones, so keeping them would silently corrupt retrieval.
    const changed = buildCacheKey({
      origin: 'https://meridian.example',
      embedderId: 'Xenova/bge-small-en-v1.5@q8',
      chunkerVersion: 1,
      extractorVersion: 1,
      enrichmentVersion: 1,
      siteVersion: null,
    });

    const second = await open(changed);
    expect(second.wasReset).toBe(true);
    expect(await second.getAllChunks()).toEqual([]);
    expect(await second.getAllVectors()).toEqual(new Map());
    expect((await second.getMeta()).cacheKey).toBe(changed);
    second.close();
  });

  it('wipes when the site owner bumps their version string', async () => {
    const url = 'https://meridian.example/a.html';
    const first = await open();
    await first.putPage(page(url, [`${url}#0`]), [chunk(url, 0)], [vector(1)]);
    first.close();

    const bumped = buildCacheKey({
      origin: 'https://meridian.example',
      embedderId: 'Xenova/all-MiniLM-L6-v2@q8',
      chunkerVersion: 1,
      extractorVersion: 1,
      enrichmentVersion: 1,
      siteVersion: 'deploy-2',
    });

    const second = await open(bumped);
    expect(await second.getAllPages()).toEqual([]);
    second.close();
  });

  it('does not report a reset on a genuinely first run', async () => {
    const store = await open();
    expect(store.wasReset).toBe(false);
    store.close();
  });

  it('buildCacheKey changes with every meaningful input', () => {
    const base = {
      origin: 'https://a.example',
      embedderId: 'm',
      chunkerVersion: 1,
      extractorVersion: 1,
      enrichmentVersion: 1,
      siteVersion: null,
    };
    const key = buildCacheKey(base);

    expect(buildCacheKey({ ...base, origin: 'https://b.example' })).not.toBe(key);
    expect(buildCacheKey({ ...base, embedderId: 'other' })).not.toBe(key);
    expect(buildCacheKey({ ...base, chunkerVersion: 2 })).not.toBe(key);
    expect(buildCacheKey({ ...base, extractorVersion: 2 })).not.toBe(key);
    expect(buildCacheKey({ ...base, enrichmentVersion: 2 })).not.toBe(key);
    expect(buildCacheKey({ ...base, siteVersion: 'v2' })).not.toBe(key);
    expect(buildCacheKey({ ...base })).toBe(key);
  });
});

describe('KnowledgeStore, updates and deletes', () => {
  it('re-indexing a page leaves no orphaned chunks behind', async () => {
    const store = await open();
    const url = 'https://meridian.example/a.html';

    const before = [chunk(url, 0), chunk(url, 1), chunk(url, 2)];
    await store.putPage(page(url, before.map((c) => c.id)), before, [vector(1), vector(2), vector(3)]);
    expect(await store.getAllChunks()).toHaveLength(3);

    // The page shrank. Without cleanup, chunks #1 and #2 would stay searchable
    // forever and cite content that no longer exists.
    const after = [chunk(url, 0)];
    await store.putPage(page(url, after.map((c) => c.id), 'h2'), after, [vector(9)]);

    expect(await store.getAllChunks()).toHaveLength(1);
    expect((await store.getAllVectors()).size).toBe(1);
    expect((await store.getPage(url))?.hash).toBe('h2');
    store.close();
  });

  it('deletes a page with everything belonging to it', async () => {
    const store = await open();
    const a = 'https://meridian.example/a.html';
    const b = 'https://meridian.example/b.html';

    await store.putPage(page(a, [`${a}#0`]), [chunk(a, 0)], [vector(1)]);
    await store.putPage(page(b, [`${b}#0`]), [chunk(b, 0)], [vector(2)]);

    await store.deletePage(a);

    expect(await store.getAllPages()).toHaveLength(1);
    expect((await store.getAllChunks()).map((c) => c.url)).toEqual([b]);
    expect((await store.getAllVectors()).size).toBe(1);
    store.close();
  });

  it('deleting an unknown page is a no-op', async () => {
    const store = await open();
    await expect(store.deletePage('https://meridian.example/nope')).resolves.toBeUndefined();
    store.close();
  });

  it('rejects a chunk/vector count mismatch instead of storing broken state', async () => {
    const store = await open();
    const url = 'https://meridian.example/a.html';
    await expect(
      store.putPage(page(url, [`${url}#0`, `${url}#1`]), [chunk(url, 0), chunk(url, 1)], [vector(1)]),
    ).rejects.toThrow(/2 chunks but 1 vectors/);
    store.close();
  });

  it('clear() empties content but keeps the cache key', async () => {
    const store = await open();
    const url = 'https://meridian.example/a.html';
    await store.putPage(page(url, [`${url}#0`]), [chunk(url, 0)], [vector(1)]);

    await store.clear();

    expect(await store.getAllPages()).toEqual([]);
    expect((await store.getMeta()).cacheKey).toBe(KEY);
    store.close();
  });
});
