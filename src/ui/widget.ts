import type { Emitter } from '../engine/events.js';
import type { WebAIConfig } from '../types.js';
import { styles } from './theme.js';

const HOST_TAG = 'web-ai-root';

/**
 * The widget shell: a floating bubble that opens a panel.
 *
 * Everything lives inside a shadow root so the host page's CSS cannot reach in
 * and our CSS cannot leak out. Phase 0 renders a placeholder body; the message
 * list lands in Phase 1.
 */
export class Widget {
  #config: WebAIConfig;
  #events: Emitter;
  #host: HTMLElement;
  #root: ShadowRoot;
  #bubble!: HTMLButtonElement;
  #panel!: HTMLElement;
  #status!: HTMLElement;
  #body!: HTMLElement;
  #open = false;
  #lastFocused: Element | null = null;

  constructor(config: WebAIConfig, events: Emitter) {
    this.#config = config;
    this.#events = events;
    this.#host = document.createElement(HOST_TAG);
    this.#root = this.#host.attachShadow({ mode: 'open' });
    this.#render();
  }

  get element(): HTMLElement {
    return this.#host;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  mount(parent: ParentNode = document.body): void {
    parent.appendChild(this.#host);
  }

  destroy(): void {
    this.#host.remove();
  }

  open(): void {
    if (this.#open) return;
    this.#open = true;
    this.#lastFocused = document.activeElement;
    this.#bubble.hidden = true;
    this.#panel.hidden = false;
    this.#panel.querySelector<HTMLElement>('.close')?.focus();
    this.#events.emit('open', {});
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#panel.hidden = true;
    this.#bubble.hidden = false;
    // Send focus back where it came from, else it lands on <body>.
    const target = this.#lastFocused instanceof HTMLElement ? this.#lastFocused : this.#bubble;
    target.focus();
    this.#events.emit('close', {});
  }

  toggle(): void {
    this.#open ? this.close() : this.open();
  }

  /** Single line of state under the title — loading progress, errors, and so on. */
  setStatus(text: string): void {
    this.#status.textContent = text;
  }

  #render(): void {
    const style = document.createElement('style');
    style.textContent = styles(this.#config);

    this.#bubble = document.createElement('button');
    this.#bubble.className = 'bubble';
    this.#bubble.type = 'button';
    this.#bubble.setAttribute('aria-label', 'Open the site assistant');
    this.#bubble.innerHTML = icon();
    this.#bubble.addEventListener('click', () => this.open());

    this.#panel = document.createElement('section');
    this.#panel.className = 'panel';
    this.#panel.hidden = true;
    this.#panel.setAttribute('role', 'dialog');
    this.#panel.setAttribute('aria-label', 'Site assistant');

    const header = document.createElement('div');
    header.className = 'header';

    const title = document.createElement('h2');
    title.className = 'title';
    title.textContent = 'Ask about this site';

    this.#status = document.createElement('span');
    this.#status.className = 'status';

    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the site assistant');
    close.textContent = '✕';
    close.addEventListener('click', () => this.close());

    header.append(title, this.#status, close);

    this.#body = document.createElement('div');
    this.#body.className = 'body';
    const placeholder = document.createElement('p');
    placeholder.className = 'placeholder';
    placeholder.textContent = 'Not wired up yet.';
    this.#body.append(placeholder);

    this.#panel.append(header, this.#body);
    this.#panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.close();
      }
    });

    this.#root.append(style, this.#bubble, this.#panel);
  }
}

function icon(): string {
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
  </svg>`;
}
