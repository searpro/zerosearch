import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK_OPTIONS, chunkPage } from '../../src/knowledge/chunk.js';
import type { Block, ExtractedPage } from '../../src/knowledge/types.js';

const page = (blocks: Block[], title = 'Pricing — Meridian'): ExtractedPage => ({
  url: 'https://example.com/pricing.html',
  title,
  description: null,
  category: null,
  blocks,
  text: blocks.map((b) => b.text).join('\n'),
  hash: 'h',
  lang: 'en',
  fetchedAt: 0,
  etag: null,
  lastModified: null,
});

const h = (level: number, text: string): Block => ({ type: 'heading', level, text });
const p = (text: string): Block => ({ type: 'text', text });

/** Prose long enough to force splitting, with real sentence boundaries. */
const sentences = (n: number, word = 'alpha') =>
  Array.from({ length: n }, (_, i) => `This is sentence number ${i} about ${word} and its behaviour.`).join(' ');

describe('chunkPage', () => {
  it('returns nothing for an empty page', () => {
    expect(chunkPage(page([]))).toEqual([]);
    expect(chunkPage(page([p('   '), h(2, '  ')]))).toEqual([]);
  });

  it('prefixes every chunk with the title and heading path', () => {
    const chunks = chunkPage(page([h(1, 'Pricing'), h(2, 'Team'), p('Forty nine dollars a month.')]));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headingPath).toEqual(['Pricing', 'Team']);
    expect(chunks[0]!.text).toBe('Pricing — Meridian › Pricing › Team\nForty nine dollars a month.');
    // The body stays clean, because that is what gets shown as a citation.
    expect(chunks[0]!.body).toBe('Forty nine dollars a month.');
  });

  it('replaces a sibling heading and drops deeper levels', () => {
    const chunks = chunkPage(
      page([
        h(1, 'Docs'),
        h(2, 'Auth'),
        h(3, 'Scopes'),
        p('Scopes do not nest.'),
        h(2, 'Limits'),
        p('Rate limits are per organisation.'),
      ]),
    );
    expect(chunks[0]!.headingPath).toEqual(['Docs', 'Auth', 'Scopes']);
    expect(chunks.at(-1)!.headingPath).toEqual(['Docs', 'Limits']);
  });

  it('keeps every chunk under the ceiling MiniLM would truncate at', () => {
    const chunks = chunkPage(page([h(1, 'Long'), p(sentences(60))]));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.body.length).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxChars);
    }
  });

  it('splits a single oversized block rather than emitting it whole', () => {
    const chunks = chunkPage(page([p(sentences(40))]));
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('breaks at sentence boundaries, not mid-word', () => {
    const chunks = chunkPage(page([p(sentences(40))]));
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.body.trimEnd()).toMatch(/[.!?…]$/);
    }
  });

  it('overlaps consecutive chunks so an answer spanning a break is still findable', () => {
    const chunks = chunkPage(page([p(sentences(40))]));
    expect(chunks.length).toBeGreaterThan(1);

    const tailWords = chunks[0]!.body.trim().split(/\s+/).slice(-8);
    const next = chunks[1]!.body;
    // At least some of the previous chunk's tail is carried forward.
    expect(tailWords.some((w) => next.includes(w))).toBe(true);
  });

  it('merges a tiny trailing fragment into the previous chunk', () => {
    const chunks = chunkPage(page([h(1, 'A'), p(sentences(12)), h(2, 'B'), p('Tiny.')]));
    // "Tiny." is below minChars, so it must not become a chunk of its own.
    expect(chunks.some((c) => c.body.trim() === 'Tiny.')).toBe(false);
    expect(chunks.some((c) => c.body.includes('Tiny.'))).toBe(true);
  });

  it('breaks at a major heading once there is enough content to justify it', () => {
    const chunks = chunkPage(
      page([h(1, 'Plans'), p(sentences(4, 'free')), h(2, 'Business'), p(sentences(4, 'business'))]),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.body).toContain('free');
    expect(chunks.at(-1)!.body).toContain('business');
  });

  it('never files content under a sibling section it did not come from', () => {
    // Regression: two short sibling sections used to merge into one chunk that
    // kept only the first section's heading path, so a citation pointed at the
    // wrong part of the page.
    const chunks = chunkPage(
      page([
        h(1, 'Docs'),
        h(2, 'Auth'),
        p('Tokens are bearer tokens.'),
        h(2, 'Limits'),
        p('Rate limits are per organisation.'),
      ]),
    );

    for (const chunk of chunks) {
      const path = chunk.headingPath.join(' › ');
      if (chunk.body.includes('bearer')) expect(path).not.toContain('Limits');
      if (chunk.body.includes('Rate limits')) expect(path).not.toContain('Auth');
    }
  });

  it('emits sequential ids scoped to the page url', () => {
    const chunks = chunkPage(page([p(sentences(40))]));
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
    expect(chunks[0]!.id).toBe('https://example.com/pricing.html#0');
    expect(chunks.every((c) => c.url === 'https://example.com/pricing.html')).toBe(true);
  });

  it('does not emit a chunk for a heading with no content under it', () => {
    const chunks = chunkPage(page([h(1, 'Orphan'), h(2, 'Also orphan')]));
    expect(chunks).toEqual([]);
  });

  it('handles text with no sentence punctuation at all', () => {
    const chunks = chunkPage(page([p('word '.repeat(400).trim())]));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.body.length).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxChars);
      // Word boundaries respected even without punctuation to aim at.
      expect(chunk.body).not.toMatch(/^ord|wor$/);
    }
  });
});
