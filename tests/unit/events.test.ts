import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../src/engine/events.js';

describe('Emitter', () => {
  it('delivers a payload to subscribers of that type only', () => {
    const bus = new Emitter();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    bus.on('open', onOpen);
    bus.on('close', onClose);

    bus.emit('open', {});
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns an unsubscribe function from on()', () => {
    const bus = new Emitter();
    const fn = vi.fn();
    const off = bus.on('open', fn);
    off();
    bus.emit('open', {});
    expect(fn).not.toHaveBeenCalled();
  });

  it('once() fires exactly once', () => {
    const bus = new Emitter();
    const fn = vi.fn();
    bus.once('open', fn);
    bus.emit('open', {});
    bus.emit('open', {});
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('onAny receives every event as {type, payload}', () => {
    const bus = new Emitter();
    const seen: string[] = [];
    bus.onAny((event) => seen.push(event.type));

    bus.emit('open', {});
    bus.emit('ready', { tier: 'retrieval' });
    expect(seen).toEqual(['open', 'ready']);
  });

  it('isolates a throwing listener so the rest still run', () => {
    const onError = vi.fn();
    const bus = new Emitter(onError);
    const after = vi.fn();

    bus.on('open', () => {
      throw new Error('listener blew up');
    });
    bus.on('open', after);

    expect(() => bus.emit('open', {})).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('tolerates a listener unsubscribing itself mid-dispatch', () => {
    const bus = new Emitter();
    const second = vi.fn();
    const off = bus.on('open', () => off());
    bus.on('open', second);

    expect(() => bus.emit('open', {})).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clear() removes typed and wildcard listeners alike', () => {
    const bus = new Emitter();
    const typed = vi.fn();
    const any = vi.fn();
    bus.on('open', typed);
    bus.onAny(any);
    bus.clear();

    bus.emit('open', {});
    expect(typed).not.toHaveBeenCalled();
    expect(any).not.toHaveBeenCalled();
  });
});
