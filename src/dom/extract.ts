import { Readability } from '@mozilla/readability';
import { contentHash } from '../knowledge/hash.js';
import type { Block, ExtractedPage } from '../knowledge/types.js';

/**
 * HTML extraction. Main thread only — workers have no `DOMParser`.
 *
 * Using the browser's own parser rather than bundling a JS one is both smaller
 * and much faster: parsing is native, and a `DOMParser` document has no
 * browsing context, so scripts do not run and subresources are not fetched.
 */

/** Part of the cache key: changing what we extract must invalidate what we stored. */
export const EXTRACTOR_VERSION = 1;

/** Site chrome, stripped before the fallback extractor sees the page. */
const NOISE = [
  'script',
  'style',
  'noscript',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'iframe',
  'svg',
  'template',
  '[aria-hidden="true"]',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
].join(',');

/** Elements that carry a block of readable text. */
const TEXT_BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,dd,dt,td,th';

/** Below this, Readability's answer is treated as a miss and we fall back. */
const MIN_ARTICLE_CHARS = 200;

export interface ExtractMeta {
  etag?: string | null;
  lastModified?: string | null;
  fetchedAt?: number;
}

export function extractFromHtml(html: string, url: string, meta: ExtractMeta = {}): ExtractedPage {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  setBase(doc, url);

  // Read metadata before Readability runs — it mutates the document it is given.
  const jsonLd = readJsonLd(doc);
  const title = pickTitle(doc, jsonLd);
  const description = pickDescription(doc, jsonLd);
  const lang = doc.documentElement.getAttribute('lang')?.trim() || null;
  const category = pickCategory(doc, jsonLd, url);

  const root = readableRoot(doc);
  const blocks = dropRedundantH1(blocksFrom(root), title);
  const text = blocks.map((b) => b.text).join('\n');

  return {
    url,
    title,
    description,
    category,
    blocks,
    text,
    hash: contentHash(EXTRACTOR_VERSION + ' ' + title + ' ' + text),
    lang,
    fetchedAt: meta.fetchedAt ?? Date.now(),
    etag: meta.etag ?? null,
    lastModified: meta.lastModified ?? null,
  };
}

/**
 * Readability first, with a structural fallback when it declines.
 *
 * Readability is tuned for articles and regularly returns nothing useful for
 * landing pages, pricing tables and documentation indexes — which on most
 * sites is exactly the content a visitor asks about.
 */
function readableRoot(doc: Document): Element {
  try {
    // Readability mutates, so give it a copy and keep `doc` for the fallback.
    const clone = doc.cloneNode(true) as Document;
    const article = new Readability<Element>(clone, {
      serializer: (node) => node as Element,
      charThreshold: MIN_ARTICLE_CHARS,
    }).parse();

    const content = article?.content;
    if (content && (article?.length ?? 0) >= MIN_ARTICLE_CHARS) return content;
  } catch {
    // A malformed page must not take the widget down; fall through.
  }
  return structuralRoot(doc);
}

function structuralRoot(doc: Document): Element {
  const scope = doc.querySelector('main') ?? doc.querySelector('article') ?? doc.body;
  const clone = scope.cloneNode(true) as Element;
  for (const noisy of clone.querySelectorAll(NOISE)) noisy.remove();
  return clone;
}

/** Walk to blocks, preserving heading levels and document order. */
function blocksFrom(root: Element): Block[] {
  const blocks: Block[] = [];

  for (const el of root.querySelectorAll(TEXT_BLOCKS)) {
    // A <p> inside an <li> would otherwise be counted twice.
    if (el.parentElement?.closest(TEXT_BLOCKS)) continue;

    const text = normalize(el.textContent ?? '');
    if (text.length === 0) continue;

    const heading = /^h([1-6])$/i.exec(el.tagName);
    if (heading) {
      blocks.push({ type: 'heading', level: Number(heading[1]), text });
    } else {
      blocks.push({ type: 'text', text });
    }
  }

  return blocks;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Drop a leading `<h1>` that merely restates the page title.
 *
 * Readability already removes headings matching the article title, but the
 * structural fallback does not — so without this, the same page yields a
 * different heading path depending on which extractor ran. Those paths become
 * citations, so they need to be stable. Nothing is lost either way: every
 * chunk is prefixed with the page title regardless.
 */
function dropRedundantH1(blocks: Block[], title: string): Block[] {
  const first = blocks[0];
  if (!first || first.type !== 'heading' || first.level !== 1) return blocks;

  const heading = first.text.toLowerCase();
  const pageTitle = title.toLowerCase();
  return pageTitle.includes(heading) ? blocks.slice(1) : blocks;
}

/** Relative links and Readability's own URL handling both need this. */
function setBase(doc: Document, url: string): void {
  const head = doc.head ?? doc.documentElement;
  const existing = head.querySelector('base');
  if (existing) {
    if (!existing.getAttribute('href')) existing.setAttribute('href', url);
    return;
  }
  const base = doc.createElement('base');
  base.setAttribute('href', url);
  head.insertBefore(base, head.firstChild);
}

type JsonLd = Record<string, unknown>;

function readJsonLd(doc: Document): JsonLd[] {
  const out: JsonLd[] = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed: unknown = JSON.parse(script.textContent ?? '');
      // A page may ship a single object, an array, or an @graph wrapper.
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (typeof item !== 'object' || item === null) continue;
        out.push(item as JsonLd);
        const graph = (item as { '@graph'?: unknown })['@graph'];
        if (Array.isArray(graph)) {
          for (const node of graph) {
            if (typeof node === 'object' && node !== null) out.push(node as JsonLd);
          }
        }
      }
    } catch {
      // Invalid JSON-LD is common in the wild and is simply not a source.
    }
  }
  return out;
}

function meta(doc: Document, selector: string): string | null {
  return doc.querySelector(selector)?.getAttribute('content')?.trim() || null;
}

function pickTitle(doc: Document, jsonLd: JsonLd[]): string {
  return (
    meta(doc, 'meta[property="og:title"]') ??
    doc.querySelector('title')?.textContent?.trim() ??
    firstString(jsonLd, ['headline', 'name']) ??
    doc.querySelector('h1')?.textContent?.trim() ??
    'Untitled'
  );
}

function pickDescription(doc: Document, jsonLd: JsonLd[]): string | null {
  return (
    meta(doc, 'meta[name="description"]') ??
    meta(doc, 'meta[property="og:description"]') ??
    firstString(jsonLd, ['description'])
  );
}

/**
 * Category from the page's own structure, never from a model: a JSON-LD
 * breadcrumb trail, then a breadcrumb nav, then the URL's first path segment.
 */
function pickCategory(doc: Document, jsonLd: JsonLd[], url: string): string | null {
  const breadcrumbList = jsonLd.find((n) => n['@type'] === 'BreadcrumbList');
  const items = breadcrumbList?.['itemListElement'];
  if (Array.isArray(items) && items.length > 1) {
    const parent = items[items.length - 2] as { name?: unknown; item?: { name?: unknown } };
    const name = typeof parent?.name === 'string' ? parent.name : parent?.item?.name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }

  const nav = doc.querySelector('[aria-label*="readcrumb"], .breadcrumbs, .breadcrumb');
  if (nav) {
    const crumbs = [...nav.querySelectorAll('li, a')]
      .map((el) => normalize(el.textContent ?? ''))
      .filter((t) => t.length > 0);
    const parent = crumbs[crumbs.length - 2];
    if (parent) return parent;
  }

  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean)[0];
    if (segment && !/\.[a-z0-9]+$/i.test(segment)) {
      return segment.charAt(0).toUpperCase() + segment.slice(1);
    }
  } catch {
    // Not a usable URL; no category.
  }
  return null;
}

function firstString(nodes: JsonLd[], keys: string[]): string | null {
  for (const node of nodes) {
    for (const key of keys) {
      const value = node[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return null;
}
