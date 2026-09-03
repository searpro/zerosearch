/**
 * Lexical tokenizer for the BM25 index.
 *
 * Dense retrieval over a 23MB MiniLM reliably misses exact tokens — version
 * strings, SKUs, error codes — which is exactly what people type at a site's
 * search box. This tokenizer exists to catch those, so it deliberately keeps
 * compound tokens intact *and* emits their parts:
 *
 *   "MRD-4400"        -> mrd-4400, mrd, 4400
 *   "v3.2.1"          -> v3.2.1, v3, 2, 1
 *   "high-cardinality"-> high-cardinality, high, cardinality
 *
 * Keeping the whole form lets an exact query score hard; emitting the parts
 * keeps recall when someone types only one half.
 */

/** Compound-aware: a run of alphanumerics, optionally joined by . - _ / */
const TOKEN = /[a-z0-9]+(?:[.\-_/][a-z0-9]+)*/g;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does',
  'for', 'from', 'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'of',
  'on', 'or', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'will',
  'with', 'you', 'your',
]);

export function tokenize(text: string, { keepStopwords = false } = {}): string[] {
  const out: string[] = [];
  for (const match of text.toLowerCase().matchAll(TOKEN)) {
    const token = match[0];
    if (token.length > 64) continue;

    const isCompound = /[.\-_/]/.test(token);
    if (!isCompound) {
      if (keepStopwords || !STOPWORDS.has(token)) out.push(token);
      continue;
    }

    // Keep the compound whole so an exact query can match it outright...
    out.push(token);
    // ...and also index its parts so half a query still finds it.
    for (const part of token.split(/[.\-_/]/)) {
      if (part.length === 0) continue;
      if (!keepStopwords && STOPWORDS.has(part)) continue;
      out.push(part);
    }
  }
  return out;
}

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}
