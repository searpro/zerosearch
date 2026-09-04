import { describe, expect, it } from 'vitest';
import {
  type CategoryInput,
  buildCategoryTree,
  suggestQuestions,
  topCategories,
  titleShortener,
} from '../../src/knowledge/categories.js';
import { describeUrl } from '../../src/dom/manifest.js';

/**
 * The category tree, and the "what can I ask?" list built on it.
 *
 * This runs before anything has been fetched — that is the point of deriving it
 * from URL structure — so the tests work from bare sitemap entries and only
 * then add what enrichment would have supplied.
 */

// The real slug derivation, so these fixtures are the titles production sees.
const entry = (url: string, overrides: Partial<CategoryInput> = {}): CategoryInput => ({
  url,
  ...describeUrl(url),
  ...overrides,
});

const SITE = [
  entry('https://m.example/index.html'),
  entry('https://m.example/pricing.html'),
  entry('https://m.example/about.html'),
  entry('https://m.example/docs/api.html'),
  entry('https://m.example/docs/limits.html'),
  entry('https://m.example/blog/v3-launch.html'),
];

describe('buildCategoryTree', () => {
  it('groups pages by their URL path', () => {
    const tree = buildCategoryTree(SITE);
    expect(tree.children.map((c) => c.label).sort()).toEqual(['Blog', 'Docs']);
    expect(tree.pages.map((p) => p.title)).toContain('Pricing');
  });

  it('labels a category readably rather than as a slug', () => {
    const tree = buildCategoryTree([
      entry('https://m.example/getting-started/install.html'),
      entry('https://m.example/index.html'),
    ]);
    expect(tree.children[0]?.label).toBe('Getting Started');
  });

  it('strips a mount directory every page shares', () => {
    // A site served from /demo/ has `demo` on every URL. That is our own path
    // layout, not a section of the site, and showing it as one is noise.
    const tree = buildCategoryTree([
      entry('https://m.example/demo/index.html'),
      entry('https://m.example/demo/pricing.html'),
      entry('https://m.example/demo/docs/api.html'),
    ]);
    expect(tree.children.map((c) => c.label)).toEqual(['Docs']);
    expect(tree.pages).toHaveLength(2);
    // And the index page of that directory is "Home", not "Demo" — a visitor
    // offered "Demo" as a thing to ask about learns only where we host it.
    expect(tree.pages.map((p) => p.title)).toContain('Home');
  });

  it('keeps a real directory index named after its directory', () => {
    // `/docs/index.html` genuinely is "Docs"; only the mount point is noise.
    const tree = buildCategoryTree([
      entry('https://m.example/index.html'),
      entry('https://m.example/docs/index.html'),
    ]);
    expect(tree.children[0]?.pages.map((p) => p.title)).toEqual(['Docs']);
  });

  it('ignores a breadcrumb category that is only the mount directory again', () => {
    // Extraction falls back to the URL's first path segment when a page has no
    // breadcrumb. For a site at /demo/ that is "demo" — the mount point the
    // tree just stripped, which must not come back as a category.
    const tree = buildCategoryTree([
      entry('https://m.example/demo/index.html', { category: 'demo' }),
      entry('https://m.example/demo/pricing.html', { category: 'demo' }),
      entry('https://m.example/demo/docs/api.html', { category: 'docs' }),
    ]);
    expect(tree.children.map((c) => c.label)).toEqual(['Docs']);
    expect(tree.pages).toHaveLength(2);
  });

  it('files a page by its breadcrumb when its URL gives no hint', () => {
    const tree = buildCategoryTree([
      entry('https://m.example/x.html', { segments: [], category: 'Support' }),
      entry('https://m.example/y.html', { segments: [] }),
    ]);
    expect(tree.children.map((c) => c.label)).toEqual(['Support']);
  });

  it('orders pages within a category by the sitemap priority the owner set', () => {
    const tree = buildCategoryTree([
      entry('https://m.example/a.html', { priority: 0.2 }),
      entry('https://m.example/b.html', { priority: 0.9 }),
    ]);
    expect(tree.pages.map((p) => p.title)).toEqual(['B', 'A']);
  });

  it('survives an empty manifest', () => {
    expect(buildCategoryTree([]).children).toEqual([]);
  });
});

describe('topCategories', () => {
  it('returns the fullest categories first', () => {
    const tree = buildCategoryTree(SITE);
    expect(topCategories(tree, 2).map((c) => c.label)).toEqual(['Site', 'Docs']);
  });
});

describe('suggestQuestions', () => {
  it('prefers questions the site itself poses', () => {
    const entries = [
      entry('https://m.example/faq.html', {
        questions: ['Can I migrate from Prometheus?', 'How long is data kept?'],
      }),
      ...SITE,
    ];
    const suggestions = suggestQuestions(entries, buildCategoryTree(entries), 3);
    expect(suggestions[0]?.text).toBe('Can I migrate from Prometheus?');
  });

  it('attributes a question to the page that actually poses it', () => {
    // The pages before it pose none. If those were filtered out rather than
    // skipped, this question would be credited to whichever page fell into its
    // index — a suggestion pointing somewhere it does not come from.
    const entries = [
      entry('https://m.example/index.html'),
      entry('https://m.example/pricing.html'),
      entry('https://m.example/faq.html', { questions: ['Do you support SSO?'] }),
    ];
    const [first] = suggestQuestions(entries, buildCategoryTree(entries), 6);

    expect(first?.text).toBe('Do you support SSO?');
    expect(first?.url).toBe('https://m.example/faq.html');
  });

  it('never invents one — every suggestion is verbatim site text', () => {
    const entries = [entry('https://m.example/faq.html', { questions: ['Do you support SSO?'] }), ...SITE];
    const vocabulary = new Set(entries.flatMap((e) => [e.slugTitle, ...(e.questions ?? [])]));

    for (const suggestion of suggestQuestions(entries, buildCategoryTree(entries), 6)) {
      expect(vocabulary.has(suggestion.text)).toBe(true);
    }
  });

  it('spreads across categories rather than draining the largest', () => {
    const suggestions = suggestQuestions(SITE, buildCategoryTree(SITE), 4);
    expect(new Set(suggestions.map((s) => s.category)).size).toBeGreaterThan(1);
  });

  it('does not let one exhaustively-headed page fill the whole list', () => {
    const entries = [
      entry('https://m.example/faq.html', {
        questions: ['Q one?', 'Q two?', 'Q three?', 'Q four?', 'Q five?', 'Q six?'],
      }),
      entry('https://m.example/docs/limits.html', { questions: ['What is the rate limit?'] }),
      ...SITE,
    ];
    const suggestions = suggestQuestions(entries, buildCategoryTree(entries), 4);
    expect(suggestions.map((s) => s.text)).toContain('What is the rate limit?');
  });

  it('deduplicates, since the same question can head several pages', () => {
    const entries = [
      entry('https://m.example/a.html', { questions: ['Do you support SSO?'] }),
      entry('https://m.example/b.html', { questions: ['Do you support SSO?'] }),
    ];
    const suggestions = suggestQuestions(entries, buildCategoryTree(entries), 6);
    expect(suggestions.filter((s) => s.text === 'Do you support SSO?')).toHaveLength(1);
  });

  it('honours the limit', () => {
    expect(suggestQuestions(SITE, buildCategoryTree(SITE), 2)).toHaveLength(2);
  });

  it('returns nothing rather than throwing when there is no manifest', () => {
    expect(suggestQuestions([], buildCategoryTree([]), 6)).toEqual([]);
  });
});

describe('titleShortener', () => {
  const shorten = (titles: string[]) => titles.map(titleShortener(titles));

  it('drops the site name sites hang off the end of every title', () => {
    expect(
      shorten(['Pricing — Meridian', 'Changelog — Meridian', 'About — Meridian']),
    ).toEqual(['Pricing', 'Changelog', 'About']);
  });

  it('drops it from the front when that is where the site puts it', () => {
    expect(
      shorten(['Meridian | Pricing', 'Meridian | Changelog', 'Meridian | About']),
    ).toEqual(['Pricing', 'Changelog', 'About']);
  });

  it('recognises a site name that varies across sections', () => {
    // "— Meridian", "— Meridian docs", "— Meridian blog" are one site name
    // written three ways. Matching whole segments sees three unrelated
    // suffixes; matching the leading word sees the site.
    expect(
      shorten([
        'Pricing — Meridian',
        'Changelog — Meridian',
        'Quickstart — Meridian docs',
        'Limits and quotas — Meridian docs',
        'Why we went columnar — Meridian blog',
      ]),
    ).toEqual(['Pricing', 'Changelog', 'Quickstart', 'Limits and quotas', 'Why we went columnar']);
  });

  it('leaves titles alone when nothing repeats', () => {
    const titles = ['Why we went columnar — a design note', 'Pricing', 'About us'];
    expect(shorten(titles)).toEqual(titles);
  });

  it('keeps everything but the site name on a three-part title', () => {
    expect(
      shorten(['Limits — Docs — Meridian', 'API — Docs — Meridian', 'Pricing — Meridian']),
    ).toEqual(['Limits — Docs', 'API — Docs', 'Pricing']);
  });

  it('never empties a title that is only the site name', () => {
    expect(shorten(['Meridian', 'Pricing — Meridian', 'About — Meridian'])).toContain('Meridian');
  });

  it('does nothing with too few titles to tell a pattern from a coincidence', () => {
    expect(shorten(['Pricing — Meridian'])).toEqual(['Pricing — Meridian']);
  });
});
