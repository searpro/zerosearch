/**
 * Dense vector index.
 *
 * Brute force on purpose. At the scale a site index actually reaches — a few
 * thousand chunks of 384 dimensions is under 10MB — a full scan costs single
 * -digit milliseconds, which is far below the cost of embedding the query that
 * produced it. An ANN structure here would add a dependency, a build step and
 * approximation error to save nothing a user could perceive.
 */

export interface Match {
  id: string;
  score: number;
}

/** L2-normalise in place, so a dot product is the cosine similarity. */
export function l2Normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i += 1) vec[i] = vec[i]! / norm;
  return vec;
}

export class VectorIndex {
  readonly dim: number;
  #data: Float32Array;
  #ids: string[] = [];
  #rowOf = new Map<string, number>();
  #count = 0;

  constructor(dim: number, capacity = 256) {
    this.dim = dim;
    this.#data = new Float32Array(dim * Math.max(1, capacity));
  }

  get size(): number {
    return this.#count;
  }

  get ids(): readonly string[] {
    return this.#ids;
  }

  has(id: string): boolean {
    return this.#rowOf.has(id);
  }

  /** Adds, or replaces in place when the id is already present. */
  add(id: string, vec: Float32Array): void {
    if (vec.length !== this.dim) {
      throw new Error(`vector index expects ${this.dim} dimensions, got ${vec.length}`);
    }
    const existing = this.#rowOf.get(id);
    const row = existing ?? this.#count;
    if (existing === undefined) {
      this.#grow(this.#count + 1);
      this.#ids[row] = id;
      this.#rowOf.set(id, row);
      this.#count += 1;
    }
    this.#data.set(vec, row * this.dim);
  }

  /**
   * Removes by swapping the last row into the hole. Order is not meaningful
   * here, so this stays O(1) and avoids rewriting the whole buffer during
   * revalidation.
   */
  remove(id: string): boolean {
    const row = this.#rowOf.get(id);
    if (row === undefined) return false;

    const last = this.#count - 1;
    if (row !== last) {
      const lastId = this.#ids[last]!;
      this.#data.copyWithin(row * this.dim, last * this.dim, (last + 1) * this.dim);
      this.#ids[row] = lastId;
      this.#rowOf.set(lastId, row);
    }
    this.#ids.length = last;
    this.#rowOf.delete(id);
    this.#count = last;
    return true;
  }

  /** Drops every chunk belonging to a page. Used when a page's content changes. */
  removeByPrefix(prefix: string): number {
    let removed = 0;
    for (const id of [...this.#rowOf.keys()]) {
      if (id.startsWith(prefix)) {
        this.remove(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Top `k` by cosine similarity. Assumes both sides are already normalised. */
  search(query: Float32Array, k = 10): Match[] {
    if (query.length !== this.dim) {
      throw new Error(`query has ${query.length} dimensions, index has ${this.dim}`);
    }
    const limit = Math.min(k, this.#count);
    if (limit <= 0) return [];

    // Bounded insertion rather than scoring everything and sorting: k is small,
    // and this avoids allocating an object per row on every keystroke.
    const bestScore = new Float32Array(limit).fill(Number.NEGATIVE_INFINITY);
    const bestRow = new Int32Array(limit).fill(-1);

    for (let row = 0; row < this.#count; row += 1) {
      const offset = row * this.dim;
      let dot = 0;
      for (let d = 0; d < this.dim; d += 1) dot += this.#data[offset + d]! * query[d]!;

      if (dot <= bestScore[limit - 1]!) continue;
      let i = limit - 1;
      while (i > 0 && bestScore[i - 1]! < dot) {
        bestScore[i] = bestScore[i - 1]!;
        bestRow[i] = bestRow[i - 1]!;
        i -= 1;
      }
      bestScore[i] = dot;
      bestRow[i] = row;
    }

    const out: Match[] = [];
    for (let i = 0; i < limit; i += 1) {
      const row = bestRow[i]!;
      if (row < 0) break;
      out.push({ id: this.#ids[row]!, score: bestScore[i]! });
    }
    return out;
  }

  /** Compact copy for persisting to IndexedDB. */
  toJSON(): { dim: number; ids: string[]; data: Float32Array } {
    return {
      dim: this.dim,
      ids: [...this.#ids],
      data: this.#data.slice(0, this.#count * this.dim),
    };
  }

  static fromJSON(saved: { dim: number; ids: string[]; data: Float32Array }): VectorIndex {
    const index = new VectorIndex(saved.dim, Math.max(1, saved.ids.length));
    index.#data.set(saved.data);
    index.#ids = [...saved.ids];
    index.#count = saved.ids.length;
    saved.ids.forEach((id, row) => index.#rowOf.set(id, row));
    return index;
  }

  #grow(needed: number): void {
    const capacity = this.#data.length / this.dim;
    if (needed <= capacity) return;
    let next = Math.max(1, capacity);
    while (next < needed) next *= 2;
    const grown = new Float32Array(next * this.dim);
    grown.set(this.#data);
    this.#data = grown;
  }
}
