import { describe, expect, it } from 'vitest';
import { extractFromHtml } from '../../src/dom/extract.js';
import {
  MAX_SUMMARY_CHARS,
  headingsOf,
  questionHeadings,
  summarizePage,
} from '../../src/knowledge/enrich.js';
import type { Block } from '../../src/knowledge/types.js';

/**
 * Enrichment turns a fetched page into something routing can find.
 *
 * The property that matters is not eloquence — it is that everything in a
 * summary came off the page. A summary is persisted and drives which pages a
 * question reaches, so a sentence the page does not contain would misroute
 * questions on that device until the cache key changes.
 */

const heading = (text: string, level = 2): Block => ({ type: 'heading', level, text });
const text = (value: string): Block => ({ type: 'text', text: value });

describe('headingsOf', () => {
  it('keeps document order', () => {
    const blocks = [heading('Retention'), text('body'), heading('Cardinality')];
    expect(headingsOf(blocks)).toEqual(['Retention', 'Cardinality']);
  });

  it('drops the heading that only repeats the title', () => {
    const blocks = [heading('Pricing', 1), heading('Team')];
    expect(headingsOf(blocks, 'Pricing')).toEqual(['Team']);
  });

  it('deduplicates, because a long page repeats its section names', () => {
    expect(headingsOf([heading('Limits'), heading('limits '), heading('Limits')])).toEqual(['Limits']);
  });

  it('ignores stubs that are navigation furniture rather than topics', () => {
    expect(headingsOf([heading('›'), heading('Retention')])).toEqual(['Retention']);
  });
});

describe('questionHeadings', () => {
  it('picks out the headings that are already questions', () => {
    const blocks = [
      heading('Can I migrate from Prometheus?'),
      heading('Retention'),
      heading('Do you support SSO?'),
    ];
    expect(questionHeadings(blocks)).toEqual([
      'Can I migrate from Prometheus?',
      'Do you support SSO?',
    ]);
  });

  it('returns nothing when the page poses none', () => {
    expect(questionHeadings([heading('Retention'), text('Data is kept for 30 days.')])).toEqual([]);
  });
});

describe('summarizePage', () => {
  it('leads with the headings, which name what the page covers', () => {
    const summary = summarizePage({
      title: 'Limits',
      blocks: [heading('Rate limits'), heading('Cardinality'), text('Every plan has a ceiling on writes.')],
    });
    expect(summary.indexOf('Rate limits')).toBeLessThan(summary.indexOf('ceiling'));
  });

  it('adds opening prose once the headings are in', () => {
    const summary = summarizePage({
      title: 'About',
      blocks: [heading('Team'), text('Meridian was founded in 2019 and employs 34 people.')],
    });
    expect(summary).toContain('34 people');
  });

  it('says nothing the page does not', () => {
    const page = extractFromHtml(
      `<title>About</title><main><h2>Team</h2>
       <p>Meridian was founded in 2019 and employs 34 people.</p></main>`,
      'https://meridian.example/about.html',
    );
    const summary = summarizePage(page);

    // Every word in the summary must appear in the page's own text or title.
    const source = `${page.title} ${page.text}`.toLowerCase();
    for (const word of summary.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      expect(source, `"${word}" is not on the page`).toContain(word);
    }
  });

  it('stays inside what the embedder actually reads', () => {
    const blocks = Array.from({ length: 60 }, (_, i) => heading(`Section number ${i} of this page`));
    expect(summarizePage({ title: 'Long', blocks }).length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
  });

  it('is empty for a page with no readable content, rather than throwing', () => {
    expect(summarizePage({ title: 'Empty', blocks: [] })).toBe('');
  });

  it('drops sentence fragments, which describe nothing', () => {
    const summary = summarizePage({ title: 'X', blocks: [text('Yes.'), text('No.')] });
    expect(summary).toBe('');
  });
});
