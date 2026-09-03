import { describe, expect, it } from 'vitest';
import { processAnswer, splitCitations, statesUnsupportedNumber } from '../../src/chat/answer.js';
import { NOT_FOUND, SYSTEM_PROMPT, buildPrompt } from '../../src/chat/prompt.js';
import type { ChatMessage } from '../../src/chat/prompt.js';
import type { Citation } from '../../src/engine/protocol.js';

/** The real question is the last message; a worked example precedes it. */
const question = (messages: ChatMessage[]): string => messages[messages.length - 1]!.content;

const cite = (n: number, body: string, overrides: Partial<Citation> = {}): Citation => ({
  chunkId: `c${n}`,
  url: `https://x.example/p${n}`,
  title: `Page ${n}`,
  headingPath: [`Section ${n}`],
  body,
  score: 1 / n,
  dense: 0.5,
  ...overrides,
});

describe('buildPrompt', () => {
  it('numbers sources and includes their heading path', () => {
    const { messages, sources } = buildPrompt('how much is team', [
      cite(1, 'Team costs $49 per month.'),
      cite(2, 'Business costs $400 per month.'),
    ]);

    expect(sources).toHaveLength(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe(SYSTEM_PROMPT);

    const user = question(messages);
    expect(user).toContain('[1] Page 1 > Section 1');
    expect(user).toContain('Team costs $49 per month.');
    expect(user).toContain('[2] Page 2 > Section 2');
    expect(user).toContain('Question: how much is team');
  });

  it('tells the model exactly what to say when the sources do not answer', () => {
    // A fixed sentinel is detectable; "say you do not know" is not.
    expect(SYSTEM_PROMPT).toContain(NOT_FOUND);
  });

  it('caps the number of sources', () => {
    const many = Array.from({ length: 10 }, (_, i) => cite(i + 1, `Body ${i}.`));
    expect(buildPrompt('q', many, { maxSources: 3 }).sources).toHaveLength(3);
  });

  it('caps total context length', () => {
    const long = Array.from({ length: 5 }, (_, i) => cite(i + 1, 'x'.repeat(700)));
    const { sources } = buildPrompt('q', long, { maxSources: 10, maxChars: 1500 });
    expect(sources.length).toBeLessThan(5);
  });

  it('always includes the best passage even when it alone busts the budget', () => {
    // Returning no context at all would guarantee a refusal for a question we
    // actually have an answer to.
    const { sources } = buildPrompt('q', [cite(1, 'y'.repeat(5000))], { maxChars: 100 });
    expect(sources).toHaveLength(1);
  });

  it('truncates a very long passage rather than dropping it', () => {
    const { messages } = buildPrompt('q', [cite(1, 'z'.repeat(4000))]);
    expect(question(messages)).toContain('…');
    expect(question(messages).length).toBeLessThan(2000);
  });

  it('handles having no sources at all', () => {
    const { messages, sources } = buildPrompt('q', []);
    expect(sources).toEqual([]);
    expect(question(messages)).toContain('Question: q');
  });

  it('shows the model a worked example before the real question', () => {
    // Instructions alone made SmolLM2-360M reach for NOT_FOUND on questions the
    // sources plainly answered. One demonstration makes answering the default.
    const { messages } = buildPrompt('how much?', [cite(1, 'It costs $49.')]);

    expect(messages[0]!.role).toBe('system');
    expect(messages.some((m) => m.role === 'assistant')).toBe(true);

    const demo = messages.find((m) => m.role === 'assistant')!;
    // The example demonstrates the citation format it is being asked for.
    expect(demo.content).toMatch(/\[1\]/);
    expect(messages[messages.length - 1]!.role).toBe('user');
  });
});

describe('processAnswer', () => {
  it('keeps a clean answer and records its citations', () => {
    const result = processAnswer('The Team plan is $49 per month [1]. It includes 3 nodes [2].', 2);
    expect(result.refused).toBe(false);
    expect(result.cited).toEqual([1, 2]);
    expect(result.text).toContain('$49 per month [1]');
  });

  it('treats the sentinel as a refusal', () => {
    expect(processAnswer(NOT_FOUND, 3)).toMatchObject({ refused: true, text: '' });
    // Some models wrap it in a sentence anyway.
    expect(processAnswer(`I think ${NOT_FOUND}.`, 3).refused).toBe(true);
  });

  it('strips a reasoning block', () => {
    const result = processAnswer('<think>Let me check the sources.</think>The answer is $49 [1].', 1);
    expect(result.text).toBe('The answer is $49 [1].');
    expect(result.text).not.toContain('think');
  });

  it('strips an unterminated reasoning block, which happens at the token limit', () => {
    const result = processAnswer('<think>I should consider whether', 1);
    expect(result.refused).toBe(true);
  });

  it('removes a citation marker pointing at a source that does not exist', () => {
    // An invented marker cannot be linked, and leaving it visible implies
    // evidence that was never supplied.
    const result = processAnswer('It costs $49 [1] and includes support [7].', 2);
    expect(result.text).not.toContain('[7]');
    expect(result.text).toContain('[1]');
    expect(result.cited).toEqual([1]);
  });

  it('tidies the space left by a removed marker', () => {
    const result = processAnswer('It costs $49 [9].', 1);
    expect(result.text).toBe('It costs $49.');
  });

  it('does not double-count a repeated citation', () => {
    expect(processAnswer('A [1]. B [1]. C [2].', 2).cited).toEqual([1, 2]);
  });

  it('treats empty generation as a refusal rather than an empty answer', () => {
    expect(processAnswer('   \n  ', 2).refused).toBe(true);
    expect(processAnswer('', 2).refused).toBe(true);
  });

  it('accepts an answer with no citations at all', () => {
    // Uncited but non-empty: the passages are still shown alongside, so the
    // reader can check it. Discarding it would lose correct answers.
    const result = processAnswer('The Team plan costs $49 per month.', 2);
    expect(result.refused).toBe(false);
    expect(result.cited).toEqual([]);
  });
});

describe('splitCitations', () => {
  it('splits text and markers in order', () => {
    expect(splitCitations('A [1] B [2].', 2)).toEqual([
      { kind: 'text', text: 'A ' },
      { kind: 'citation', index: 1 },
      { kind: 'text', text: ' B ' },
      { kind: 'citation', index: 2 },
      { kind: 'text', text: '.' },
    ]);
  });

  it('leaves an out-of-range marker as plain text', () => {
    const parts = splitCitations('A [9].', 2);
    expect(parts).toEqual([{ kind: 'text', text: 'A [9].' }]);
  });

  it('handles text with no markers', () => {
    expect(splitCitations('Just words.', 3)).toEqual([{ kind: 'text', text: 'Just words.' }]);
  });

  it('handles an empty string', () => {
    expect(splitCitations('', 3)).toEqual([]);
  });
});

describe('statesUnsupportedNumber', () => {
  const sources = 'We are 34 people across 11 countries. The team plan costs $49 per month.';

  it('accepts figures that appear in the sources', () => {
    expect(statesUnsupportedNumber('There are 34 people [1].', sources)).toBe(false);
    expect(statesUnsupportedNumber('It costs $49 per month [1].', sources)).toBe(false);
  });

  it('rejects a figure the sources never state', () => {
    // The measured failure: the source said 34, the model wrote 19.
    expect(statesUnsupportedNumber('We are 19 people [2].', sources)).toBe(true);
  });

  it('ignores separators, so 10,000 matches 10000', () => {
    expect(statesUnsupportedNumber('Up to 10,000 requests.', 'caps at 10000 requests')).toBe(false);
    expect(statesUnsupportedNumber('Up to 10000 requests.', 'caps at 10,000 requests')).toBe(false);
  });

  it('ignores trailing punctuation', () => {
    expect(statesUnsupportedNumber('It costs 49.', 'the price is 49 dollars')).toBe(false);
  });

  it('lets single digits through, since they are usually prose', () => {
    expect(statesUnsupportedNumber('There are 3 ways to do this.', sources)).toBe(false);
  });

  it('never rejects an answer with no figures at all', () => {
    expect(statesUnsupportedNumber('Support is available on weekdays.', sources)).toBe(false);
    expect(statesUnsupportedNumber('', sources)).toBe(false);
  });
});
