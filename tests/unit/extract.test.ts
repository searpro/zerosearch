import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractFromHtml } from '../../src/dom/extract.js';

const DEMO = join(dirname(fileURLToPath(import.meta.url)), '../../demo');

/**
 * Extraction is tested against the generated demo site rather than synthetic
 * fixtures, because the whole job is surviving real markup: site nav, a
 * footer, a promo aside, JSON-LD, breadcrumbs, and inline styles.
 */
const demoPage = (path: string) => {
  const html = readFileSync(join(DEMO, path), 'utf8');
  return extractFromHtml(html, `https://meridian.example/${path}`);
};

describe('extractFromHtml, against the demo site', () => {
  it('takes the title and description from metadata', () => {
    const page = demoPage('pricing.html');
    expect(page.title).toBe('Pricing — Meridian');
    expect(page.description).toContain('Meridian pricing');
    expect(page.lang).toBe('en');
  });

  it('keeps the real content', () => {
    const page = demoPage('pricing.html');
    expect(page.text).toContain('$49 per month');
    expect(page.text).toContain('400 days of retention');
    expect(page.text).toContain('Annual billing takes 15% off');
  });

  it('strips the site chrome around it', () => {
    const page = demoPage('pricing.html');
    // Footer boilerplate, present on every page, would otherwise dominate
    // retrieval by sheer repetition.
    expect(page.text).not.toContain('All rights reserved');
    expect(page.text).not.toContain('Registered in Ireland');
    // The promo aside is not an answer to anything.
    expect(page.text).not.toContain('no credit card required');
  });

  it('never leaks JSON-LD or stylesheet source into the text', () => {
    const page = demoPage('pricing.html');
    expect(page.text).not.toContain('@context');
    expect(page.text).not.toContain('schema.org');
    expect(page.text).not.toContain('font-family');
  });

  it('preserves the section headings', () => {
    const page = demoPage('pricing.html');
    const headings = page.blocks.filter((b) => b.type === 'heading').map((b) => b.text);

    expect(headings).toContain('Free');
    expect(headings).toContain('Team');
    expect(headings).toContain('Enterprise');
    expect(page.blocks.find((b) => b.type === 'heading')?.level).toBe(2);
  });

  it('drops an h1 that only restates the title, whichever extractor ran', () => {
    // Readability removes a title-matching heading and the structural fallback
    // does not, so the two paths would otherwise disagree about heading depth —
    // and heading paths are what citations show the reader.
    const headings = demoPage('pricing.html')
      .blocks.filter((b) => b.type === 'heading')
      .map((b) => b.text);
    expect(headings).not.toContain('Pricing');

    // A real h1 that says something the title does not is kept.
    const landing = demoPage('index.html');
    expect(landing.text).toContain('Time-series storage that does not fall over');
  });

  it('keeps blocks in document order so chunking can follow the page', () => {
    const page = demoPage('pricing.html');
    const texts = page.blocks.map((b) => b.text);
    expect(texts.indexOf('Free')).toBeLessThan(texts.indexOf('Team'));
    expect(texts.indexOf('Team')).toBeLessThan(texts.indexOf('Business'));
  });

  it('reads the category from breadcrumbs on a nested page', () => {
    expect(demoPage('docs/api.html').category).toBe('Docs');
    expect(demoPage('blog/why-columnar.html').category).toBe('Blog');
  });

  it('handles a landing page, which Readability often declines', () => {
    const page = demoPage('index.html');
    expect(page.text).toContain('columnar time-series database');
    expect(page.text.length).toBeGreaterThan(500);
    expect(page.text).not.toContain('All rights reserved');
  });

  it('does not duplicate text nested inside another block element', () => {
    const page = demoPage('docs/limits.html');
    const occurrences = page.text.split('Rate limits are per organisation').length - 1;
    expect(occurrences).toBe(1);
  });

  it('extracts every demo page to something substantial', () => {
    for (const path of ['index.html', 'pricing.html', 'faq.html', 'changelog.html', 'about.html', 'contact.html', 'docs/quickstart.html', 'docs/authentication.html']) {
      const page = demoPage(path);
      expect(page.text.length, `${path} extracted too little`).toBeGreaterThan(400);
      expect(page.title, `${path} has no title`).not.toBe('Untitled');
      expect(page.blocks.some((b) => b.type === 'heading'), `${path} lost its headings`).toBe(true);
    }
  });
});

describe('extractFromHtml, edge cases', () => {
  const wrap = (body: string, head = '') =>
    `<!doctype html><html lang="en"><head><title>T</title>${head}</head><body>${body}</body></html>`;

  it('falls back to the body when there is no main or article', () => {
    const page = extractFromHtml(wrap('<div><h1>Hi</h1><p>Some words here.</p></div>'), 'https://x.example/a');
    expect(page.text).toContain('Some words here.');
  });

  it('survives malformed HTML', () => {
    const page = extractFromHtml('<html><body><p>Unclosed paragraph<div>more', 'https://x.example/a');
    expect(page.text).toContain('Unclosed paragraph');
  });

  it('returns an empty extraction rather than throwing on an empty document', () => {
    const page = extractFromHtml('', 'https://x.example/a');
    expect(page.blocks).toEqual([]);
    expect(page.text).toBe('');
    expect(page.title).toBe('Untitled');
  });

  it('prefers og:title over the title element', () => {
    const page = extractFromHtml(
      wrap('<p>x</p>', '<meta property="og:title" content="Open Graph Title">'),
      'https://x.example/a',
    );
    expect(page.title).toBe('Open Graph Title');
  });

  it('reads a JSON-LD breadcrumb trail when there is no breadcrumb nav', () => {
    const ld = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', name: 'Home' },
        { '@type': 'ListItem', name: 'Guides' },
        { '@type': 'ListItem', name: 'This page' },
      ],
    });
    const page = extractFromHtml(
      wrap('<p>x</p>', `<script type="application/ld+json">${ld}</script>`),
      'https://x.example/z',
    );
    expect(page.category).toBe('Guides');
  });

  it('ignores invalid JSON-LD instead of throwing', () => {
    const page = extractFromHtml(
      wrap('<p>Body text.</p>', '<script type="application/ld+json">{not json</script>'),
      'https://x.example/a',
    );
    expect(page.text).toContain('Body text.');
  });

  it('falls back to the URL path for a category', () => {
    expect(extractFromHtml(wrap('<p>x</p>'), 'https://x.example/guides/thing.html').category).toBe('Guides');
    expect(extractFromHtml(wrap('<p>x</p>'), 'https://x.example/thing.html').category).toBeNull();
  });
});

describe('content hash', () => {
  const page = (body: string) => extractFromHtml(`<title>T</title><main>${body}</main>`, 'https://x.example/a');

  it('is stable across identical extractions', () => {
    expect(page('<p>Same content.</p>').hash).toBe(page('<p>Same content.</p>').hash);
  });

  it('changes when the content changes, which is what drives revalidation', () => {
    expect(page('<p>Before.</p>').hash).not.toBe(page('<p>After.</p>').hash);
  });

  it('ignores changes to stripped chrome', () => {
    const a = extractFromHtml('<title>T</title><main><p>Body.</p></main><footer>v1</footer>', 'https://x.example/a');
    const b = extractFromHtml('<title>T</title><main><p>Body.</p></main><footer>v2</footer>', 'https://x.example/a');
    expect(a.hash).toBe(b.hash);
  });
});
