/**
 * Idle scheduling.
 *
 * Indexing happens while a real person is using the page. Every fetch, parse
 * and hand-off is therefore queued behind the browser's own work, so the host
 * page never pays for our crawl in dropped frames.
 */

interface IdleDeadline {
  timeRemaining(): number;
  readonly didTimeout: boolean;
}

type IdleCallback = (deadline: IdleDeadline) => void;

interface IdleCapableWindow {
  requestIdleCallback?: (cb: IdleCallback, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

/**
 * Resolves when the browser is idle, or after `timeout` regardless.
 *
 * Safari lacked `requestIdleCallback` for years, so the fallback is not
 * hypothetical — without it, indexing would simply never start there.
 */
export function whenIdle(timeout = 1000): Promise<void> {
  const scope = globalThis as unknown as IdleCapableWindow;
  if (typeof scope.requestIdleCallback === 'function') {
    return new Promise((resolve) => {
      scope.requestIdleCallback!(() => resolve(), { timeout });
    });
  }
  // Not equivalent, but it yields the main thread, which is the point.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Yield to the event loop so a long synchronous batch cannot block input. */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
