import { readScriptAttributes, resolveConfig } from './config.js';
import { Emitter } from './engine/events.js';
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
  #booting: Promise<void> | null = null;
  #scriptEl: HTMLScriptElement | null = null;

  get config(): Readonly<WebAIConfig> | null {
    return this.#config;
  }

  get widget(): Widget | null {
    return this.#widget;
  }

  /**
   * Resolve config, mount the widget. Idempotent: repeat calls return the
   * in-flight or already-settled boot rather than starting a second one.
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

    if (config.widget) {
      this.#widget = new Widget(config, this.#events);
      // If we booted from a parser-blocking script, <body> may not exist yet.
      await domReady();
      this.#widget.mount();
    }

    this.#events.emit('ready', { tier: 'retrieval' });
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
    this.#widget?.destroy();
    this.#widget = null;
    this.#events.clear();
    this.#booting = null;
  }

  /** Where `web-ai.worker.js` should be fetched from, given how we were loaded. */
  workerUrl(): string | null {
    if (this.#config?.workerUrl) return this.#config.workerUrl;
    const src = this.#scriptEl?.src;
    if (!src) return null;
    return new URL('./web-ai.worker.js', src).href;
  }

  #log(...args: unknown[]): void {
    if (this.#config?.debug) console.debug('[web-ai]', ...args);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
export type * from './types.js';
