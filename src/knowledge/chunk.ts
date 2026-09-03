import type { Block, Chunk, ExtractedPage } from './types.js';

/**
 * Bumped whenever chunking changes shape. It is part of the cache key, so a
 * change here invalidates every stored chunk and vector for the origin —
 * otherwise old chunks and new queries would be embedded under different
 * assumptions.
 */
export const CHUNKER_VERSION = 1;

export interface ChunkOptions {
  /** Where we aim to break. */
  targetChars: number;
  /** Hard ceiling. all-MiniLM-L6-v2 truncates past ~256 word-piece tokens, so
   *  a chunk beyond roughly 900 characters silently loses its tail. */
  maxChars: number;
  /** Carried from the end of one chunk into the start of the next, so an answer
   *  spanning a boundary is still retrievable. */
  overlapChars: number;
  /** Below this, a trailing fragment is merged backwards instead of standing alone. */
  minChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetChars: 700,
  maxChars: 900,
  overlapChars: 120,
  minChars: 90,
};

/**
 * Split a page into embeddable chunks, preserving heading context.
 *
 * Each chunk is prefixed with the page title and its heading path. That costs
 * a few tokens but earns them back twice: the embedding captures where the
 * text sits in the document, and a retrieved chunk is self-describing when
 * shown as a citation.
 */
export function chunkPage(page: ExtractedPage, options: Partial<ChunkOptions> = {}): Chunk[] {
  const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const chunks: Chunk[] = [];

  /** headingStack[level] holds the most recent heading at that level. */
  const headingStack: (string | undefined)[] = [];
  let buffer = '';
  let bufferPath: string[] = [];

  const currentPath = (): string[] => headingStack.filter((h): h is string => typeof h === 'string');

  const flush = (): void => {
    const body = buffer.trim();
    buffer = '';
    if (body.length === 0) return;

    // Too short to stand alone: fold it back into the previous chunk when that
    // will not blow the ceiling. Losing content is worse than an uneven chunk.
    //
    // Only ever merge within one section though. Splicing two sibling sections
    // together would leave the chunk carrying a heading path it does not match,
    // and that path is what a citation shows the reader.
    const previous = chunks[chunks.length - 1];
    if (body.length < opts.minChars && previous && previous.body.length + body.length < opts.maxChars) {
      const shared = commonPath(previous.headingPath, bufferPath);
      if (shared) {
        previous.body = `${previous.body}\n${body}`;
        previous.headingPath = shared;
        previous.text = compose(page.title, shared, previous.body);
        return;
      }
    }

    chunks.push({
      id: `${page.url}#${chunks.length}`,
      url: page.url,
      index: chunks.length,
      headingPath: bufferPath,
      body,
      text: compose(page.title, bufferPath, body),
    });
  };

  const append = (text: string): void => {
    if (buffer.length === 0) bufferPath = currentPath();
    buffer = buffer.length === 0 ? text : `${buffer}\n${text}`;

    while (buffer.length > opts.maxChars) {
      const cut = findBreak(buffer, opts.targetChars, opts.maxChars);
      const head = buffer.slice(0, cut).trim();
      const tail = buffer.slice(cut);
      buffer = head;
      flush();
      // Seed the next chunk with a little of what just went out.
      const carry = overlapFrom(head, opts.overlapChars);
      buffer = carry ? `${carry} ${tail.trimStart()}` : tail.trimStart();
      bufferPath = currentPath();
    }
  };

  for (const block of page.blocks) {
    const text = block.text.trim();
    if (text.length === 0) continue;

    if (block.type === 'heading') {
      // Any heading closes the current chunk. Carrying a buffer across a
      // heading is what let content end up filed under the wrong section.
      // A section too small to deserve its own chunk gets folded back in
      // `flush`, which knows how to do it without lying about the path.
      if (buffer.trim().length > 0) flush();

      const level = clampLevel(block.level);
      headingStack[level] = text;
      headingStack.length = level + 1;
      bufferPath = currentPath();
      continue;
    }

    if (buffer.length > 0 && buffer.length + text.length > opts.targetChars) {
      flush();
      bufferPath = currentPath();
    }
    append(text);
  }
  flush();

  return chunks;
}

/** What actually gets embedded: title, heading path, then the body. */
function compose(title: string, path: string[], body: string): string {
  const heading = path.length > 0 ? ` › ${path.join(' › ')}` : '';
  return `${title}${heading}\n${body}`;
}

/**
 * The shared heading path of two chunks, when one section contains the other.
 * Returns the more general path, or null when the two are unrelated siblings.
 */
function commonPath(a: string[], b: string[]): string[] | null {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  for (let i = 0; i < short.length; i += 1) {
    if (short[i] !== long[i]) return null;
  }
  return short;
}

function clampLevel(level: number | undefined): number {
  if (typeof level !== 'number' || !Number.isFinite(level)) return 2;
  return Math.min(6, Math.max(1, Math.round(level)));
}

/**
 * Pick a cut point: the last sentence end inside the window, else the last word
 * boundary, else a hard cut. Splitting mid-sentence produces chunks that read
 * as gibberish when cited.
 */
function findBreak(text: string, target: number, max: number): number {
  const from = Math.max(1, Math.floor(target * 0.6));
  const window = text.slice(from, max);

  const sentence = lastIndexOfRegex(window, /[.!?…](?=[\s"'”’)\]]|$)/g);
  if (sentence >= 0) return from + sentence + 1;

  const newline = window.lastIndexOf('\n');
  if (newline >= 0) return from + newline;

  const space = window.lastIndexOf(' ');
  if (space >= 0) return from + space;

  return max;
}

/** The tail of a chunk, snapped forward to a sentence or word start. */
function overlapFrom(text: string, chars: number): string {
  if (chars <= 0 || text.length === 0) return '';
  const tail = text.slice(-chars);
  const sentence = lastIndexOfRegex(tail, /[.!?…]\s+/g);
  if (sentence >= 0) return tail.slice(sentence + 1).trim();
  const space = tail.indexOf(' ');
  return space >= 0 ? tail.slice(space + 1).trim() : tail.trim();
}

function lastIndexOfRegex(text: string, pattern: RegExp): number {
  let last = -1;
  for (const match of text.matchAll(pattern)) last = match.index;
  return last;
}

/** Convenience for tests and for the routing manifest. */
export function blocksFromText(text: string): Block[] {
  return text
    .split(/\n{2,}/)
    .map((t) => ({ type: 'text' as const, text: t.trim() }))
    .filter((b) => b.text.length > 0);
}
