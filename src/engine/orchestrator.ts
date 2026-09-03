import type { WebAIConfig } from '../types.js';
import type { Emitter } from './events.js';
import { Host } from './host.js';
import {
  EVENT,
  WORKER,
  type AskResult,
  type BuildManifestResult,
  type IndexProgress,
  type InitResult,
  type RevalidateResult,
  type StatsResult,
} from './protocol.js';
import { RpcPeer, type Transport } from './rpc.js';

/**
 * Main-thread facade over the worker.
 *
 * Owns the worker's lifetime, answers its DOM callbacks through `Host`, and
 * republishes its notifications onto the public event bus. Everything here is
 * lifecycle and coordination; the actual indexing and retrieval live in the
 * worker's `Engine`.
 */

export interface OrchestratorOptions {
  config: WebAIConfig;
  workerUrl: string;
  events: Emitter;
  /** Injection point for tests, which drive a fake worker over a MessageChannel. */
  createWorker?: (url: string) => Transport & { terminate?: () => void };
}

export class Orchestrator {
  #options: OrchestratorOptions;
  #worker: (Transport & { terminate?: () => void }) | null = null;
  #peer: RpcPeer | null = null;
  #host: Host | null = null;

  #starting: Promise<InitResult> | null = null;
  #preparing: Promise<void> | null = null;
  #init: InitResult | null = null;

  constructor(options: OrchestratorOptions) {
    this.#options = options;
  }

  get initResult(): InitResult | null {
    return this.#init;
  }

  get ready(): boolean {
    return this.#init !== null;
  }

  /** Boot the worker and load the embedder. Idempotent. */
  start(): Promise<InitResult> {
    this.#starting ??= this.#start();
    return this.#starting;
  }

  async #start(): Promise<InitResult> {
    const { config, events } = this.#options;
    const origin = new URL(config.sitemapUrl).origin;

    const worker = (this.#options.createWorker ?? defaultWorker)(this.#options.workerUrl);
    this.#worker = worker;

    const peer = new RpcPeer(worker);
    this.#peer = peer;
    this.#watchForWorkerFailure(worker, peer);

    this.#host = new Host({
      origin,
      sitemapUrl: config.sitemapUrl,
      maxPages: config.maxPages,
      currentUrl: location.href,
    });
    this.#host.register(peer);

    // Republish worker notifications onto the public bus.
    peer.on(EVENT.modelProgress, (p: { name: string; loaded: number; total: number }) =>
      events.emit('model:progress', p),
    );
    peer.on(EVENT.indexStart, (p: { urls: number }) =>
      events.emit('index:start', { source: 'crawl', urls: p.urls }),
    );
    peer.on(EVENT.indexProgress, (p: IndexProgress) =>
      events.emit('index:progress', { done: p.done, total: p.total, url: p.url }),
    );

    const result = await peer.call<InitResult>(WORKER.init, {
      origin,
      currentUrl: location.href,
      sitemapUrl: config.sitemapUrl,
      maxTier: config.maxTier,
      modelBaseUrl: config.modelBaseUrl,
      maxPages: config.maxPages,
      siteVersion: config.version,
    });

    this.#init = result;
    events.emit('tier', { tier: result.tier, reason: result.tierReason, capped: result.tierCapped });
    events.emit('ready', { tier: result.tier });
    return result;
  }

  /**
   * Get the routing manifest in place. Idempotent, and serialised across tabs:
   * every open tab is a separate crawler, and without the lock they would all
   * fetch the same sitemap simultaneously.
   */
  prepare(): Promise<void> {
    this.#preparing ??= this.#prepare();
    return this.#preparing;
  }

  async #prepare(): Promise<void> {
    await this.start();
    const { events } = this.#options;

    const build = async (): Promise<BuildManifestResult> =>
      await this.#call<BuildManifestResult>(WORKER.ensureManifest);

    const result = await withLock(`web-ai:manifest:${location.origin}`, build);

    const stats = await this.stats();
    events.emit('index:done', {
      pages: stats.pages,
      chunks: stats.chunks,
      fromCache: result.source === 'cache',
    });
  }

  async ask(query: string, { maxFetch }: { maxFetch?: number } = {}): Promise<AskResult> {
    await this.prepare();
    return await this.#call<AskResult>(WORKER.ask, {
      query,
      currentUrl: location.href,
      maxFetch,
    });
  }

  async revalidate(): Promise<RevalidateResult> {
    await this.start();
    return await this.#call<RevalidateResult>(WORKER.revalidate);
  }

  async stats(): Promise<StatsResult> {
    await this.start();
    return await this.#call<StatsResult>(WORKER.stats);
  }

  destroy(): void {
    this.#peer?.dispose('orchestrator destroyed');
    this.#worker?.terminate?.();
    this.#peer = null;
    this.#worker = null;
    this.#starting = null;
    this.#preparing = null;
    this.#init = null;
  }

  /**
   * Fail fast when the worker script never loads.
   *
   * Without this, a blocked or missing worker is completely silent: no error
   * event reaches anyone, and the first RPC call simply hangs until it times
   * out two minutes later. A strict Content-Security-Policy is the common
   * cause, and it deserves a message that says so.
   */
  #watchForWorkerFailure(worker: Transport, peer: RpcPeer): void {
    const target = worker as unknown as {
      addEventListener?: (type: string, listener: (event: unknown) => void) => void;
    };
    if (typeof target.addEventListener !== 'function') return;

    target.addEventListener('error', (event: unknown) => {
      const detail = event as { message?: string; filename?: string };
      const message =
        detail?.message ??
        `the worker at ${this.#options.workerUrl} could not be loaded — check that the file is deployed and that your Content-Security-Policy allows worker-src`;

      this.#options.events.emit('error', { scope: 'worker', message, cause: event });
      // Reject anything in flight instead of leaving callers to time out.
      peer.dispose(message);
    });

    target.addEventListener('messageerror', () => {
      this.#options.events.emit('error', {
        scope: 'worker',
        message: 'a message from the worker could not be deserialised',
      });
    });
  }

  async #call<R>(method: string, params?: unknown): Promise<R> {
    const peer = this.#peer;
    if (!peer) throw new Error('orchestrator is not started');
    try {
      return await peer.call<R>(method, params);
    } catch (error) {
      this.#options.events.emit('error', {
        scope: method,
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
      throw error;
    }
  }
}

function defaultWorker(url: string): Transport & { terminate?: () => void } {
  return new Worker(url) as unknown as Transport & { terminate?: () => void };
}

interface LockManager {
  request<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Run under a cross-tab lock when the browser has one.
 *
 * Web Locks is unavailable in some contexts, and there it degrades to simply
 * running — duplicated work across tabs is wasteful, not incorrect, because
 * IndexedDB writes are last-writer-wins over identical content.
 */
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (navigator as unknown as { locks?: LockManager }).locks;
  if (!locks) return await fn();
  return await locks.request(name, fn);
}
