/**
 * Small bidirectional RPC over `postMessage`.
 *
 * Both directions matter here. The main thread sends commands to the worker
 * (index this, answer that), and the worker calls *back* into the main thread
 * to fetch and extract pages — because workers have no DOM and cannot parse
 * HTML themselves. So this is a symmetric peer rather than a client and a
 * server.
 *
 * Written against the minimum shared surface of `Worker`,
 * `DedicatedWorkerGlobalScope` and `MessagePort`, so the same class runs on
 * both sides and can be tested over a plain `MessageChannel`.
 */

export interface Transport {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export type Handler = (params: never) => unknown;

type Envelope =
  | { w: 'req'; id: number; m: string; p: unknown }
  | { w: 'ok'; id: number; v: unknown }
  | { w: 'err'; id: number; e: { name: string; message: string } }
  | { w: 'evt'; t: string; p: unknown };

/** Model loading can genuinely take a minute on a cold cache. */
export const DEFAULT_TIMEOUT_MS = 120_000;

export class RpcError extends Error {
  override readonly name: string;
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class RpcPeer {
  #transport: Transport;
  #handlers = new Map<string, Handler>();
  #listeners = new Map<string, Set<(payload: never) => void>>();
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #disposed = false;

  #onMessage = (event: MessageEvent): void => {
    void this.#dispatch(event.data as Envelope);
  };

  constructor(transport: Transport) {
    this.#transport = transport;
    this.#transport.addEventListener('message', this.#onMessage);
  }

  /** Register a method this peer answers. */
  handle<P, R>(method: string, fn: (params: P) => R | Promise<R>): void {
    this.#handlers.set(method, fn as Handler);
  }

  /** Call a method on the other side. */
  async call<R>(
    method: string,
    params?: unknown,
    { timeout = DEFAULT_TIMEOUT_MS }: { timeout?: number } = {},
  ): Promise<R> {
    if (this.#disposed) throw new RpcError('RpcDisposed', `rpc disposed, cannot call ${method}`);

    const id = this.#nextId++;
    return new Promise<R>((resolve, reject) => {
      const timer =
        timeout > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(new RpcError('RpcTimeout', `${method} timed out after ${timeout}ms`));
            }, timeout)
          : null;

      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.#post({ w: 'req', id, m: method, p: params });
    });
  }

  /** Fire-and-forget. Used for progress and streaming, where no reply is wanted. */
  notify(type: string, payload?: unknown): void {
    this.#post({ w: 'evt', t: type, p: payload });
  }

  on<P>(type: string, fn: (payload: P) => void): () => void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(fn as (payload: never) => void);
    return () => {
      set.delete(fn as (payload: never) => void);
    };
  }

  /**
   * Reject every in-flight call. Called when the worker dies, so callers get a
   * real error instead of a promise that never settles.
   */
  dispose(reason = 'rpc disposed'): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#transport.removeEventListener('message', this.#onMessage);

    for (const [, pending] of this.#pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new RpcError('RpcDisposed', reason));
    }
    this.#pending.clear();
    this.#handlers.clear();
    this.#listeners.clear();
  }

  async #dispatch(message: Envelope): Promise<void> {
    if (typeof message !== 'object' || message === null || !('w' in message)) return;

    switch (message.w) {
      case 'req': {
        const handler = this.#handlers.get(message.m);
        if (!handler) {
          this.#post({
            w: 'err',
            id: message.id,
            e: { name: 'RpcUnknownMethod', message: `no handler for "${message.m}"` },
          });
          return;
        }
        try {
          const value = await (handler as (p: unknown) => unknown)(message.p);
          this.#post({ w: 'ok', id: message.id, v: value });
        } catch (error) {
          this.#post({ w: 'err', id: message.id, e: describe(error) });
        }
        return;
      }

      case 'ok': {
        const pending = this.#take(message.id);
        pending?.resolve(message.v);
        return;
      }

      case 'err': {
        const pending = this.#take(message.id);
        pending?.reject(new RpcError(message.e.name, message.e.message));
        return;
      }

      case 'evt': {
        for (const fn of [...(this.#listeners.get(message.t) ?? [])]) {
          try {
            (fn as (p: unknown) => void)(message.p);
          } catch {
            // An event listener must not break the message pump.
          }
        }
        return;
      }
    }
  }

  #take(id: number): Pending | undefined {
    const pending = this.#pending.get(id);
    if (!pending) return undefined;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    return pending;
  }

  #post(message: Envelope): void {
    try {
      this.#transport.postMessage(message);
    } catch (error) {
      // Almost always a value that will not structured-clone. Surfacing it
      // against the call is far more useful than a bare DataCloneError.
      if (message.w === 'req') {
        this.#take(message.id)?.reject(
          new RpcError('RpcSerializationError', `could not send "${message.m}": ${describe(error).message}`),
        );
        return;
      }
      throw error;
    }
  }
}

/** Errors do not survive structured cloning with their type intact. */
function describe(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}
