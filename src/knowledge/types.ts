/** A block of page content, in document order, with heading structure preserved. */
export interface Block {
  type: 'heading' | 'text';
  /** 1-6, headings only. */
  level?: number;
  text: string;
}

/** What main-thread extraction hands back to the worker for one page. */
export interface ExtractedPage {
  url: string;
  title: string;
  description: string | null;
  /** Derived from breadcrumbs or URL structure, never from a model. */
  category: string | null;
  blocks: Block[];
  /** Full plain text, used for the content hash and for lexical search. */
  text: string;
  /** Content hash over the extracted text. Drives revalidation. */
  hash: string;
  lang: string | null;
  fetchedAt: number;
  etag: string | null;
  lastModified: string | null;
}

/** One indexable unit: a slice of a page, carrying its heading context. */
export interface Chunk {
  id: string;
  url: string;
  index: number;
  headingPath: string[];
  /** Heading path + body. This is what gets embedded. */
  text: string;
  /** Body alone. This is what gets shown to a reader. */
  body: string;
}

/** One entry in the routing manifest, built from the sitemap without fetching. */
export interface ManifestEntry {
  url: string;
  /** Human-readable guess at the page title, derived from the URL slug. */
  slugTitle: string;
  /** Path segments, minus the filename. Used to build the category tree. */
  segments: string[];
  lastmod: string | null;
  priority: number | null;
}

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}
