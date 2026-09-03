import type { Match } from './vector.js';

/**
 * BM25 lexical index.
 *
 * This exists because dense retrieval over a small embedding model is bad at
 * exact tokens. Ask MiniLM for "MRD-4400" or "v3.2.1" and it returns things
 * that are topically nearby; ask BM25 and it returns the page that literally
 * contains the string. Site assistants get asked that kind of question
 * constantly — error codes, plan names, version numbers — so the two are fused
 * rather than either being used alone.
 */

const K1 = 1.2;
const B = 0.75;

interface Doc {
  length: number;
  tf: Map<string, number>;
}

export class Bm25Index {
  #docs = new Map<string, Doc>();
  #postings = new Map<string, Set<string>>();
  #totalLength = 0;

  get size(): number {
    return this.#docs.size;
  }

  get averageLength(): number {
    return this.#docs.size === 0 ? 0 : this.#totalLength / this.#docs.size;
  }

  add(id: string, tokens: string[]): void {
    this.remove(id);

    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);

    this.#docs.set(id, { length: tokens.length, tf });
    this.#totalLength += tokens.length;

    for (const term of tf.keys()) {
      let posting = this.#postings.get(term);
      if (!posting) {
        posting = new Set();
        this.#postings.set(term, posting);
      }
      posting.add(id);
    }
  }

  remove(id: string): boolean {
    const doc = this.#docs.get(id);
    if (!doc) return false;

    for (const term of doc.tf.keys()) {
      const posting = this.#postings.get(term);
      if (!posting) continue;
      posting.delete(id);
      if (posting.size === 0) this.#postings.delete(term);
    }
    this.#totalLength -= doc.length;
    this.#docs.delete(id);
    return true;
  }

  removeByPrefix(prefix: string): number {
    let removed = 0;
    for (const id of [...this.#docs.keys()]) {
      if (id.startsWith(prefix)) {
        this.remove(id);
        removed += 1;
      }
    }
    return removed;
  }

  search(queryTokens: string[], k = 10): Match[] {
    if (this.#docs.size === 0 || queryTokens.length === 0) return [];

    const avgdl = this.averageLength;
    const N = this.#docs.size;
    const scores = new Map<string, number>();

    // Deduplicate: repeating a term in the query should not double its weight.
    for (const term of new Set(queryTokens)) {
      const posting = this.#postings.get(term);
      if (!posting) continue;

      const df = posting.size;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      for (const id of posting) {
        const doc = this.#docs.get(id)!;
        const tf = doc.tf.get(term)!;
        const norm = tf + K1 * (1 - B + (B * doc.length) / avgdl);
        scores.set(id, (scores.get(id) ?? 0) + idf * ((tf * (K1 + 1)) / norm));
      }
    }

    return [...scores]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  toJSON(): { docs: [string, [string, number][], number][] } {
    return {
      docs: [...this.#docs].map(([id, doc]) => [id, [...doc.tf], doc.length]),
    };
  }

  static fromJSON(saved: { docs: [string, [string, number][], number][] }): Bm25Index {
    const index = new Bm25Index();
    for (const [id, tf, length] of saved.docs) {
      index.#docs.set(id, { length, tf: new Map(tf) });
      index.#totalLength += length;
      for (const [term] of tf) {
        let posting = index.#postings.get(term);
        if (!posting) {
          posting = new Set();
          index.#postings.set(term, posting);
        }
        posting.add(id);
      }
    }
    return index;
  }
}
