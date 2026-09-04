/**
 * The category tree, derived from structure rather than from a model.
 *
 * URL hierarchy, breadcrumbs and titles already encode how a site is organised,
 * and they encode it correctly — which a 360M model asked to invent categories
 * would not. This is also free, so it is available on a retrieval-only device
 * and on the very first visit, before anything has been fetched.
 *
 * What it powers: the "what can I ask?" affordance. A visitor who opens a chat
 * widget on an unfamiliar site has no idea what it knows, and an empty box is
 * the worst possible prompt.
 */

/** The shape this module needs from a manifest entry. Deliberately minimal. */
export interface CategoryInput {
  url: string;
  /** Real page title once fetched, the slug guess before that. */
  slugTitle: string;
  /** Path segments minus the filename. */
  segments: string[];
  /** Breadcrumb category, when the page has been fetched and had one. */
  category?: string | null;
  /** Verbatim interrogative headings found on the page. */
  questions?: string[];
  priority?: number | null;
}

export interface CategoryNode {
  /** Slash-joined segment path. `''` is the root. Stable enough to be a key. */
  path: string;
  label: string;
  /** Pages filed directly under this node, most prominent first. */
  pages: { url: string; title: string }[];
  children: CategoryNode[];
}

/** One thing a visitor could ask, in the site’s own words. */
export interface SuggestedQuestion {
  text: string;
  url: string;
  /** Which category it came from, so the UI can group without re-walking. */
  category: string;
}

export function buildCategoryTree(entries: readonly CategoryInput[]): CategoryNode {
  const root: CategoryNode = { path: '', label: 'Site', pages: [], children: [] };
  if (entries.length === 0) return root;

  // Every page on a site served from a subdirectory shares that directory. It
  // is the mount point, not a category, and showing "Demo › Docs" to a visitor
  // would be describing our own URL layout back at them.
  const shared = commonPrefix(entries.map((e) => e.segments));

  const mount = entries[0]!.segments.slice(0, shared).map(humanize);
  const shorten = titleShortener(entries.map((e) => e.slugTitle));

  for (const entry of entries) {
    const path = categoryPath(entry, shared, mount);
    const node = ensurePath(root, path);
    node.pages.push({ url: entry.url, title: pageTitle(entry, mount, shorten) });
  }

  sortTree(root, new Map(entries.map((e) => [e.url, e.priority ?? 0])));
  return root;
}

/**
 * Flatten the tree into the categories worth showing.
 *
 * A category holding one page is not a category, it is that page — so those are
 * folded into their parent rather than rendered as a heading with a single item
 * under it.
 */
export function topCategories(root: CategoryNode, limit = 6): CategoryNode[] {
  const out: CategoryNode[] = [];

  const walk = (node: CategoryNode): void => {
    if (node.pages.length > 0) out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  if (root.pages.length > 0) out.unshift(root);

  return out.sort((a, b) => b.pages.length - a.pages.length).slice(0, limit);
}

/**
 * Things to offer a visitor who does not know what to ask.
 *
 * Interrogative headings win: an FAQ's `<h2>` is already the question someone
 * would type, and offering it back is quoting the site rather than inventing a
 * question it might not answer. Page titles fill in behind them — spread across
 * categories, so the list describes the site's breadth instead of six variations
 * on whichever section happens to be largest.
 */
export function suggestQuestions(
  entries: readonly CategoryInput[],
  root: CategoryNode,
  limit = 6,
): SuggestedQuestion[] {
  const categoryOf = new Map<string, string>();
  const walk = (node: CategoryNode): void => {
    for (const page of node.pages) categoryOf.set(page.url, node.label);
    for (const child of node.children) walk(child);
  };
  walk(root);

  const out: SuggestedQuestion[] = [];
  const seen = new Set<string>();

  const take = (text: string, url: string): void => {
    const key = text.toLowerCase();
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push({ text, url, category: categoryOf.get(url) ?? 'Site' });
  };

  // One question per page before a second from any page, so a single
  // exhaustively-headed FAQ cannot fill the whole list on its own.
  //
  // Indexed in step with `entries`, deliberately: filtering out the pages that
  // pose no questions would renumber the rest, and each question would then be
  // attributed to whichever page happened to land at its index.
  const questionsOf = entries.map((entry) => entry.questions ?? []);
  const deepest = Math.min(3, Math.max(0, ...questionsOf.map((q) => q.length)));

  for (let depth = 0; out.length < limit && depth < deepest; depth += 1) {
    entries.forEach((entry, i) => {
      const question = questionsOf[i]?.[depth];
      if (question) take(question, entry.url);
    });
  }

  // Round-robin across categories rather than draining one.
  const buckets = topCategories(root, 12).map((node) => node.pages);
  for (let i = 0; out.length < limit && i < 4; i += 1) {
    for (const pages of buckets) {
      const page = pages[i];
      if (page) take(page.title, page.url);
    }
  }

  return out;
}

/**
 * What to call a page we may not have read yet.
 *
 * An index page takes its slug title from the directory containing it, which is
 * right for `/docs/` and wrong for the directory the whole site is mounted in:
 * a project site at `/demo/` would offer "Demo" as something to ask about,
 * which describes our URL layout rather than anything on the page. Enrichment
 * replaces this with the real title the moment the page is read.
 */
function pageTitle(entry: CategoryInput, mount: readonly string[], shorten: Shortener): string {
  if (mount.includes(entry.slugTitle) && isIndexUrl(entry.url)) return 'Home';
  return shorten(entry.slugTitle);
}

type Shortener = (title: string) => string;

const TITLE_SEPARATOR = /\s+[—–|·]\s+|\s+-\s+/;

/**
 * Drop the site name that almost every `<title>` carries.
 *
 * "Pricing — Meridian", "Changelog — Meridian", "About — Meridian": as a row of
 * chips those are three copies of the site name, and under a truncating width
 * they can degrade to being *only* that. The distinguishing half is what a
 * visitor needs.
 *
 * Which half that is has to be decided from the whole set rather than per
 * title, because both conventions exist. Whichever end repeats across pages is
 * the site name; the other end is the page. With nothing repeating there is no
 * site name to drop and titles are left alone.
 *
 * This only ever shortens — the result is a span of the site's own title — which
 * is what allows these to be offered as questions at all.
 */
export function titleShortener(titles: readonly string[]): Shortener {
  const multi = titles.map(splitTitle).filter((parts) => parts.length > 1);
  if (multi.length < 2) return (title) => title.trim();

  // Compare the *first word* of each end rather than the whole segment. A site
  // rarely writes its name identically everywhere — "… — Meridian",
  // "… — Meridian docs", "… — Meridian blog" are one site name, and an
  // exact-match count sees three unrelated suffixes and gives up.
  const leadRepeats = (pick: (parts: string[]) => string): boolean => {
    const counts = new Map<string, number>();
    for (const parts of multi) {
      const lead = firstWord(pick(parts));
      if (lead) counts.set(lead, (counts.get(lead) ?? 0) + 1);
    }
    return counts.size > 0 && Math.max(...counts.values()) > multi.length / 2;
  };

  // Tail first: "Page — Site" is by far the more common convention.
  const keep: ((parts: string[]) => string) | null = leadRepeats((p) => p[p.length - 1]!)
    ? (parts) => parts.slice(0, -1).join(' — ')
    : leadRepeats((p) => p[0]!)
      ? (parts) => parts.slice(1).join(' — ')
      : null;

  // Nothing repeats at either end, so there is no site name to drop and every
  // part of the title is telling us something.
  if (!keep) return (title) => title.trim();

  return (title) => {
    const parts = splitTitle(title);
    const kept = parts.length > 1 ? keep(parts) : title.trim();
    return kept.length > 0 ? kept : title.trim();
  };
}

function splitTitle(title: string): string[] {
  return title.split(TITLE_SEPARATOR).map((part) => part.trim()).filter(Boolean);
}

function firstWord(segment: string): string {
  return segment.split(/\s+/)[0]?.toLowerCase() ?? '';
}

function isIndexUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return path.endsWith('/') || /\/index\.[a-z0-9]+$/i.test(path);
  } catch {
    return false;
  }
}

/** Where an entry belongs: its breadcrumb if it has one, else its URL path. */
function categoryPath(entry: CategoryInput, shared: number, mount: readonly string[]): string[] {
  const segments = entry.segments.slice(shared);
  if (segments.length > 0) return segments;

  // A breadcrumb can file a top-level page under a section its URL does not
  // mention, which is exactly the case URL structure alone gets wrong.
  //
  // But extraction falls back to the URL's first path segment when a page has
  // no breadcrumb, and for a site mounted in a subdirectory that segment is the
  // mount point — the very thing just stripped. Letting it back in here files
  // every root page under a category named after our own URL layout.
  if (!entry.category) return [];
  const slug = slugify(entry.category);
  return mount.includes(humanize(slug)) ? [] : [slug];
}

function ensurePath(root: CategoryNode, segments: string[]): CategoryNode {
  let node = root;
  for (const segment of segments) {
    const path = node.path ? `${node.path}/${segment}` : segment;
    let child = node.children.find((c) => c.path === path);
    if (!child) {
      child = { path, label: humanize(segment), pages: [], children: [] };
      node.children.push(child);
    }
    node = child;
  }
  return node;
}

function sortTree(node: CategoryNode, priority: Map<string, number>): void {
  node.pages.sort((a, b) => (priority.get(b.url) ?? 0) - (priority.get(a.url) ?? 0));
  node.children.sort((a, b) => a.label.localeCompare(b.label));
  for (const child of node.children) sortTree(child, priority);
}

/**
 * How many leading segments every page shares.
 *
 * Consuming all of them is intended. A site served from `/demo/` has `demo` on
 * every URL, and its real top level is what comes after; if every page lives
 * under `/docs/` then `docs` is not a category either, because it distinguishes
 * nothing.
 */
function commonPrefix(paths: readonly string[][]): number {
  if (paths.length < 2) return 0;

  const shortest = Math.min(...paths.map((p) => p.length));
  let shared = 0;
  while (shared < shortest && paths.every((p) => p[shared] === paths[0]![shared])) {
    shared += 1;
  }
  return shared;
}

function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '-');
}

function humanize(slug: string): string {
  const words = slug.split(/[-_\s]+/).filter((w) => w.length > 0);
  if (words.length === 0) return 'Site';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
