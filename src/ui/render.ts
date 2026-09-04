import { splitCitations } from '../chat/answer.js';
import type { AskResult, Citation, GenerationStatus, Suggestion, TopicsResult } from '../engine/protocol.js';

/**
 * Turn rendering.
 *
 * Two shapes of answer. With a model loaded, prose with numbered citations and
 * the passages it was written from underneath. Without one — a device that did
 * not clear the WebGPU bar, or a visitor who declined the download — the
 * passages alone. The second is not a degraded placeholder for the first: it is
 * the evidence the first is constrained to, so both are honest answers.
 *
 * Everything is built with DOM calls rather than innerHTML. This text comes
 * from crawled pages and from a language model, and assembling markup out of
 * either would be an injection vector on the host's own site.
 */

export function userTurn(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'turn turn-user';
  el.textContent = text;
  return el;
}

export function pendingTurn(label = 'Searching this site…'): HTMLElement {
  const el = document.createElement('div');
  el.className = 'turn turn-pending';
  el.setAttribute('role', 'status');
  el.textContent = label;
  return el;
}

export function errorTurn(message: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'turn turn-error';
  el.textContent = message;
  return el;
}

/**
 * A turn that grows as tokens arrive.
 *
 * Replaced wholesale by `answerTurn` once generation finishes: citation markers
 * can only be linked when the source list is known, and half a marker is not
 * something to render.
 */
export function streamingTurn(): { element: HTMLElement; append: (text: string) => void } {
  const element = document.createElement('div');
  element.className = 'turn turn-answer turn-streaming';

  const paragraph = document.createElement('p');
  paragraph.className = 'answer-text';
  element.append(paragraph);

  return {
    element,
    append: (text: string) => {
      paragraph.append(document.createTextNode(text));
    },
  };
}

export function answerTurn(result: AskResult): HTMLElement {
  const el = document.createElement('div');
  el.className = 'turn turn-answer';

  if (!result.grounded) {
    el.append(notFound(result.suggestions));
    return el;
  }

  if (result.answer) {
    el.append(generated(result));
    el.append(sourceList(result.sources.length > 0 ? result.sources : result.citations, 'Sources'));
    return el;
  }

  const intro = document.createElement('p');
  intro.className = 'answer-intro';
  intro.textContent =
    result.citations.length === 1
      ? 'Found this on the site:'
      : `Found ${result.citations.length} relevant passages:`;
  el.append(intro);
  el.append(sourceList(result.citations, null));

  return el;
}

/** Prose with its citation markers turned into links. */
function generated(result: AskResult): HTMLElement {
  const paragraph = document.createElement('p');
  paragraph.className = 'answer-text';

  for (const part of splitCitations(result.answer ?? '', result.sources.length)) {
    if (part.kind === 'text') {
      paragraph.append(document.createTextNode(part.text));
      continue;
    }
    const source = result.sources[part.index - 1];
    if (!source) continue;

    const link = document.createElement('a');
    link.className = 'answer-cite';
    link.href = source.url;
    link.rel = 'noopener noreferrer';
    link.textContent = String(part.index);
    link.title = breadcrumb(source);
    paragraph.append(link);
  }

  return paragraph;
}

function sourceList(citations: readonly Citation[], label: string | null): HTMLElement {
  const wrap = document.createElement('div');

  if (label && citations.length > 0) {
    const heading = document.createElement('p');
    heading.className = 'answer-intro';
    heading.textContent = label;
    wrap.append(heading);
  }

  const list = document.createElement('ol');
  list.className = 'citations';
  for (const citation of citations) list.append(citationItem(citation));
  wrap.append(list);

  return wrap;
}

function citationItem(citation: Citation): HTMLElement {
  const item = document.createElement('li');
  item.className = 'citation';

  const link = document.createElement('a');
  link.className = 'citation-source';
  link.href = citation.url;
  // Crawled content decides this href, so deny it any access back to us.
  link.rel = 'noopener noreferrer';
  link.textContent = breadcrumb(citation);
  item.append(link);

  const body = document.createElement('p');
  body.className = 'citation-body';
  body.textContent = citation.body;
  item.append(body);

  return item;
}

function breadcrumb(citation: Citation): string {
  return [citation.title, ...citation.headingPath].filter(Boolean).join(' › ');
}

function notFound(suggestions: Suggestion[]): HTMLElement {
  const wrap = document.createElement('div');

  const message = document.createElement('p');
  message.className = 'answer-empty';
  // Strict grounding: saying nothing was found is the correct answer when
  // nothing cleared the relevance floor.
  message.textContent = "I couldn't find that on this site.";
  wrap.append(message);

  if (suggestions.length === 0) return wrap;

  const label = document.createElement('p');
  label.className = 'answer-intro';
  label.textContent = 'You might try:';
  wrap.append(label);

  const list = document.createElement('ul');
  list.className = 'suggestions';
  for (const suggestion of suggestions) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = suggestion.url;
    link.rel = 'noopener noreferrer';
    link.textContent = suggestion.title;
    item.append(link);
    list.append(item);
  }
  wrap.append(list);

  return wrap;
}

/**
 * The offer to load the generative model.
 *
 * The size is stated plainly and up front. A ~300MB download is a real cost to
 * a visitor, and burying it would be the kind of thing that makes people
 * distrust a widget they did not install.
 */
export function generationOffer(
  status: GenerationStatus,
  onEnable: () => void,
): HTMLElement | null {
  if (!status.available || status.enabled) return null;

  const bar = document.createElement('div');
  bar.className = 'offer';

  const text = document.createElement('span');
  text.className = 'offer-text';
  text.textContent = status.cached
    ? 'Written answers are ready to turn on.'
    : `Get written answers instead of passages · ${formatBytes(status.approxBytes)} download`;

  const button = document.createElement('button');
  button.className = 'offer-button';
  button.type = 'button';
  button.textContent = status.cached ? 'Turn on' : 'Download';
  button.addEventListener('click', onEnable);

  bar.append(text, button);
  return bar;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * "What can I ask?" — the opening state of an empty panel.
 *
 * A chat box on an unfamiliar site is a blank prompt with no clue what is
 * behind it, and a visitor who guesses wrong reads "I couldn't find that" and
 * concludes the assistant is useless rather than that they asked the wrong
 * question. Showing the site's own sections and its own questions makes the
 * first attempt likely to land.
 *
 * Every string here comes from the site: category names from its URL structure,
 * questions from its headings. Nothing is generated, so nothing here can offer
 * a question the site cannot answer.
 */
export function topicsIntro(
  topics: TopicsResult,
  onAsk: (query: string) => void,
): HTMLElement | null {
  if (topics.suggestions.length === 0) return null;

  const wrap = document.createElement('div');
  wrap.className = 'topics';

  const label = document.createElement('p');
  label.className = 'topics-label';
  label.textContent = 'You could ask about';
  wrap.append(label);

  const list = document.createElement('div');
  list.className = 'topic-chips';

  for (const suggestion of topics.suggestions) {
    const chip = document.createElement('button');
    chip.className = 'topic-chip';
    chip.type = 'button';
    chip.textContent = suggestion.text;
    // The category is context, not part of the question — a screen reader
    // reading six bare titles in a row has no idea what they belong to.
    chip.setAttribute('aria-label', `Ask about ${suggestion.text}, in ${suggestion.category}`);
    chip.addEventListener('click', () => onAsk(suggestion.text));
    list.append(chip);
  }

  wrap.append(list);
  return wrap;
}
