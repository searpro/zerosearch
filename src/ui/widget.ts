import type { AskResult } from '../engine/protocol.js';
import type { Emitter } from '../engine/events.js';
import type { WebAIConfig } from '../types.js';
import { answerTurn, errorTurn, pendingTurn, userTurn } from './render.js';
import { styles } from './theme.js';

const HOST_TAG = 'web-ai-root';

/**
 * The widget: a floating bubble that opens a panel with a composer and a
 * transcript.
 *
 * Everything lives inside a shadow root so the host page's CSS cannot reach in
 * and ours cannot leak out. The widget knows nothing about indexing or
 * retrieval — it calls `onAsk` and renders whatever comes back — which is what
 * keeps the headless API and this UI honest about sharing one engine.
 */
export class Widget {
  #config: WebAIConfig;
  #events: Emitter;
  #host: HTMLElement;
  #root: ShadowRoot;

  #bubble!: HTMLButtonElement;
  #panel!: HTMLElement;
  #status!: HTMLElement;
  #transcript!: HTMLElement;
  #input!: HTMLTextAreaElement;
  #send!: HTMLButtonElement;

  #open = false;
  #busy = false;
  #lastFocused: Element | null = null;

  /** Set by the orchestrator. Returning a rejected promise renders an error turn. */
  onAsk: ((query: string) => Promise<AskResult>) | null = null;
  /** Called the first time the panel opens, so heavy work can start on demand. */
  onFirstOpen: (() => void) | null = null;
  #hasOpened = false;

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
    this.#input.focus();
    this.#events.emit('open', {});

    if (!this.#hasOpened) {
      this.#hasOpened = true;
      this.onFirstOpen?.();
    }
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#panel.hidden = true;
    this.#bubble.hidden = false;
    const target = this.#lastFocused instanceof HTMLElement ? this.#lastFocused : this.#bubble;
    target.focus();
    this.#events.emit('close', {});
  }

  toggle(): void {
    this.#open ? this.close() : this.open();
  }

  /** Single line of state under the title: loading progress, errors, counts. */
  setStatus(text: string): void {
    this.#status.textContent = text;
  }

  async submit(query: string): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length === 0 || this.#busy) return;

    this.#setBusy(true);
    this.#append(userTurn(trimmed));
    const pending = this.#append(pendingTurn());

    try {
      const result = await this.onAsk?.(trimmed);
      pending.replaceWith(result ? answerTurn(result) : errorTurn('The assistant is not ready yet.'));
    } catch (error) {
      pending.replaceWith(
        errorTurn(error instanceof Error ? error.message : 'Something went wrong searching this site.'),
      );
    } finally {
      this.#setBusy(false);
      this.#input.focus();
    }
  }

  #setBusy(busy: boolean): void {
    this.#busy = busy;
    this.#send.disabled = busy;
    this.#input.disabled = busy;
  }

  #append(el: HTMLElement): HTMLElement {
    this.#transcript.append(el);
    this.#transcript.scrollTop = this.#transcript.scrollHeight;
    return el;
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
    this.#panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.close();
      }
    });

    this.#panel.append(this.#header(), this.#body(), this.#composer());
    this.#root.append(style, this.#bubble, this.#panel);
  }

  #header(): HTMLElement {
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
    return header;
  }

  #body(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'body';

    this.#transcript = document.createElement('div');
    this.#transcript.className = 'transcript';
    // Answers arrive asynchronously, so a screen reader needs to be told.
    this.#transcript.setAttribute('aria-live', 'polite');

    const hint = document.createElement('p');
    hint.className = 'placeholder';
    hint.textContent = 'Ask a question and I will answer from this site’s own pages.';
    this.#transcript.append(hint);

    body.append(this.#transcript);
    return body;
  }

  #composer(): HTMLElement {
    const form = document.createElement('form');
    form.className = 'composer';

    this.#input = document.createElement('textarea');
    this.#input.className = 'input';
    this.#input.rows = 1;
    this.#input.placeholder = 'Ask a question…';
    this.#input.setAttribute('aria-label', 'Ask a question about this site');

    this.#input.addEventListener('keydown', (event) => {
      // Enter sends; Shift+Enter is a newline, as everywhere else.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    this.#send = document.createElement('button');
    this.#send.className = 'send';
    this.#send.type = 'submit';
    this.#send.textContent = 'Ask';

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const query = this.#input.value;
      this.#input.value = '';
      void this.submit(query);
    });

    form.append(this.#input, this.#send);
    return form;
  }
}

function icon(): string {
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
  </svg>`;
}
