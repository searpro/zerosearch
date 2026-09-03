import type { AskResult, Citation, Suggestion } from '../engine/protocol.js';

/**
 * Turn rendering.
 *
 * Phase 1 has no language model, so an "answer" is the passages themselves,
 * each attributed to the section it came from. That is not a placeholder for
 * generation — it is the substrate generation will be constrained to, so what
 * is shown here is exactly what a later model will be allowed to say.
 *
 * Everything is built with DOM calls rather than innerHTML: this text comes
 * from crawled pages, and assembling markup from it would be an injection
 * vector on the host's own site.
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

export function answerTurn(result: AskResult): HTMLElement {
  const el = document.createElement('div');
  el.className = 'turn turn-answer';

  if (!result.grounded) {
    el.append(notFound(result.suggestions));
    return el;
  }

  const intro = document.createElement('p');
  intro.className = 'answer-intro';
  intro.textContent =
    result.citations.length === 1
      ? 'Found this on the site:'
      : `Found ${result.citations.length} relevant passages:`;
  el.append(intro);

  const list = document.createElement('ol');
  list.className = 'citations';
  for (const citation of result.citations) list.append(citationItem(citation));
  el.append(list);

  return el;
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
