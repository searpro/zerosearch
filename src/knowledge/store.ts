import type { Chunk, ManifestEntry } from './types.js';

/**
 * Persistent knowledge for one origin.
 *
 * IndexedDB is already origin-scoped, so the database name is fixed. What is
 * *not* automatic is invalidation: a stored vector is only meaningful under the
 * embedder that produced it and the chunker that split the text. Those, plus
 * the site owner's own version string, form a composite cache key which is
 * checked on open — a mismatch wipes the store rather than silently mixing
 * incompatible generations of data.
 */

export const DB_NAME = 'zerosearch';
export const SCHEMA_VERSION = 1;

const STORES = ['meta', 'manifest', 'pages', 'chunks', 'vectors'] as const;
type StoreName = (typeof STORES)[number];

const META_KEY = 'state';

export interface StoredPage {
  url: string;
  title: string;
  description: string | null;
  category: string | null;
  hash: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
  chunkIds: string[];
}

export interface StoredManifestEntry extends ManifestEntry {
  /**
   * Embedding of whatever routing currently knows about this page: its slug
   * before it has been fetched, its real title, description and summary after.
   */
  vector?: Float32Array;
  /** The page's own meta description: one curated line, written by the site. */
  description?: string | null;
  /** Extractive summary of the page. Absent until the page has been enriched. */
  summary?: string;
  /** Verbatim interrogative headings, offered as things to ask. */
  questions?: string[];
  /** Breadcrumb category, which can file a page where its URL does not. */
  category?: string | null;
  /** When enrichment last ran for this entry. Absent means slug-only. */
  enrichedAt?: number;
}

/**
 * Where the background backfill got to.
 *
 * Deliberately thin: which pages are indexed is already recorded by the `pages`
 * store, transactionally, one page at a time. That *is* the resume point, and
 * deriving it from the real data cannot drift from it the way a separate cursor
 * would. The only thing needing its own record is the pages we tried and cannot
 * use — without it, a resumed pass retries the same 404 on every visit.
 */
export interface BackfillState {
  /** URLs fetched and found unindexable: gone, empty, or refused by robots. */
  skipped: string[];
  startedAt: number | null;
  /** Set when a pass ran out of manifest rather than out of budget. */
  completedAt: number | null;
}

export interface Meta {
  cacheKey: string;
  manifestBuiltAt: number | null;
  /** Last time revalidation ran, so we do not re-check on every navigation. */
  revalidatedAt: number | null;
  backfill: BackfillState;
}

const EMPTY_BACKFILL: BackfillState = { skipped: [], startedAt: null, completedAt: null };

const EMPTY_META: Meta = {
  cacheKey: '',
  manifestBuiltAt: null,
  revalidatedAt: null,
  backfill: EMPTY_BACKFILL,
};

export class KnowledgeStore {
  readonly cacheKey: string;
  #db: IDBDatabase;
  /** True when the store was wiped on open because the cache key moved. */
  readonly wasReset: boolean;

  private constructor(db: IDBDatabase, cacheKey: string, wasReset: boolean) {
    this.#db = db;
    this.cacheKey = cacheKey;
    this.wasReset = wasReset;
  }

  static async open(cacheKey: string, factory: IDBFactory = indexedDB): Promise<KnowledgeStore> {
    const db = await promisify(factory.open(DB_NAME, SCHEMA_VERSION), (request) => {
      const database = request.result;
      for (const name of STORES) {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name);
      }
    });

    const store = new KnowledgeStore(db, cacheKey, false);
    const meta = await store.getMeta();

    if (meta.cacheKey !== cacheKey) {
      // Vectors from a different embedder, or chunks from a different chunker,
      // are not merely stale — they are incomparable with anything new.
      await store.clear();
      await store.setMeta({ ...EMPTY_META, cacheKey });
      return new KnowledgeStore(db, cacheKey, meta.cacheKey !== '');
    }
    return store;
  }

  async getMeta(): Promise<Meta> {
    const stored = await this.#get<Meta>('meta', META_KEY);
    if (!stored) return { ...EMPTY_META, backfill: { ...EMPTY_BACKFILL } };
    // A record written before `backfill` existed is still a valid cache — the
    // vectors in it are fine — so fill the field in rather than discarding it.
    return { ...EMPTY_META, ...stored, backfill: { ...EMPTY_BACKFILL, ...stored.backfill } };
  }

  async setMeta(patch: Partial<Meta>): Promise<void> {
    const next = { ...(await this.getMeta()), ...patch };
    await this.#run('meta', 'readwrite', (store) => store.put(next, META_KEY));
  }

  async putManifest(entries: StoredManifestEntry[]): Promise<void> {
    await this.#tx(['manifest'], 'readwrite', (tx) => {
      const store = tx.objectStore('manifest');
      store.clear();
      for (const entry of entries) store.put(entry, entry.url);
    });
  }

  /**
   * Update one manifest entry.
   *
   * Enrichment touches a single page at a time, and rewriting all several
   * hundred entries for each one turns a background pass into quadratic
   * IndexedDB traffic on exactly the devices least able to absorb it.
   */
  async putManifestEntry(entry: StoredManifestEntry): Promise<void> {
    await this.#run('manifest', 'readwrite', (store) => store.put(entry, entry.url));
  }

  async getManifest(): Promise<StoredManifestEntry[]> {
    return await this.#getAll<StoredManifestEntry>('manifest');
  }

  /**
   * Write a page, its chunks and its vectors as one transaction, replacing any
   * previous version. Partial state here would mean chunks with no vectors,
   * which retrieval cannot recover from.
   */
  async putPage(page: StoredPage, chunks: Chunk[], vectors: Float32Array[]): Promise<void> {
    if (chunks.length !== vectors.length) {
      throw new Error(`putPage: ${chunks.length} chunks but ${vectors.length} vectors`);
    }

    const previous = await this.getPage(page.url);

    await this.#tx(['pages', 'chunks', 'vectors'], 'readwrite', (tx) => {
      const chunkStore = tx.objectStore('chunks');
      const vectorStore = tx.objectStore('vectors');

      // Re-chunking can produce fewer chunks than last time; orphans would
      // otherwise linger in the index forever.
      for (const id of previous?.chunkIds ?? []) {
        chunkStore.delete(id);
        vectorStore.delete(id);
      }

      chunks.forEach((chunk, i) => {
        chunkStore.put(chunk, chunk.id);
        vectorStore.put(vectors[i]!, chunk.id);
      });
      tx.objectStore('pages').put(page, page.url);
    });
  }

  async getPage(url: string): Promise<StoredPage | undefined> {
    return await this.#get<StoredPage>('pages', url);
  }

  async getAllPages(): Promise<StoredPage[]> {
    return await this.#getAll<StoredPage>('pages');
  }

  async getAllChunks(): Promise<Chunk[]> {
    return await this.#getAll<Chunk>('chunks');
  }

  /** Chunk id to vector, for rebuilding the in-memory index on boot. */
  async getAllVectors(): Promise<Map<string, Float32Array>> {
    const [keys, values] = await Promise.all([
      this.#getAllKeys('vectors'),
      this.#getAll<Float32Array>('vectors'),
    ]);
    const out = new Map<string, Float32Array>();
    keys.forEach((key, i) => {
      const value = values[i];
      if (value) out.set(String(key), value);
    });
    return out;
  }

  async deletePage(url: string): Promise<void> {
    const page = await this.getPage(url);
    if (!page) return;

    await this.#tx(['pages', 'chunks', 'vectors'], 'readwrite', (tx) => {
      for (const id of page.chunkIds) {
        tx.objectStore('chunks').delete(id);
        tx.objectStore('vectors').delete(id);
      }
      tx.objectStore('pages').delete(url);
    });
  }

  /** Drops indexed content but keeps `meta`, so the cache key survives. */
  async clear(): Promise<void> {
    await this.#tx(['manifest', 'pages', 'chunks', 'vectors'], 'readwrite', (tx) => {
      for (const name of ['manifest', 'pages', 'chunks', 'vectors'] as const) {
        tx.objectStore(name).clear();
      }
    });
  }

  close(): void {
    this.#db.close();
  }

  #get<T>(name: StoreName, key: string): Promise<T | undefined> {
    return this.#run<T | undefined>(name, 'readonly', (store) => store.get(key));
  }

  #getAll<T>(name: StoreName): Promise<T[]> {
    return this.#run<T[]>(name, 'readonly', (store) => store.getAll());
  }

  #getAllKeys(name: StoreName): Promise<IDBValidKey[]> {
    return this.#run<IDBValidKey[]>(name, 'readonly', (store) => store.getAllKeys());
  }

  #run<T>(name: StoreName, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(name, mode);
      const request = fn(tx.objectStore(name));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error(`${name} request failed`));
      tx.onabort = () => reject(tx.error ?? new Error(`${name} transaction aborted`));
    });
  }

  /** Multi-store write, resolved on transaction completion rather than per request. */
  #tx(names: StoreName[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(names, mode);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      try {
        fn(tx);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }
}

function promisify(
  request: IDBOpenDBRequest,
  onUpgrade: (request: IDBOpenDBRequest) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = () => onUpgrade(request);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb open failed'));
    // Another tab holding an older version open would otherwise hang here.
    request.onblocked = () => reject(new Error('indexeddb upgrade blocked by another tab'));
  });
}

/**
 * The composite cache key. Every input that changes the *meaning* of stored
 * data belongs here, or a stale generation survives an upgrade and quietly
 * corrupts retrieval.
 */
export function buildCacheKey(parts: {
  origin: string;
  embedderId: string;
  chunkerVersion: number;
  extractorVersion: number;
  enrichmentVersion: number;
  siteVersion: string | null;
}): string {
  return [
    `s${SCHEMA_VERSION}`,
    parts.origin,
    parts.embedderId,
    `c${parts.chunkerVersion}`,
    `x${parts.extractorVersion}`,
    // Enrichment decides what a routing entry says about a page it has read.
    // Changing that changes which pages a question reaches, and the stored
    // summaries cannot be rebuilt without refetching, so a bump starts over.
    `e${parts.enrichmentVersion}`,
    parts.siteVersion ?? '-',
  ].join('|');
}
