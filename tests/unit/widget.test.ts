import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { Emitter } from '../../src/engine/events.js';
import { Widget } from '../../src/ui/widget.js';

function make(overrides = {}) {
  const events = new Emitter();
  const widget = new Widget({ ...DEFAULT_CONFIG, ...overrides }, events);
  widget.mount();
  return { widget, events, root: widget.element.shadowRoot! };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Widget', () => {
  it('mounts into a shadow root so host CSS cannot reach it', () => {
    const { widget, root } = make();
    expect(document.body.contains(widget.element)).toBe(true);
    expect(root).toBeTruthy();
    expect(root.querySelector('.bubble')).toBeTruthy();
    expect(root.querySelector('style')?.textContent).toContain('--wa-accent');
  });

  it('starts closed with the panel hidden', () => {
    const { widget, root } = make();
    expect(widget.isOpen).toBe(false);
    expect(root.querySelector<HTMLElement>('.panel')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('.bubble')!.hidden).toBe(false);
  });

  it('swaps bubble for panel on open and emits', () => {
    const { widget, events, root } = make();
    const onOpen = vi.fn();
    events.on('open', onOpen);

    root.querySelector<HTMLButtonElement>('.bubble')!.click();

    expect(widget.isOpen).toBe(true);
    expect(root.querySelector<HTMLElement>('.panel')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('.bubble')!.hidden).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('closes on the close button and emits', () => {
    const { widget, events, root } = make();
    const onClose = vi.fn();
    events.on('close', onClose);

    widget.open();
    root.querySelector<HTMLButtonElement>('.close')!.click();

    expect(widget.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const { widget, root } = make();
    widget.open();

    root
      .querySelector('.panel')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(widget.isOpen).toBe(false);
  });

  it('does not emit twice when already in the target state', () => {
    const { widget, events } = make();
    const onOpen = vi.fn();
    events.on('open', onOpen);

    widget.open();
    widget.open();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const { widget } = make();
    widget.open();
    widget.close();

    expect(document.activeElement).toBe(opener);
  });

  it('honours position and accent in the emitted stylesheet', () => {
    const { root } = make({ position: 'bottom-left', accent: '#ff0000' });
    const css = root.querySelector('style')!.textContent!;
    expect(css).toContain('left: 20px;');
    expect(css).toContain('#ff0000');
  });

  it('falls back rather than letting a hostile accent reach the stylesheet', () => {
    const accentOf = (accent: string) => {
      const { root } = make({ accent });
      return /--wa-accent:\s*([^;]*);/.exec(root.querySelector('style')!.textContent!)?.[1];
    };

    // Declaration break-out, and the url() exfiltration channel a blocklist would miss.
    expect(accentOf('red; } :host { display: none')).toBe('#4f46e5');
    expect(accentOf('url(https://tracker.example/pixel.png)')).toBe('#4f46e5');
    expect(accentOf('rgb(255,0,0); background-image: url(https://x.example/p)')).toBe('#4f46e5');
  });

  it('passes real colours through untouched', () => {
    const accentOf = (accent: string) => {
      const { root } = make({ accent });
      return /--wa-accent:\s*([^;]*);/.exec(root.querySelector('style')!.textContent!)?.[1];
    };

    expect(accentOf('#ff0000')).toBe('#ff0000');
    expect(accentOf('#f00')).toBe('#f00');
    expect(accentOf('rgb(255, 0, 0)')).toBe('rgb(255, 0, 0)');
    expect(accentOf('rebeccapurple')).toBe('rebeccapurple');
  });

  it('destroy() detaches from the document', () => {
    const { widget } = make();
    widget.destroy();
    expect(document.body.contains(widget.element)).toBe(false);
  });
});
