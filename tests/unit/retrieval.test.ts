import { describe, expect, it } from 'vitest';
import { Bm25Index } from '../../src/knowledge/bm25.js';
import { reciprocalRankFusion } from '../../src/knowledge/fuse.js';
import { tokenize } from '../../src/knowledge/tokenize.js';
import { VectorIndex, l2Normalize } from '../../src/knowledge/vector.js';

const vec = (...values: number[]) => l2Normalize(Float32Array.from(values));

describe('l2Normalize', () => {
  it('produces a unit vector', () => {
    const v = vec(3, 4);
    expect(Math.hypot(v[0]!, v[1]!)).toBeCloseTo(1, 6);
  });

  it('leaves a zero vector alone rather than producing NaN', () => {
    const v = l2Normalize(Float32Array.from([0, 0, 0]));
    expect([...v]).toEqual([0, 0, 0]);
  });
});

describe('VectorIndex', () => {
  it('ranks by cosine similarity', () => {
    const index = new VectorIndex(2);
    index.add('east', vec(1, 0));
    index.add('north', vec(0, 1));
    index.add('northeast', vec(1, 1));

    const hits = index.search(vec(1, 0), 3);
    expect(hits[0]!.id).toBe('east');
    expect(hits[0]!.score).toBeCloseTo(1, 5);
    expect(hits[1]!.id).toBe('northeast');
    expect(hits[2]!.id).toBe('north');
  });

  it('replaces in place when an id is re-added', () => {
    const index = new VectorIndex(2);
    index.add('a', vec(1, 0));
    index.add('a', vec(0, 1));

    expect(index.size).toBe(1);
    expect(index.search(vec(0, 1), 1)[0]!.score).toBeCloseTo(1, 5);
  });

  it('removes without corrupting the remaining rows', () => {
    const index = new VectorIndex(2);
    index.add('a', vec(1, 0));
    index.add('b', vec(0, 1));
    index.add('c', vec(1, 1));

    expect(index.remove('a')).toBe(true);
    expect(index.remove('a')).toBe(false);
    expect(index.size).toBe(2);

    // 'c' was swapped into the hole; it must still be findable and correct.
    const hits = index.search(vec(1, 1), 2);
    expect(hits.map((h) => h.id).sort()).toEqual(['b', 'c']);
    expect(index.search(vec(0, 1), 1)[0]!.id).toBe('b');
  });

  it('drops a whole page by chunk-id prefix', () => {
    const index = new VectorIndex(2);
    index.add('/a#0', vec(1, 0));
    index.add('/a#1', vec(0, 1));
    index.add('/b#0', vec(1, 1));

    expect(index.removeByPrefix('/a#')).toBe(2);
    expect(index.size).toBe(1);
    expect(index.has('/b#0')).toBe(true);
  });

  it('grows past its initial capacity', () => {
    const index = new VectorIndex(2, 1);
    for (let i = 0; i < 50; i += 1) index.add(`id-${i}`, vec(Math.cos(i), Math.sin(i)));
    expect(index.size).toBe(50);
    expect(index.search(vec(Math.cos(7), Math.sin(7)), 1)[0]!.id).toBe('id-7');
  });

  it('survives a save/load round trip', () => {
    const index = new VectorIndex(2);
    index.add('a', vec(1, 0));
    index.add('b', vec(0, 1));

    const restored = VectorIndex.fromJSON(index.toJSON());
    expect(restored.size).toBe(2);
    expect(restored.search(vec(1, 0), 1)[0]!.id).toBe('a');
    // Still mutable after restore.
    restored.add('c', vec(1, 1));
    expect(restored.size).toBe(3);
  });

  it('rejects a dimension mismatch instead of returning nonsense', () => {
    const index = new VectorIndex(3);
    expect(() => index.add('a', vec(1, 0))).toThrow(/3 dimensions/);
    index.add('a', vec(1, 0, 0));
    expect(() => index.search(vec(1, 0), 1)).toThrow(/dimensions/);
  });

  it('returns nothing from an empty index', () => {
    expect(new VectorIndex(4).search(vec(1, 0, 0, 0), 5)).toEqual([]);
  });
});

describe('tokenize', () => {
  it('keeps compound tokens whole and also emits their parts', () => {
    expect(tokenize('MRD-4400')).toEqual(['mrd-4400', 'mrd', '4400']);
    // `3` comes from normalising the `v3` marker — see the version tests below.
    expect(tokenize('v3.2.1')).toEqual(['v3.2.1', 'v3', '2', '1', '3']);
  });

  it('bridges "v3" and "version 3", which share no token otherwise', () => {
    // Documentation writes one, people ask with the other. Normalising both
    // toward each other is what lets either form find the other.
    expect(tokenize('version 3')).toContain('v3');
    expect(tokenize('v3')).toContain('3');

    const doc = new Set(tokenize('Breaking changes in v3.0.0 of the product'));
    const query = tokenize('what broke in version 3');
    expect(query.some((term) => doc.has(term))).toBe(true);
  });

  it('normalises the abbreviated spellings too', () => {
    expect(tokenize('ver 12')).toContain('v12');
    expect(tokenize('v 2')).toContain('v2');
  });

  it('does not invent a version from an unrelated number', () => {
    expect(tokenize('we have 34 people')).not.toContain('v34');
  });

  it('drops stopwords but keeps meaningful terms', () => {
    expect(tokenize('the rate limits are per organisation')).toEqual([
      'rate',
      'limits',
      'per',
      'organisation',
    ]);
  });

  it('lowercases and ignores punctuation', () => {
    expect(tokenize('Rate Limits!  (per org)')).toEqual(['rate', 'limits', 'per', 'org']);
  });
});

describe('Bm25Index', () => {
  const corpus: [string, string][] = [
    ['pricing', 'Team costs 49 dollars per month with 10,000 requests per minute'],
    ['limits', 'Rate limits are per organisation. Free allows 1,000 requests per minute'],
    ['contact', 'Include your organisation ID, the MRD prefixed identifier such as MRD-4400'],
    ['about', 'Meridian was founded in 2021 and is a remote-first company of 34 people'],
  ];

  const build = () => {
    const index = new Bm25Index();
    for (const [id, text] of corpus) index.add(id, tokenize(text));
    return index;
  };

  it('finds an exact identifier that dense retrieval would blur', () => {
    expect(build().search(tokenize('MRD-4400'), 3)[0]!.id).toBe('contact');
  });

  it('finds a document by half of a compound token', () => {
    // Someone typing just "4400" should still land on the right page.
    expect(build().search(tokenize('4400'), 3)[0]!.id).toBe('contact');
  });

  it('weights rare terms above common ones', () => {
    // "requests per minute" appears in two docs; "dollars" only in one.
    expect(build().search(tokenize('dollars'), 3)[0]!.id).toBe('pricing');
  });

  it('returns nothing for a term absent from the corpus', () => {
    expect(build().search(tokenize('kubernetes'), 3)).toEqual([]);
  });

  it('does not double-count a term repeated in the query', () => {
    const index = build();
    const once = index.search(tokenize('organisation'), 4);
    const twice = index.search(tokenize('organisation organisation'), 4);
    expect(twice.map((m) => m.id)).toEqual(once.map((m) => m.id));
    expect(twice[0]!.score).toBeCloseTo(once[0]!.score, 6);
  });

  it('re-adding an id replaces rather than duplicates', () => {
    const index = build();
    index.add('pricing', tokenize('completely different content about penguins'));
    expect(index.size).toBe(4);
    expect(index.search(tokenize('dollars'), 3)).toEqual([]);
    expect(index.search(tokenize('penguins'), 3)[0]!.id).toBe('pricing');
  });

  it('remove() also cleans up the postings and length statistics', () => {
    const index = build();
    const before = index.averageLength;
    expect(index.remove('contact')).toBe(true);
    expect(index.remove('contact')).toBe(false);
    expect(index.size).toBe(3);
    expect(index.averageLength).not.toBe(before);
    expect(index.search(tokenize('MRD-4400'), 3)).toEqual([]);
  });

  it('survives a save/load round trip', () => {
    const restored = Bm25Index.fromJSON(build().toJSON());
    expect(restored.size).toBe(4);
    expect(restored.search(tokenize('MRD-4400'), 3)[0]!.id).toBe('contact');
    expect(restored.averageLength).toBeGreaterThan(0);
  });
});

describe('reciprocalRankFusion', () => {
  it('promotes a document both retrievers agree on', () => {
    const dense = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.8 },
    ];
    const lexical = [
      { id: 'c', score: 12 },
      { id: 'b', score: 9 },
    ];

    // 'b' is second in both, 'a' and 'c' are first in only one each.
    expect(reciprocalRankFusion([dense, lexical])[0]!.id).toBe('b');
  });

  it('combines ranks, not incompatible score scales', () => {
    // BM25 magnitudes dwarf cosine; a naive sum would let lexical always win.
    const dense = [{ id: 'a', score: 0.99 }];
    const lexical = [{ id: 'b', score: 250 }];
    const fused = reciprocalRankFusion([dense, lexical]);
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score, 6);
  });

  it('honours per-list weights', () => {
    const dense = [{ id: 'a', score: 0.9 }];
    const lexical = [{ id: 'b', score: 9 }];
    expect(reciprocalRankFusion([dense, lexical], { weights: [3, 1] })[0]!.id).toBe('a');
    expect(reciprocalRankFusion([dense, lexical], { weights: [0, 1] }).map((m) => m.id)).toEqual(['b']);
  });

  it('handles empty and single-list input', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
    expect(reciprocalRankFusion([[{ id: 'a', score: 1 }]])[0]!.id).toBe('a');
  });

  it('respects the limit', () => {
    const list = Array.from({ length: 50 }, (_, i) => ({ id: `id-${i}`, score: 1 - i / 100 }));
    expect(reciprocalRankFusion([list], { limit: 5 })).toHaveLength(5);
  });
});
