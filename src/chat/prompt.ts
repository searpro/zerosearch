import type { Citation } from '../engine/protocol.js';

/**
 * Prompt construction for a strictly grounded answer.
 *
 * The model here is around 360M parameters. That shapes everything: short,
 * concrete, imperative instructions are followed far more reliably than long
 * nuanced ones, and anything resembling a discussion of edge cases invites the
 * model to write about edge cases instead of answering.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * A sentinel, not a phrase.
 *
 * Asking a small model to "say you don't know" produces a different wording
 * every time, none of which can be detected reliably. A fixed token can be, and
 * the UI renders the real refusal itself — so the user never sees this string.
 */
export const NOT_FOUND = 'NOT_FOUND';

export const SYSTEM_PROMPT = [
  'You answer questions about a website by quoting the numbered sources you are given.',
  'Answer in one or two sentences, using only facts from the sources.',
  'Put the source number in square brackets after each fact, like [1].',
  `Only if none of the sources mention the topic at all, reply with exactly ${NOT_FOUND}.`,
].join('\n');

/**
 * A worked example, prepended to every request.
 *
 * This is the single highest-leverage thing in the prompt. Measured on
 * SmolLM2-360M, instructions alone produced `NOT_FOUND` for questions the
 * sources plainly answered — the model reaches for the escape hatch rather
 * than judging whether the sources are sufficient. One demonstration of the
 * expected shape makes answering the default and fixes the citation format at
 * the same time.
 *
 * The refusal rule is also phrased as a narrow exception and placed last, so
 * it reads as the unusual case rather than the salient one.
 */
const EXAMPLE: ChatMessage[] = [
  {
    role: 'user',
    content: [
      'Sources:',
      '',
      '[1] Support — Acme › Hours',
      'Support is staffed Monday to Friday, 9am to 5pm UK time. Weekend cover is available on the Enterprise plan.',
      '',
      'Question: when is support available?',
    ].join('\n'),
  },
  {
    role: 'assistant',
    content: 'Support is staffed Monday to Friday, 9am to 5pm UK time [1].',
  },
];

export interface PackOptions {
  /** How many passages to show the model. */
  maxSources?: number;
  /** Total characters of source text. Small models lose the thread in long contexts. */
  maxChars?: number;
}

export interface PackedPrompt {
  messages: ChatMessage[];
  /** The citations actually included, in the order the model sees them. */
  sources: Citation[];
}

/**
 * Build the chat for one question.
 *
 * Sources are capped by both count and characters. A 360M model given eight
 * long passages tends to answer from whichever one it read last rather than
 * whichever one is relevant, so fewer and shorter is measurably better.
 */
export function buildPrompt(
  query: string,
  citations: readonly Citation[],
  { maxSources = 4, maxChars = 2400 }: PackOptions = {},
): PackedPrompt {
  const sources: Citation[] = [];
  let budget = maxChars;

  for (const citation of citations) {
    if (sources.length >= maxSources) break;
    const cost = citation.body.length;
    // Always take the best passage, even if it alone exceeds the budget —
    // returning no context at all would guarantee a refusal.
    if (sources.length > 0 && cost > budget) continue;
    sources.push(citation);
    budget -= cost;
  }

  const rendered = sources
    .map((citation, i) => {
      const heading = [citation.title, ...citation.headingPath].filter(Boolean).join(' > ');
      return `[${i + 1}] ${heading}\n${clamp(citation.body, 900)}`;
    })
    .join('\n\n');

  return {
    sources,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...EXAMPLE,
      { role: 'user', content: `Sources:\n\n${rendered}\n\nQuestion: ${query}` },
    ],
  };
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}
