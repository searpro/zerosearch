import type { Block, ExtractedPage } from './types.js';

/**
 * Progressive enrichment: turning a page we have actually fetched into a much
 * better routing entry than its URL slug ever was.
 *
 * Phase 1 left a known hole. Until a page is fetched, routing knows only its
 * slug, so `faq.html` and `about.html` are invisible to a question about
 * migration or headcount — the two words in the URL say nothing about either.
 * Once the page has been read, its title, description and headings are
 * available for free, and those describe it well.
 *
 * The plan called for an LLM-written summary here. It is not used, and the
 * reason is measured rather than aesthetic: the 360M model that Phase 2 shipped
 * states figures its sources contradict in 2 of 11 answers, generation is
 * available only on WebGPU and only when the visitor accepted a ~300MB
 * download, and a summary is *persisted* — so a hallucinated one poisons
 * routing for every later question on that device. Extraction has none of those
 * properties: it is free, works on every device, and cannot say anything the
 * page does not.
 */

/** Part of the cache key: changing what enrichment produces must re-enrich. */
export const ENRICHMENT_VERSION = 1;

/**
 * How much summary is worth keeping.
 *
 * The embedder truncates at 256 word-piece tokens, so text past roughly this
 * point is not read at all — storing more would cost IndexedDB space to change
 * nothing about the vector.
 */
export const MAX_SUMMARY_CHARS = 700;

/** Headings shorter than this are navigation furniture, not topics. */
const MIN_HEADING_CHARS = 3;

/** A lead sentence below this is a fragment; above it, a wall. */
const MIN_SENTENCE_CHARS = 20;
const MAX_SENTENCE_CHARS = 200;

/**
 * What a page is about, in the page's own words.
 *
 * Headings first, deliberately. They are the densest description of a page's
 * topics that exists — on an FAQ they are literally the questions visitors
 * ask — and they carry the vocabulary a question is most likely to share.
 * Lead prose fills whatever budget is left.
 */
export function summarizePage(page: Pick<ExtractedPage, 'blocks' | 'title'>): string {
  const parts: string[] = [];
  let budget = MAX_SUMMARY_CHARS;

  for (const heading of headingsOf(page.blocks, page.title)) {
    if (heading.length + 1 > budget) break;
    parts.push(heading);
    budget -= heading.length + 1;
  }

  for (const sentence of leadSentences(page.blocks)) {
    if (sentence.length + 1 > budget) break;
    parts.push(sentence);
    budget -= sentence.length + 1;
  }

  return parts.join(' ').trim();
}

/**
 * The headings on a page, deduplicated and stripped of the ones that only
 * repeat the title.
 */
export function headingsOf(blocks: readonly Block[], title = ''): string[] {
  const seen = new Set<string>([normalize(title)]);
  const out: string[] = [];

  for (const block of blocks) {
    if (block.type !== 'heading') continue;
    const text = block.text.trim();
    if (text.length < MIN_HEADING_CHARS) continue;

    const key = normalize(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * Questions the site itself poses.
 *
 * An FAQ's headings are already well-formed questions, so offering them back is
 * showing the visitor the site's own words rather than inventing plausible ones
 * — which is the same discipline the answers are held to.
 */
export function questionHeadings(blocks: readonly Block[]): string[] {
  return headingsOf(blocks).filter((heading) => heading.endsWith('?'));
}

/** The opening prose of a page, split into whole sentences. */
function leadSentences(blocks: readonly Block[]): string[] {
  const out: string[] = [];

  for (const block of blocks) {
    if (block.type !== 'text') continue;
    for (const sentence of splitSentences(block.text)) {
      if (sentence.length < MIN_SENTENCE_CHARS) continue;
      out.push(sentence.slice(0, MAX_SENTENCE_CHARS));
      // Three is enough to characterise a page; more and the summary starts
      // describing one section rather than the whole.
      if (out.length >= 3) return out;
    }
  }
  return out;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
