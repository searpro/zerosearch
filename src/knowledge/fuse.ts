import type { Match } from './vector.js';

/**
 * Reciprocal Rank Fusion.
 *
 * Dense and lexical scores live on incompatible scales — cosine sits in
 * [-1, 1], BM25 is unbounded and depends on corpus statistics — so they cannot
 * simply be added. RRF throws the magnitudes away and combines *ranks*, which
 * makes it robust without any tuning or normalisation per corpus.
 *
 * `k` damps the influence of top ranks; 60 is the value from the original
 * paper and behaves well without tuning.
 */
export function reciprocalRankFusion(
  lists: readonly (readonly Match[])[],
  { k = 60, weights, limit = 20 }: { k?: number; weights?: readonly number[]; limit?: number } = {},
): Match[] {
  const fused = new Map<string, number>();

  lists.forEach((list, listIndex) => {
    const weight = weights?.[listIndex] ?? 1;
    if (weight === 0) return;
    list.forEach((match, rank) => {
      fused.set(match.id, (fused.get(match.id) ?? 0) + weight / (k + rank + 1));
    });
  });

  return [...fused]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
