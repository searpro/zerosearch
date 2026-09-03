import { NOT_FOUND } from './prompt.js';

/**
 * Post-processing for generated text.
 *
 * A small model produces three things that must not reach the user: reasoning
 * it was supposed to keep to itself, citation markers pointing at sources that
 * do not exist, and the refusal sentinel. This is the last gate before an
 * answer is shown, so it is deliberately conservative.
 */

export interface ProcessedAnswer {
  /** Display text, with invalid citation markers removed. */
  text: string;
  /** 1-based source numbers the model actually cited, in first-use order. */
  cited: number[];
  /** True when the model said the sources do not answer the question. */
  refused: boolean;
}

/** Qwen3 and friends emit a reasoning block that is not part of the answer. */
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
/** An unterminated block, which happens when generation hits the token limit. */
const OPEN_THINK = /<think>[\s\S]*$/i;

const CITATION = /\[(\d+)\]/g;

/** Numbers, with the separators and units people write them with. */
const NUMBER = /\d[\d,.]*/g;

/**
 * Reject an answer that states a figure not present in its sources.
 *
 * Measured on SmolLM2-360M: asked how many people work at the company, with a
 * source reading "We are 34 people", it answered "We are 19 people [2]" —
 * fluent, correctly formatted, correctly cited, and wrong. That is the most
 * damaging thing this can do, because everything about it looks right.
 *
 * The check is deliberately one-directional. Every number in a *faithful*
 * answer came from the sources, so this can never reject a correct answer; it
 * only catches invented ones. It does not catch a number lifted from the wrong
 * source, which is a real remaining gap — see the notes in the README.
 */
export function statesUnsupportedNumber(text: string, sources: string): boolean {
  const haystack = sources.replace(/[\s,]/g, '');

  for (const match of text.matchAll(NUMBER)) {
    const digits = match[0].replace(/[.,]+$/, '').replace(/[\s,]/g, '');
    // Single digits are usually prose ("in 1 or 2 sentences"), not claims.
    if (digits.length < 2) continue;
    if (!haystack.includes(digits)) return true;
  }
  return false;
}

export function processAnswer(raw: string, sourceCount: number): ProcessedAnswer {
  let text = raw.replace(THINK_BLOCK, '').replace(OPEN_THINK, '').trim();

  // The sentinel may arrive alone or wrapped in a sentence the model added
  // anyway; either way the answer is a refusal and nothing else is shown.
  if (text.includes(NOT_FOUND)) {
    return { text: '', cited: [], refused: true };
  }

  const cited: number[] = [];
  text = text.replace(CITATION, (match, digits: string) => {
    const index = Number(digits);
    // A marker pointing past the sources we supplied is invented. Dropping it
    // is the only safe option: it cannot be linked, and leaving it visible
    // implies evidence that was never there.
    if (!Number.isInteger(index) || index < 1 || index > sourceCount) return '';
    if (!cited.includes(index)) cited.push(index);
    return match;
  });

  text = tidy(text);

  // Generation that produced nothing usable is a refusal, not an empty answer.
  if (text.length === 0) return { text: '', cited: [], refused: true };

  return { text, cited, refused: false };
}

function tidy(text: string): string {
  return text
    // Space left behind by a removed marker.
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split text into runs and citation markers so the UI can render markers as
 * links without ever building HTML from model output.
 */
export type AnswerPart = { kind: 'text'; text: string } | { kind: 'citation'; index: number };

export function splitCitations(text: string, sourceCount: number): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(CITATION)) {
    const index = Number(match[1]);
    if (index < 1 || index > sourceCount) continue;

    const start = match.index;
    if (start > cursor) parts.push({ kind: 'text', text: text.slice(cursor, start) });
    parts.push({ kind: 'citation', index });
    cursor = start + match[0].length;
  }

  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) });
  return parts;
}
