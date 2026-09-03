import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError, RpcPeer, type Transport } from '../../src/engine/rpc.js';

/**
 * A MessageChannel is the honest test rig here: it is the same structured-clone
 * boundary a real Worker imposes, so anything that would not survive the trip
 * fails here too.
 */
function pair(): { a: RpcPeer; b: RpcPeer; dispose: () => void } {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();

  const a = new RpcPeer(channel.port1 as unknown as Transport);
  const b = new RpcPeer(channel.port2 as unknown as Transport);

  return {
    a,
    b,
    dispose: () => {
      a.dispose();
      b.dispose();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

let open: (() => void) | null = null;
afterEach(() => {
  open?.();
  open = null;
  vi.useRealTimers();
});

const rig = () => {
  const p = pair();
  open = p.dispose;
  return p;
};

describe('RpcPeer', () => {
  it('calls a method and resolves with its return value', async () => {
    const { a, b } = rig();
    b.handle<{ x: number }, number>('double', ({ x }) => x * 2);

    await expect(a.call('double', { x: 21 })).resolves.toBe(42);
  });

  it('awaits an async handler', async () => {
    const { a, b } = rig();
    b.handle('slow', async () => {
      await Promise.resolve();
      return 'done';
    });

    await expect(a.call('slow')).resolves.toBe('done');
  });

  it('works in both directions on one channel', async () => {
    const { a, b } = rig();
    // This is the shape the real system uses: the worker calls back into the
    // main thread for page fetches, because it has no DOM of its own.
    a.handle<string, string>('fetchPage', (url) => `<html>${url}</html>`);
    b.handle<number, number>('embed', (n) => n + 1);

    await expect(b.call('fetchPage', '/a')).resolves.toBe('<html>/a</html>');
    await expect(a.call('embed', 1)).resolves.toBe(2);
  });

  it('propagates a handler error with its name and message', async () => {
    const { a, b } = rig();
    b.handle('boom', () => {
      throw new TypeError('bad input');
    });

    await expect(a.call('boom')).rejects.toMatchObject({
      name: 'TypeError',
      message: 'bad input',
    });
  });

  it('rejects a call to an unregistered method', async () => {
    const { a } = rig();
    await expect(a.call('nope')).rejects.toMatchObject({ name: 'RpcUnknownMethod' });
  });

  it('keeps concurrent calls distinct', async () => {
    const { a, b } = rig();
    b.handle<number, number>('identity', (n) => n);

    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => a.call<number>('identity', n)));
    expect(results).toEqual([1, 2, 3, 4, 5]);
  });

  it('resolves out-of-order replies to the right callers', async () => {
    const { a, b } = rig();
    const gate = new Map<number, () => void>();
    b.handle<number, number>('gated', (n) => new Promise((resolve) => gate.set(n, () => resolve(n))));

    const first = a.call<number>('gated', 1);
    const second = a.call<number>('gated', 2);
    await vi.waitFor(() => expect(gate.size).toBe(2));

    // Answer the second call first.
    gate.get(2)!();
    gate.get(1)!();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
  });

  it('times out rather than hanging when no reply arrives', async () => {
    const { a, b } = rig();
    b.handle('blackhole', () => new Promise(() => {}));

    await expect(a.call('blackhole', null, { timeout: 20 })).rejects.toMatchObject({
      name: 'RpcTimeout',
    });
  });

  it('does not fire a timeout for a call that already resolved', async () => {
    const { a, b } = rig();
    b.handle('quick', () => 'ok');

    await expect(a.call('quick', null, { timeout: 50 })).resolves.toBe('ok');
    // If the timer were still armed it would reject an already-settled promise
    // and surface as an unhandled rejection.
    await new Promise((r) => setTimeout(r, 80));
  });

  it('delivers fire-and-forget events without a reply', async () => {
    const { a, b } = rig();
    const seen: unknown[] = [];
    a.on('progress', (p) => seen.push(p));

    b.notify('progress', { done: 1, total: 10 });
    b.notify('progress', { done: 2, total: 10 });

    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]).toEqual({ done: 2, total: 10 });
  });

  it('unsubscribes an event listener', async () => {
    const { a, b } = rig();
    const fn = vi.fn();
    const off = a.on('tick', fn);
    off();

    b.notify('tick', 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(fn).not.toHaveBeenCalled();
  });

  it('survives a listener that throws', async () => {
    const { a, b } = rig();
    const after = vi.fn();
    a.on('tick', () => {
      throw new Error('listener blew up');
    });
    a.on('tick', after);

    b.notify('tick', 1);
    await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(1));
  });

  it('rejects in-flight calls when disposed, instead of hanging forever', async () => {
    const { a, b } = rig();
    b.handle('blackhole', () => new Promise(() => {}));

    const call = a.call('blackhole');
    a.dispose('worker died');

    await expect(call).rejects.toMatchObject({ name: 'RpcDisposed' });
  });

  it('refuses new calls after disposal', async () => {
    const { a } = rig();
    a.dispose();
    await expect(a.call('anything')).rejects.toMatchObject({ name: 'RpcDisposed' });
  });

  it('reports an unclonable payload against the call that sent it', async () => {
    const { a, b } = rig();
    b.handle('accept', () => 'ok');

    // Functions do not survive structured cloning. Without special handling
    // this throws synchronously out of `call` rather than rejecting it.
    await expect(a.call('accept', { fn: () => {} })).rejects.toMatchObject({
      name: 'RpcSerializationError',
    });
  });

  it('ignores foreign messages sharing the channel', async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const peer = new RpcPeer(channel.port1 as unknown as Transport);

    expect(() => channel.port2.postMessage({ hello: 'world' })).not.toThrow();
    expect(() => channel.port2.postMessage(null)).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));

    peer.dispose();
    channel.port1.close();
    channel.port2.close();
  });

  it('transfers a Float32Array intact, since embeddings travel this way', async () => {
    const { a, b } = rig();
    b.handle<Float32Array, number>('sum', (v) => v.reduce((acc, n) => acc + n, 0));

    const vector = Float32Array.from([0.5, 0.25, 0.25]);
    await expect(a.call('sum', vector)).resolves.toBeCloseTo(1, 6);
  });
});
