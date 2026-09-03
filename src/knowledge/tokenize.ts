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

/** `v3`, `v12` — a version marker written the way documentation writes it. */
const VERSION_MARKER = /^v(\d+)$/;
/** How people say the same thing out loud. */
const VERSION_WORD = /^(?:version|ver|v)$/;

export function tokenize(text: string, { keepStopwords = false } = {}): string[] {
  const raw: string[] = [];
  for (const match of text.toLowerCase().matchAll(TOKEN)) {
    if (match[0].length <= 64) raw.push(match[0]);
  }

  const out: string[] = [];
  const emit = (token: string): void => {
    if (token.length === 0) return;
    if (!keepStopwords && STOPWORDS.has(token)) return;
    out.push(token);
  };

  raw.forEach((token, i) => {
    const isCompound = /[.\-_/]/.test(token);
    // Keep the compound whole so an exact query can match it outright, and also
    // index its parts so half a query still finds it.
    const parts = isCompound ? [token, ...token.split(/[.\-_/]/)] : [token];
    for (const part of parts) emit(part);

    // Documentation writes "v3.0.0"; people ask about "version 3". Neither form
    // shares a token with the other, so both are normalised toward each other.
    // Applied to documents and queries alike, so the bridge works either way.
    for (const part of parts) {
      const marker = VERSION_MARKER.exec(part);
      if (marker) emit(marker[1]!);
    }
    const next = raw[i + 1];
    if (VERSION_WORD.test(token) && next && /^\d+$/.test(next)) emit(`v${next}`);
  });

  return out;
}

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}
