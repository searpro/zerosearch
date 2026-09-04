import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { AskResult } from '../../src/engine/protocol.js';

/**
 * Retrieval quality, measured rather than asserted.
 *
 * This has to run in a real browser: it downloads an actual embedding model and
 * crawls the actual demo site. It is slow and it is the only test that tells us
 * whether any of the rest is worth anything.
 *
 * The thresholds are floors, not targets. They exist to catch regressions —
 * raise them when quality improves, never lower them to make a run pass.
 */

interface Case {
  query: string;
  expect: string[] | null;
  note?: string;
}

const DEMO = 'http://localhost:5173/demo/';
const cases: Case[] = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../eval/queries.json'), 'utf8'),
).cases;

const answerable = cases.filter((c) => c.expect !== null);
const unanswerable = cases.filter((c) => c.expect === null);

/** Model download plus a full crawl of the demo site. */
const BUDGET_MS = 180_000;

test.describe('retrieval quality', () => {
  test.describe.configure({ mode: 'serial', timeout: BUDGET_MS });

  // Chromium only: this is about retrieval, and paying the model download twice
  // to learn the same thing is not worth the minutes.
  test.skip(({ browserName }) => browserName !== 'chromium', 'model download is expensive');

  let results: { case: Case; result: AskResult; page: string | null }[] = [];
  // One page for the whole describe: the index is built once and the later
  // tests assert against that same warm state. Playwright's per-test `page`
  // fixture would hand each test a blank tab with no engine on it.
  let page: import('@playwright/test').Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    // This suite measures cold, just-in-time routing: what a visitor gets from
    // their very first question, before anything has been read ahead. Phase 3's
    // background pass would otherwise index the site underneath the run and
    // turn a floor into a coin toss.
    await page.addInitScript(() => {
      (window as unknown as { WebAIConfig: unknown }).WebAIConfig = { enrich: 'never' };
    });
  });

  test.afterAll(async () => {
    // afterAll still runs when every test in the describe was skipped, and
    // beforeAll did not run to create the page.
    await page?.close();
  });

  test('index the site and run the golden set', async () => {
    page.on('pageerror', (error) => {
      throw new Error(`page error during indexing: ${error.message}`);
    });

    await page.goto(`${DEMO}index.html`);
    // Start from nothing so this measures a genuine cold visitor.
    await page.evaluate(async () => {
      indexedDB.deleteDatabase('web-ai');
      await new Promise((r) => setTimeout(r, 300));
    });
    await page.reload();

    await page.evaluate(() => (window as any).WebAI.prepare());

    results = await page.evaluate(async (list: Case[]) => {
      const out = [];
      for (const item of list) {
        const result = await (window as any).WebAI.ask(item.query);
        const top = result.citations[0];
        out.push({
          case: item,
          result,
          page: top ? top.url.replace('http://localhost:5173/demo/', '') : null,
        });
      }
      return out;
    }, cases);

    expect(results).toHaveLength(cases.length);
  });

  test('never answers a question the site does not cover', () => {
    // The most important property here. A strictly grounded assistant that
    // invents an answer is worse than one that finds nothing.
    for (const item of results.filter((r) => r.case.expect === null)) {
      expect(
        item.result.grounded,
        `"${item.case.query}" should have been refused but cited ${item.page}`,
      ).toBe(false);
      expect(item.result.citations).toHaveLength(0);
    }
    expect(unanswerable.length).toBeGreaterThan(0);
  });

  test('offers suggestions when it cannot answer', () => {
    for (const item of results.filter((r) => r.case.expect === null)) {
      expect(item.result.suggestions.length).toBeGreaterThan(0);
    }
  });

  test('cites the right page for most answerable questions', () => {
    const scored = results.filter((r) => r.case.expect !== null);
    const hits = scored.filter((r) => r.page !== null && r.case.expect!.includes(r.page));
    const misses = scored.filter((r) => !(r.page !== null && r.case.expect!.includes(r.page)));

    const report = misses
      .map((m) => `  "${m.case.query}" -> ${m.page ?? 'nothing'} (want ${m.case.expect!.join(' | ')})`)
      .join('\n');

    // A floor, not a target, and specifically the floor for a cold first
    // question. Routing works from URL slugs until a page has been fetched, so
    // pages whose slug does not describe them are reached late. `enrichment.spec`
    // measures what the background pass does to this same set.
    expect(hits.length / scored.length, `misses:\n${report}`).toBeGreaterThanOrEqual(0.75);
    expect(answerable.length).toBeGreaterThan(0);
  });

  test('every citation it does return clears the relevance floor', () => {
    for (const item of results) {
      for (const citation of item.result.citations) {
        // Per-passage filtering: one strong hit must not drag weak ones along.
        expect(
          citation.dense,
          `"${item.case.query}" cited ${citation.url} at ${citation.dense}`,
        ).toBeGreaterThanOrEqual(0.28);
      }
    }
  });

  test('answers from a warm index without further fetching', async () => {
    // Second time round, everything needed is already in IndexedDB.
    const warm = await page.evaluate(async () => {
      const started = performance.now();
      const result = await (window as any).WebAI.ask('how much does the team plan cost');
      return { ms: performance.now() - started, fetched: result.fetched.length, grounded: result.grounded };
    });

    expect(warm.grounded).toBe(true);
    expect(warm.fetched).toBe(0);
    expect(warm.ms).toBeLessThan(1000);
  });

  test('knowledge survives a reload', async () => {
    await page.reload();
    const stats = await page.evaluate(async () => {
      await (window as any).WebAI.prepare();
      return await (window as any).WebAI.stats();
    });

    expect(stats.pages).toBeGreaterThan(0);
    expect(stats.chunks).toBeGreaterThan(0);
    expect(stats.embedderId).toBe('Xenova/all-MiniLM-L6-v2@q8');
  });
});
