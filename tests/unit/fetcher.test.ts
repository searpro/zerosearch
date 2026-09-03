import { describe, expect, it, vi } from 'vitest';
import { PoliteFetcher, SkippedError } from '../../src/dom/fetcher.js';
import { parseRobots } from '../../src/knowledge/robots.js';

const ORIGIN = 'https://meridian.example';

interface StubResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

/** Records every request so politeness and header behaviour can be asserted. */
function stubFetch(routes: Record<string, StubResponse | (() => StubResponse)>) {
  const calls: { url: string; headers: Record<string, string>; at: number }[] = [];

  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {})) as Record<string, string>;
    calls.push({ url, headers, at: Date.now() });

    const route = routes[new URL(url).pathname] ?? routes[url];
    const spec = typeof route === 'function' ? route() : route;
    if (!spec) return new Response('not found', { status: 404 });

    return new Response(spec.status === 304 ? null : (spec.body ?? ''), {
      status: spec.status ?? 200,
      headers: { 'content-type': 'text/html', ...spec.headers },
    });
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

const make = (routes: Parameters<typeof stubFetch>[0], options = {}) => {
  const { impl, calls } = stubFetch(routes);
  const fetcher = new PoliteFetcher({ origin: ORIGIN, delayMs: 0, fetchImpl: impl, ...options });
  return { fetcher, calls, impl };
};

describe('PoliteFetcher, containment', () => {
  it('refuses a cross-origin URL', async () => {
    const { fetcher, calls } = make({});
    await expect(fetcher.fetchPage('https://evil.example/x.html')).rejects.toMatchObject({
      name: 'SkippedError',
      reason: 'cross-origin',
    });
    // The point is that nothing went out at all.
    expect(calls).toEqual([]);
  });

  it('honours a robots.txt Disallow', async () => {
    const { fetcher, calls } = make({ '/private/x.html': { body: '<p>secret</p>' } });
    fetcher.setRobots(parseRobots('User-agent: *\nDisallow: /private/'));

    await expect(fetcher.fetchPage(`${ORIGIN}/private/x.html`)).rejects.toMatchObject({
      reason: 'robots',
    });
    expect(calls).toEqual([]);
    expect(fetcher.allows(`${ORIGIN}/public/x.html`)).toBe(true);
  });

  it('rejects a response that is not HTML', async () => {
    const { fetcher } = make({
      '/data.json': { body: '{}', headers: { 'content-type': 'application/json' } },
    });
    await expect(fetcher.fetchPage(`${ORIGIN}/data.json`)).rejects.toMatchObject({ reason: 'not-html' });
  });

  it('refuses a body that declares itself oversized', async () => {
    const { fetcher } = make(
      { '/huge.html': { body: 'x', headers: { 'content-length': String(50 * 1024 * 1024) } } },
      { maxBytes: 1024 },
    );
    await expect(fetcher.fetchPage(`${ORIGIN}/huge.html`)).rejects.toMatchObject({ reason: 'too-large' });
  });

  it('stops reading a body that exceeds the ceiling without declaring it', async () => {
    const { fetcher } = make({ '/huge.html': { body: 'x'.repeat(5000) } }, { maxBytes: 1000 });
    await expect(fetcher.fetchPage(`${ORIGIN}/huge.html`)).rejects.toMatchObject({ reason: 'too-large' });
  });

  it('rejects a malformed URL rather than throwing out of allows()', () => {
    const { fetcher } = make({});
    expect(fetcher.allows('not a url')).toBe(false);
  });
});

describe('PoliteFetcher, privacy', () => {
  it('sends no credentials, so a logged-in view never reaches the index', async () => {
    const { fetcher, impl } = make({ '/a.html': { body: '<p>hi</p>' } });
    await fetcher.fetchPage(`${ORIGIN}/a.html`);

    const init = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(init.credentials).toBe('omit');
    expect(init.mode).toBe('same-origin');
  });
});

describe('PoliteFetcher, conditional GET', () => {
  it('sends stored validators', async () => {
    const { fetcher, calls } = make({ '/a.html': { status: 304 } });
    await fetcher.fetchPage(`${ORIGIN}/a.html`, { etag: 'W/"abc"', lastModified: 'Mon, 01 Jan 2026 00:00:00 GMT' });

    expect(calls[0]!.headers['If-None-Match']).toBe('W/"abc"');
    expect(calls[0]!.headers['If-Modified-Since']).toBe('Mon, 01 Jan 2026 00:00:00 GMT');
  });

  it('reports 304 as notModified and keeps the previous validators', async () => {
    const { fetcher } = make({ '/a.html': { status: 304 } });
    const result = await fetcher.fetchPage(`${ORIGIN}/a.html`, { etag: 'W/"abc"' });

    expect(result).toMatchObject({ status: 304, notModified: true, html: null, etag: 'W/"abc"' });
  });

  it('returns fresh content and new validators on 200', async () => {
    const { fetcher } = make({
      '/a.html': { body: '<p>fresh</p>', headers: { etag: 'W/"new"', 'last-modified': 'Tue, 02 Jan 2026 00:00:00 GMT' } },
    });
    const result = await fetcher.fetchPage(`${ORIGIN}/a.html`);

    expect(result.notModified).toBe(false);
    expect(result.html).toContain('fresh');
    expect(result.etag).toBe('W/"new"');
    expect(result.lastModified).toBe('Tue, 02 Jan 2026 00:00:00 GMT');
  });

  it('reports an error status without throwing, so one dead link is not fatal', async () => {
    const { fetcher } = make({});
    const result = await fetcher.fetchPage(`${ORIGIN}/missing.html`);
    expect(result).toMatchObject({ status: 404, html: null });
  });
});

describe('PoliteFetcher, politeness', () => {
  it('caps concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const impl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return new Response('<p>x</p>', { headers: { 'content-type': 'text/html' } });
    });

    const fetcher = new PoliteFetcher({
      origin: ORIGIN,
      concurrency: 2,
      delayMs: 0,
      fetchImpl: impl as unknown as typeof fetch,
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, i) => fetcher.fetchPage(`${ORIGIN}/p${i}.html`)),
    );

    expect(peak).toBeLessThanOrEqual(2);
    expect(impl).toHaveBeenCalledTimes(8);
  });

  it('spaces requests apart', async () => {
    const { fetcher, calls } = make(
      Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`/p${i}.html`, { body: '<p>x</p>' }])),
      { concurrency: 1, delayMs: 25 },
    );

    const started = Date.now();
    for (let i = 0; i < 4; i += 1) await fetcher.fetchPage(`${ORIGIN}/p${i}.html`);

    expect(calls).toHaveLength(4);
    // Three gaps of at least 25ms between four sequential requests.
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it('releases its slot when a request fails, rather than deadlocking the queue', async () => {
    let call = 0;
    const impl = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('network down');
      return new Response('<p>ok</p>', { headers: { 'content-type': 'text/html' } });
    });

    const fetcher = new PoliteFetcher({
      origin: ORIGIN,
      concurrency: 1,
      delayMs: 0,
      fetchImpl: impl as unknown as typeof fetch,
    });

    await expect(fetcher.fetchPage(`${ORIGIN}/a.html`)).rejects.toThrow('network down');
    // If the slot leaked, this would hang instead of resolving.
    await expect(fetcher.fetchPage(`${ORIGIN}/b.html`)).resolves.toMatchObject({ status: 200 });
  });
});

describe('PoliteFetcher, fetchText', () => {
  it('returns text for robots.txt and sitemaps', async () => {
    const { fetcher } = make({
      '/robots.txt': { body: 'User-agent: *\nDisallow:', headers: { 'content-type': 'text/plain' } },
    });
    expect(await fetcher.fetchText(`${ORIGIN}/robots.txt`)).toContain('User-agent');
  });

  it('returns null rather than throwing when the file is absent', async () => {
    const { fetcher } = make({});
    // A site with no robots.txt or no sitemap is normal, not an error.
    expect(await fetcher.fetchText(`${ORIGIN}/robots.txt`)).toBeNull();
  });

  it('returns null on a network failure', async () => {
    const impl = vi.fn(async () => {
      throw new Error('offline');
    });
    const fetcher = new PoliteFetcher({ origin: ORIGIN, fetchImpl: impl as unknown as typeof fetch });
    expect(await fetcher.fetchText(`${ORIGIN}/sitemap.xml`)).toBeNull();
  });
});

describe('SkippedError', () => {
  it('carries a machine-readable reason', () => {
    const error = new SkippedError('robots', 'nope');
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe('robots');
    expect(error.name).toBe('SkippedError');
  });
});
