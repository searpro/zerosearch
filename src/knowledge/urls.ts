/**
 * What a URL alone tells us about a page.
 *
 * Pure string work, deliberately: this is the entire routing signal for a page
 * that has not been fetched yet, and both the worker and the main thread need
 * it. Keeping it out of `dom/` is what lets the worker — which has no DOM and
 * compiles without the DOM lib — file an off-sitemap page correctly.
 */

/**
 * What we can know about a page without fetching it: a readable title from the
 * slug, and the path segments that become the category tree. This is the whole
 * routing manifest for a lazily-crawled site — cheap enough to build for every
 * URL in a sitemap, and good enough to decide which pages are worth fetching.
 */
export function describeUrl(url: string): { slugTitle: string; segments: string[] } {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }

  const parts = path.split('/').filter((p) => p.length > 0);
  const last = parts[parts.length - 1] ?? '';
  const stem = last.replace(/\.[a-z0-9]+$/i, '');

  // `/docs/index.html` is really "Docs", not "Index".
  const isIndex = stem === '' || stem.toLowerCase() === 'index';
  const titleSource = isIndex ? (parts[parts.length - 2] ?? 'Home') : stem;
  const segments = isIndex ? parts.slice(0, -1) : parts.slice(0, -1);

  return { slugTitle: humanize(titleSource), segments };
}

function humanize(slug: string): string {
  const words = slug
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[-_\s]+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return 'Home';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * The URL a page should be indexed under.
 *
 * `location.href` is not it. A visitor arriving from a campaign link carries
 * `?utm_source=...`, and one following an in-page anchor carries `#section`;
 * indexed raw, each becomes a separate page, a separate crawl, and a duplicate
 * routing entry whose path segments no longer match its siblings. A declared
 * canonical is the site's own answer to "which URL is this page", so it wins;
 * failing that, dropping the fragment is safe, since a fragment never
 * identifies a different document.
 *
 * The query string is left alone otherwise: plenty of sites really do serve
 * distinct pages from `?id=`, and we cannot tell those from tracking noise.
 */
export function canonicalUrl(href: string, declared?: string | null): string {
  const resolved = declared ? absolute(declared, href) : null;
  const chosen = resolved ?? href;

  try {
    const url = new URL(chosen);
    url.hash = '';
    return url.href;
  } catch {
    return chosen;
  }
}

function absolute(url: string, base: string): string | null {
  try {
    const resolved = new URL(url, base);
    // Cross-origin canonicals exist and are none of our business to crawl.
    return resolved.origin === new URL(base).origin ? resolved.href : null;
  } catch {
    return null;
  }
}
