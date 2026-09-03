import { Bm25Index } from './bm25.js';
import { reciprocalRankFusion } from './fuse.js';
import { tokenize } from './tokenize.js';
import { VectorIndex } from './vector.js';

/**
 * Dense and lexical retrieval behind one interface.
 *
 * Used twice, for two different granularities: over chunks, to find passages,
 * and over the routing manifest, to decide which page is worth fetching in the
 * first place. Both need the same fusion, so both get the same class.
 */

export interface HybridMatch {
  id: string;
  /** Fused rank score. Comparable within one result set, not across queries. */
  score: number;
  /** Cosine similarity. Interpretable, so this is what a relevance floor uses. */
  dense: number;
  lexical: number;
}

export interface SearchOptions {
  limit?: number;
  /** How deep each retriever goes before fusion. */
  candidates?: number;
  /** Relative weight of dense vs lexical. */
  weights?: [number, number];
}

export class HybridIndex {
  readonly dim: number;
  #dense: VectorIndex;
  #lexical = new Bm25Index();

  constructor(dim: number) {
    this.dim = dim;
    this.#dense = new VectorIndex(dim);
  }

  get size(): number {
    return this.#dense.size;
  }

  add(id: string, text: string, vector: Float32Array): void {
    this.#dense.add(id, vector);
    this.#lexical.add(id, tokenize(text));
  }

  remove(id: string): void {
    this.#dense.remove(id);
    this.#lexical.remove(id);
  }

  /** Drop every entry belonging to a page, by id prefix. */
  removeByPrefix(prefix: string): number {
    this.#lexical.removeByPrefix(prefix);
    return this.#dense.removeByPrefix(prefix);
  }

  has(id: string): boolean {
    return this.#dense.has(id);
  }

  search(queryVector: Float32Array, queryText: string, options: SearchOptions = {}): HybridMatch[] {
    const limit = options.limit ?? 8;
    const candidates = options.candidates ?? Math.max(limit * 4, 24);
    if (this.size === 0) return [];

    const dense = this.#dense.search(queryVector, candidates);
    const lexical = this.#lexical.search(tokenize(queryText), candidates);

    const denseScore = new Map(dense.map((m) => [m.id, m.score]));
    const lexicalScore = new Map(lexical.map((m) => [m.id, m.score]));

    return reciprocalRankFusion([dense, lexical], {
      weights: options.weights ?? [1, 1],
      limit,
    }).map((match) => ({
      id: match.id,
      score: match.score,
      dense: denseScore.get(match.id) ?? 0,
      lexical: lexicalScore.get(match.id) ?? 0,
    }));
  }

  clear(): void {
    this.#dense = new VectorIndex(this.dim);
    this.#lexical = new Bm25Index();
  }
}
