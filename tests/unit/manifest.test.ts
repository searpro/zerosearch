import { describe, expect, it } from 'vitest';
import { describeUrl, parseSitemap } from '../../src/dom/manifest.js';
import { canonicalUrl } from '../../src/knowledge/urls.js';
import { isAllowed, parseRobots } from '../../src/knowledge/robots.js';

const BASE = 'https://example.com/sitemap.xml';

const urlset = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
   <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;

describe('parseSitemap', () => {
  it('reads loc, lastmod and priority', () => {
    const { urls } = parseSitemap(
      urlset(`
        <url><loc>https://example.com/pricing.html</loc><lastmod>2026-08-29</lastmod><priority>0.6</priority></url>
        <url><loc>https://example.com/docs/api.html</loc></url>`),
      BASE,
    );

    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatchObject({
      url: 'https://example.com/pricing.html',
      lastmod: '2026-08-29',
      priority: 0.6,
      slugTitle: 'Pricing',
    });
    expect(urls[1]).toMatchObject({ lastmod: null, priority: null });
  });

  it('reads a sitemap index without treating it as pages', () => {
    const { urls, sitemaps } = parseSitemap(
      `<?xml version="1.0"?>
       <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
         <sitemap><loc>https://example.com/sitemap-docs.xml</loc></sitemap>
         <sitemap><loc>/sitemap-blog.xml</loc></sitemap>
       </sitemapindex>`,
      BASE,
    );

    expect(urls).toEqual([]);
    expect(sitemaps).toEqual([
      'https://example.com/sitemap-docs.xml',
      'https://example.com/sitemap-blog.xml',
    ]);
  });

  it('works whatever namespace prefix the generator used', () => {
    const { urls } = parseSitemap(
      `<?xml version="1.0"?>
       <sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
         <sm:url><sm:loc>https://example.com/a.html</sm:loc></sm:url>
       </sm:urlset>`,
      BASE,
    );
    expect(urls.map((u) => u.url)).toEqual(['https://example.com/a.html']);
  });

  it('resolves relative locs and drops non-http schemes', () => {
    const { urls } = parseSitemap(
      urlset(`
        <url><loc>/docs/limits.html</loc></url>
        <url><loc>javascript:alert(1)</loc></url>
        <url><loc>ftp://example.com/x</loc></url>`),
      BASE,
    );
    expect(urls.map((u) => u.url)).toEqual(['https://example.com/docs/limits.html']);
  });

  it('deduplicates repeated locs', () => {
    const { urls } = parseSitemap(
      urlset(`
        <url><loc>https://example.com/a.html</loc></url>
        <url><loc>https://example.com/a.html</loc></url>`),
      BASE,
    );
    expect(urls).toHaveLength(1);
  });

  it('decodes entities and CDATA, which is why this uses a real XML parser', () => {
    const { urls } = parseSitemap(
      urlset(`<url><loc>https://example.com/search?a=1&amp;b=2</loc></url>`),
      BASE,
    );
    expect(urls[0]!.url).toBe('https://example.com/search?a=1&b=2');
  });

  it('throws on malformed XML rather than returning silent nonsense', () => {
    expect(() => parseSitemap('<urlset><url><loc>unclosed', BASE)).toThrow(/well-formed/);
  });

  it('returns nothing for an empty urlset', () => {
    expect(parseSitemap(urlset(''), BASE)).toEqual({ urls: [], sitemaps: [] });
  });
});

describe('describeUrl', () => {
  it('humanises a slug into a title', () => {
    expect(describeUrl('https://example.com/docs/quickstart.html').slugTitle).toBe('Quickstart');
    expect(describeUrl('https://example.com/blog/why-columnar.html').slugTitle).toBe('Why Columnar');
    expect(describeUrl('https://example.com/some_page_here').slugTitle).toBe('Some Page Here');
  });

  it('names an index page after its directory, not "Index"', () => {
    expect(describeUrl('https://example.com/docs/index.html').slugTitle).toBe('Docs');
    expect(describeUrl('https://example.com/docs/').slugTitle).toBe('Docs');
    expect(describeUrl('https://example.com/').slugTitle).toBe('Home');
  });

  it('exposes path segments for the category tree', () => {
    expect(describeUrl('https://example.com/docs/api.html').segments).toEqual(['docs']);
    expect(describeUrl('https://example.com/a/b/c.html').segments).toEqual(['a', 'b']);
    expect(describeUrl('https://example.com/top.html').segments).toEqual([]);
  });
});

describe('robots.txt', () => {
  it('allows everything when there are no rules', () => {
    expect(isAllowed(parseRobots(''), '/anything')).toBe(true);
    expect(isAllowed(parseRobots('User-agent: *\nDisallow:'), '/anything')).toBe(true);
  });

  it('honours a Disallow prefix', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /private/');
    expect(isAllowed(robots, '/private/secret.html')).toBe(false);
    expect(isAllowed(robots, '/public/page.html')).toBe(true);
  });

  it('lets the longest matching pattern win', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /docs/\nAllow: /docs/public/');
    expect(isAllowed(robots, '/docs/internal.html')).toBe(false);
    expect(isAllowed(robots, '/docs/public/guide.html')).toBe(true);
  });

  it('gives Allow the tie-break at equal specificity', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /x\nAllow: /x');
    expect(isAllowed(robots, '/x/page')).toBe(true);
  });

  it('supports * wildcards and $ anchors', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/private');
    expect(isAllowed(robots, '/manual.pdf')).toBe(false);
    expect(isAllowed(robots, '/manual.pdf.html')).toBe(true);
    expect(isAllowed(robots, '/a/b/private')).toBe(false);
  });

  it('prefers a group naming us over the wildcard group', () => {
    const robots = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: zerosearch\nDisallow: /admin/',
    );
    expect(isAllowed(robots, '/anything')).toBe(true);
    expect(isAllowed(robots, '/admin/x')).toBe(false);
  });

  it('applies consecutive User-agent lines to one shared rule block', () => {
    const robots = parseRobots('User-agent: googlebot\nUser-agent: zerosearch\nDisallow: /nope/');
    expect(isAllowed(robots, '/nope/x')).toBe(false);
    expect(isAllowed(robots, '/yes/x')).toBe(true);
  });

  it('collects Sitemap declarations, which are global rather than per-group', () => {
    const robots = parseRobots(
      '# comment\nSitemap: https://example.com/sitemap.xml\nUser-agent: *\nDisallow: /x',
    );
    expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('ignores comments and blank lines', () => {
    const robots = parseRobots('  # all comment\n\nUser-agent: *   # trailing\nDisallow: /p  # here');
    expect(isAllowed(robots, '/p/x')).toBe(false);
  });

  it('does not let a regex metacharacter in a pattern escape into the matcher', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /a+b(c)');
    expect(isAllowed(robots, '/a+b(c)/x')).toBe(false);
    expect(isAllowed(robots, '/aaab')).toBe(true);
  });
});

describe('canonicalUrl', () => {
  it('drops a fragment, which never identifies a different page', () => {
    expect(canonicalUrl('https://m.example/docs/api.html#errors')).toBe(
      'https://m.example/docs/api.html',
    );
  });

  it('prefers the canonical the page declares', () => {
    // A visitor from a campaign link would otherwise be indexed as a page of
    // their own — a duplicate crawl and a routing entry that matches nothing.
    expect(
      canonicalUrl('https://m.example/pricing.html?utm_source=news', '/pricing.html'),
    ).toBe('https://m.example/pricing.html');
  });

  it('keeps a query string when the page does not declare a canonical', () => {
    // `?id=` really is a distinct page on plenty of sites, and we cannot tell
    // that apart from tracking noise without being told.
    expect(canonicalUrl('https://m.example/item?id=7')).toBe('https://m.example/item?id=7');
  });

  it('ignores a cross-origin canonical rather than crawling somewhere else', () => {
    expect(canonicalUrl('https://m.example/a.html', 'https://elsewhere.example/a.html')).toBe(
      'https://m.example/a.html',
    );
  });

  it('falls back to the URL it was given when either is unparseable', () => {
    expect(canonicalUrl('not a url', 'also not')).toBe('not a url');
  });
});
