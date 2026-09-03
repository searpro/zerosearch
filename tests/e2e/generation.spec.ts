import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { AskResult } from '../../src/engine/protocol.js';

/**
 * Answer quality, scored rather than eyeballed.
 *
 * The question this exists to settle is whether a browser-sized model is good
 * enough to summarise retrieved passages faithfully. Judging that by reading a
 * few answers is how you convince yourself of whatever you already believed, so
 * every case names the fact the answer must contain and — more importantly —
 * the figures that would prove it read the wrong passage.
 *
 * Opt-in: it downloads a ~400MB model. Run with WEBAI_TIER=small|standard.
 *   WEBAI_GEN=1 npx playwright test tests/e2e/generation.spec.ts --project=chromium
 */

interface Case {
  query: string;
  expect: string[] | null;
  answerMustContain?: string[];
  answerMatchAny?: boolean;
  answerMustNotContain?: string[];
}

const DEMO = 'http://localhost:5173/demo/';
const TIER = process.env['WEBAI_TIER'] ?? 'small';

const cases: Case[] = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../eval/queries.json'), 'utf8'),
).cases;

const scored = cases.filter((c) => c.answerMustContain);
const refusals = cases.filter((c) => c.expect === null);

interface Scored {
  case: Case;
  answer: string | null;
  verdict: 'correct' | 'wrong-figure' | 'missed-fact' | 'no-answer';
}

test.describe('generated answer quality', () => {
  test.describe.configure({ mode: 'serial', timeout: 600_000 });
  test.skip(!process.env['WEBAI_GEN'], 'set WEBAI_GEN=1 — this downloads a ~400MB model');


  let page: import('@playwright/test').Page;
  let results: Scored[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });
  test.afterAll(async () => {
    await page?.close();
  });

  test('index the site, load the model, and score every answer', async () => {
    await page.goto(`${DEMO}index.html?tier=${TIER}`);
    await page.evaluate(async (tier: string) => {
      indexedDB.deleteDatabase('web-ai');
      await new Promise((r) => setTimeout(r, 300));
      (window as any).__tier = tier;
    }, TIER);
    await page.reload();

    // Boot at the requested ceiling and load the model explicitly. The
    // `generate: 'auto'` path swallows its own errors by design — fine for a
    // widget, useless for a test that needs to know why nothing generated.
    const status = await page.evaluate(async (tier: string) => {
      const api = (window as any).WebAI;
      api.destroy();
      await api.boot({ maxTier: tier, generate: 'auto' });
      await api.prepare();
      return await api.enableGeneration();
    }, TIER);

    expect(status, 'generation status').toBeTruthy();
    expect(status.available, `tier ${TIER} reported unavailable: ${status?.reason}`).toBe(true);
    expect(status.enabled, 'model did not load').toBe(true);
    console.log(`\n[${TIER}] loaded ${status.modelLabel}`);

    await page.evaluate(async () => {
      for (const warm of [
        'pricing plans cost', 'rate limits quotas', 'authentication tokens rotate scopes',
        'prometheus migration questions', 'changelog version 3 breaking', 'about the company people',
        'columnar storage engine', 'api write query endpoints', 'contact support', 'quickstart',
      ]) {
        await (window as any).WebAI.ask(warm);
      }
    });

    const raw = await page.evaluate(async (list: Case[]) => {
      const out: { query: string; answer: string | null; grounded: boolean }[] = [];
      for (const item of list) {
        const result: AskResult = await (window as any).WebAI.ask(item.query);
        out.push({ query: item.query, answer: result.answer, grounded: result.grounded });
      }
      return out;
    }, cases);

    results = cases
      .filter((c) => c.answerMustContain)
      .map((item) => {
        const answer = raw.find((r) => r.query === item.query)?.answer ?? null;
        return { case: item, answer, verdict: judge(item, answer) };
      });

    const summary = results
      .map((r) => `  ${r.verdict.padEnd(13)} "${r.case.query}"\n      -> ${r.answer ?? '(no answer)'}`)
      .join('\n');
    const correct = results.filter((r) => r.verdict === 'correct').length;
    console.log(`\n[${TIER}] ${correct}/${results.length} correct\n${summary}\n`);

    // Recorded for the refusal test below.
    await page.evaluate((r) => ((window as any).__raw = r), raw);
    expect(results).toHaveLength(scored.length);
  });

  /**
   * A ratchet, not a target, and the number that matters most.
   *
   * These are answers that are fluent, correctly formatted, correctly cited,
   * and state a figure the sources contradict — the failure a reader is least
   * likely to catch, because everything else about it looks right. Two of
   * eleven do this today (a Team-plan limit reported as the Business one, and
   * an engineering headcount reported as the company's).
   *
   * The budget records where we are so it cannot quietly get worse. Lower it
   * when the number improves; never raise it to make a run pass.
   */
  test('states no more contradicted figures than the recorded budget', () => {
    const BUDGET = 2;
    const lying = results.filter((r) => r.verdict === 'wrong-figure');
    const detail = lying.map((r) => `  "${r.case.query}" -> ${r.answer}`).join('\n');
    expect(lying.length, `answers contradicting their sources:\n${detail}`).toBeLessThanOrEqual(BUDGET);
  });

  test('answers most questions correctly', () => {
    const correct = results.filter((r) => r.verdict === 'correct').length;
    const detail = results
      .filter((r) => r.verdict !== 'correct')
      .map((r) => `  ${r.verdict}: "${r.case.query}" -> ${r.answer ?? '(none)'}`)
      .join('\n');

    // Measured 8/11 on a warm index. A floor, not a target.
    expect(correct / results.length, `not correct:\n${detail}`).toBeGreaterThanOrEqual(0.7);
  });

  test('still refuses what the site does not answer', async () => {
    const raw: { query: string; grounded: boolean }[] = await page.evaluate(() => (window as any).__raw);
    for (const item of refusals) {
      expect(raw.find((r) => r.query === item.query)?.grounded, item.query).toBe(false);
    }
  });
});

function judge(item: Case, answer: string | null): Scored['verdict'] {
  if (!answer) return 'no-answer';
  const text = answer.toLowerCase();

  for (const banned of item.answerMustNotContain ?? []) {
    if (text.includes(banned.toLowerCase())) return 'wrong-figure';
  }

  const required = (item.answerMustContain ?? []).map((s) => s.toLowerCase());
  const hit = item.answerMatchAny
    ? required.some((needle) => text.includes(needle))
    : required.every((needle) => text.includes(needle));

  return hit ? 'correct' : 'missed-fact';
}
