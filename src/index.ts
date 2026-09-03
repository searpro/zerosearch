import { readScriptAttributes, resolveConfig } from './config.js';
import { whenIdle } from './dom/idle.js';
import { Emitter } from './engine/events.js';
import { Orchestrator } from './engine/orchestrator.js';
import type { AskResult, GenerationStatus, StatsResult } from './engine/protocol.js';
import type { Transport } from './engine/rpc.js';
import type { WebAIConfig, WebAIEvent, WebAIEventMap, WebAIEventName } from './types.js';
import { Widget } from './ui/widget.js';

export const VERSION = '0.0.0';

/** The `<script>` tag opts in by carrying `data-web-ai`. */
const MARKER = 'data-web-ai';

export class WebAI {
  readonly version = VERSION;

  #events = new Emitter((error) => this.#log('a listener threw', error));
  #config: WebAIConfig | null = null;
  #widget: Widget | null = null;
  #orchestrator: Orchestrator | null = null;
  #booting: Promise<void> | null = null;
  #scriptEl: HTMLScriptElement | null = null;

  get config(): Readonly<WebAIConfig> | null {
    return this.#config;
  }

  get widget(): Widget | null {
    return this.#widget;
  }

  /**
   * Resolve config and mount the widget. Cheap by design: no worker, no model
   * and no network happen here, so a page that embeds the script but is never
   * interacted with pays almost nothing.
   */
  boot(overrides: Partial<WebAIConfig> = {}): Promise<void> {
    this.#booting ??= this.#boot(overrides).catch((error: unknown) => {
      // A widget failing must not surface as an unhandled rejection on the host page.
      this.#events.emit('error', { scope: 'boot', message: describe(error), cause: error });
      this.#log('boot failed', error);
    });
    return this.#booting;
  }

  async #boot(overrides: Partial<WebAIConfig>): Promise<void> {
    this.#scriptEl ??= findScriptTag();
    const attrs = this.#scriptEl ? readScriptAttributes(this.#scriptEl) : {};
    const { config, warnings } = resolveConfig(attrs, overrides);
    this.#config = config;

    if (warnings.length > 0 && config.debug) {
      for (const warning of warnings) console.warn(`[web-ai] ${warning}`);
    }
    this.#log('config', config);

    const worker = this.#workerTarget();
    this.#orchestrator = new Orchestrator({
      config,
      workerUrl: worker.url,
      events: this.#events,
      createWorker: (url) => new Worker(url, { type: worker.type }) as unknown as Transport,
    });

    if (config.widget) {
      const widget = new Widget(config, this.#events);
      this.#widget = widget;
      widget.onAsk = (query, onToken) => this.#orchestrator!.ask(query, { onToken });
      widget.onEnableGeneration = async () => {
        await this.enableGeneration();
      };
      // Opening the panel is the clearest signal of intent there is, so it
      // always starts the engine regardless of the preload setting.
      widget.onFirstOpen = () => {
        void this.#orchestrator
          ?.prepare()
          .then(() => this.#refreshGenerationOffer())
          .catch(() => {});
      };
      this.#wireStatus();

      // If we booted from a parser-blocking script, <body> may not exist yet.
      await domReady();
      this.#widget.mount();
    }

    if (config.preload === 'idle') {
      // Behind the browser's own work: the visitor came for the page, not for us.
      void whenIdle(3000).then(() => this.#orchestrator?.prepare().catch(() => {}));
    }
  }

  /** Ask a question. Starts the engine on demand if it is not running yet. */
  async ask(query: string): Promise<AskResult> {
    await this.boot();
    if (!this.#orchestrator) throw new Error('web-ai failed to boot');
    return await this.#orchestrator.ask(query);
  }

  /** Load the model and routing manifest without asking anything. */
  async prepare(): Promise<void> {
    await this.boot();
    await this.#orchestrator?.prepare();
    await this.#refreshGenerationOffer();
  }

  /**
   * Load the generative model. This is the ~300MB download, so it happens only
   * when something explicitly asks — the visitor clicking the offer, or a site
   * that set `data-generate="auto"`.
   */
  async enableGeneration(): Promise<GenerationStatus | null> {
    await this.boot();
    if (this.#config?.generate === 'never') return null;

    const status = (await this.#orchestrator?.enableGeneration()) ?? null;
    if (status) this.#widget?.showGenerationOffer(status);
    return status;
  }

  async generationStatus(): Promise<GenerationStatus | null> {
    await this.boot();
    return (await this.#orchestrator?.generationStatus()) ?? null;
  }

  /**
   * Decide whether to show the offer, download immediately, or say nothing.
   *
   * A model already in the browser cache costs nothing to turn on, so a
   * returning visitor is not asked to approve a download they already made.
   */
  async #refreshGenerationOffer(): Promise<void> {
    const config = this.#config;
    if (!config || config.generate === 'never' || !this.#widget) return;

    try {
      const status = await this.#orchestrator!.generationStatus();
      if (!status.available) return;

      if (config.generate === 'auto' || status.cached) {
        await this.enableGeneration();
        return;
      }
      this.#widget.showGenerationOffer(status);
    } catch {
      // No offer is a fine outcome; retrieval-only answers still work.
    }
  }

  async stats(): Promise<StatsResult | null> {
    await this.boot();
    return (await this.#orchestrator?.stats()) ?? null;
  }

  /** Re-check indexed pages against the server and re-index what changed. */
  async revalidate(): Promise<void> {
    await this.boot();
    await this.#orchestrator?.revalidate();
  }

  open(): void {
    this.#widget?.open();
  }

  close(): void {
    this.#widget?.close();
  }

  toggle(): void {
    this.#widget?.toggle();
  }

  on<K extends WebAIEventName>(type: K, fn: (payload: WebAIEventMap[K]) => void): () => void {
    return this.#events.on(type, fn);
  }

  /** Subscribe to everything. This is the hook a site pipes into its own analytics. */
  onEvent(fn: (event: WebAIEvent) => void): () => void {
    return this.#events.onAny(fn);
  }

  destroy(): void {
    this.#orchestrator?.destroy();
    this.#widget?.destroy();
    this.#orchestrator = null;
    this.#widget = null;
    this.#events.clear();
    this.#booting = null;
  }

  /** Keep the widget's status line in step with what the engine is doing. */
  #wireStatus(): void {
    const widget = this.#widget;
    if (!widget) return;

    this.#events.on('model:progress', ({ loaded, total }) => {
      if (total > 0) widget.setStatus(`Loading model ${Math.round((loaded / total) * 100)}%`);
    });
    this.#events.on('index:start', ({ urls }) => widget.setStatus(`Reading ${urls} pages…`));
    this.#events.on('index:done', ({ pages }) => {
      widget.setStatus(pages > 0 ? `${pages} pages indexed` : 'Ready');
    });
    this.#events.on('generation:ready', ({ modelLabel }) => widget.setStatus(`${modelLabel} ready`));
    this.#events.on('error', ({ message }) => widget.setStatus(message));
  }

  /**
   * Where to load the worker from.
   *
   * In production the worker sits next to the script that loaded us. In
   * development the script *is* the TypeScript source, so the worker is
   * resolved as a module the dev server can transform.
   */
  #workerTarget(): { url: string; type: 'classic' | 'module' } {
    // Always a module worker: the built worker is ES format so that the ONNX
    // runtime's .wasm files stay separate assets instead of being base64-inlined.
    if (this.#config?.workerUrl) return { url: this.#config.workerUrl, type: 'module' };

    const src = this.#scriptEl?.src;
    // Test the pathname, not the whole URL: a dev server appends a cache-busting
    // query string, which makes a naive extension check on `src` always fail.
    if (src && !isTypeScript(src)) {
      return { url: new URL('./web-ai.worker.js', src).href, type: 'module' };
    }
    return { url: new URL('./worker/worker.ts', import.meta.url).href, type: 'module' };
  }

  #log(...args: unknown[]): void {
    if (this.#config?.debug) console.debug('[web-ai]', ...args);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when we were loaded from TypeScript source rather than from a build. */
function isTypeScript(url: string): boolean {
  try {
    return /\.tsx?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * The script tag that loaded us. `document.currentScript` is the reliable
 * answer for a classic script but is null for module scripts and for anything
 * running async, so fall back to the opt-in marker attribute.
 */
function findScriptTag(): HTMLScriptElement | null {
  const current = document.currentScript;
  if (current instanceof HTMLScriptElement && current.hasAttribute(MARKER)) return current;
  return document.querySelector<HTMLScriptElement>(`script[${MARKER}]`);
}

function domReady(): Promise<void> {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

declare global {
  interface Window {
    WebAI?: WebAI;
  }
}

const instance: WebAI = (typeof window !== 'undefined' && window.WebAI) || new WebAI();

if (typeof window !== 'undefined') {
  window.WebAI = instance;
  // Auto-boot only when a marker script tag is present. Importing the module
  // directly gives you the API without anything appearing on the page.
  if (document.querySelector(`script[${MARKER}]`)) {
    void instance.boot();
  }
}

export default instance;
export { Emitter } from './engine/events.js';
export { DEFAULT_CONFIG, resolveConfig, readScriptAttributes } from './config.js';
export { Widget } from './ui/widget.js';
export { Orchestrator } from './engine/orchestrator.js';
export type * from './types.js';
export type * from './engine/protocol.js';
