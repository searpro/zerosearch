import type { ZeroSearchEvent, ZeroSearchEventMap, ZeroSearchEventName } from '../types.js';

type Listener<K extends ZeroSearchEventName> = (payload: ZeroSearchEventMap[K]) => void;
type AnyListener = (event: ZeroSearchEvent) => void;

/**
 * Typed event bus.
 *
 * A misbehaving listener must never take the host page down with it, so every
 * dispatch is isolated: a listener that throws is reported and the remaining
 * listeners still run.
 */
export class Emitter {
  #listeners = new Map<ZeroSearchEventName, Set<Listener<ZeroSearchEventName>>>();
  #any = new Set<AnyListener>();
  #onListenerError: (error: unknown) => void;

  constructor(onListenerError: (error: unknown) => void = () => {}) {
    this.#onListenerError = onListenerError;
  }

  on<K extends ZeroSearchEventName>(type: K, fn: Listener<K>): () => void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(fn as Listener<ZeroSearchEventName>);
    return () => this.off(type, fn);
  }

  once<K extends ZeroSearchEventName>(type: K, fn: Listener<K>): () => void {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off<K extends ZeroSearchEventName>(type: K, fn: Listener<K>): void {
    this.#listeners.get(type)?.delete(fn as Listener<ZeroSearchEventName>);
  }

  /** Subscribe to every event. This is what backs the site owner's `onEvent` hook. */
  onAny(fn: AnyListener): () => void {
    this.#any.add(fn);
    return () => {
      this.#any.delete(fn);
    };
  }

  emit<K extends ZeroSearchEventName>(type: K, payload: ZeroSearchEventMap[K]): void {
    // Copy before iterating: listeners are allowed to unsubscribe themselves.
    for (const fn of [...(this.#listeners.get(type) ?? [])]) {
      try {
        (fn as Listener<K>)(payload);
      } catch (error) {
        this.#onListenerError(error);
      }
    }
    if (this.#any.size === 0) return;
    const event = { type, payload } as ZeroSearchEvent;
    for (const fn of [...this.#any]) {
      try {
        fn(event);
      } catch (error) {
        this.#onListenerError(error);
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
    this.#any.clear();
  }
}
