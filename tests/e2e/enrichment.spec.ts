import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { AskResult, BackfillResult, TopicsResult } from '../../src/engine/protocol.js';

/**
 * Phase 3, measured against the same golden set Phase 1 was.
 *
 * Two claims have to hold. Routing gets better after the site has been read
 * ahead — not "should", *measurably*, on the same questions and the same
 * thresholds. And a pass interrupted halfway loses nothing: the visitor who
 * closes the tab mid-crawl comes back to what had been read, and the next pass
 * continues rather than starting over.
 *
 * Real browser, real embedding model, real crawl of the demo site.
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

/** The demo sitemap. A full pass reads all of it. */
const SITE_PAGES = 13;

/** Model download plus two full crawls of the demo site. */
const BUDGET_MS = 240_000;

type Scored = { case: Case; result: AskResult; page: string | null };

const hitRate = (scored: Scored[]): number =>
  scored.filter((r) => r.page !== null && r.case.expect!.includes(r.page)).length / scored.length;

const hits = (scored: Scored[]): number =>
  scored.filter((r) => r.page !== null && r.case.expect!.includes(r.page)).length;

const report = (scored: Scored[]): string =>
  scored
    .filter((r) => !(r.page !== null && r.case.expect!.includes(r.page)))
    .map((m) => `  "${m.case.query}" -> ${m.page ?? 'nothing'} (want ${m.case.expect!.join(' | ')})`)
    .join('\n');

test.describe('progressive enrichment', () => {
  test.describe.configure({ mode: 'serial', timeout: BUDGET_MS });

  // Chromium only, for the same reason retrieval.spec is: the model download is
  // minutes, and paying it twice teaches us nothing new.
  test.skip(({ browserName }) => browserName !== 'chromium', 'model download is expensive');

  let page: import('@playwright/test').Page;
  let cold: Scored[] = [];
  let enriched: Scored[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    // Every pass in this suite is started explicitly, so the results say what
    // was read rather than what happened to have been read by the time we asked.
    await page.addInitScript(() => {
      (window as unknown as { ZeroSearchConfig: unknown }).ZeroSearchConfig = { enrich: 'never' };
    });
    await page.goto(`${DEMO}index.html`);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test('scores the golden set before anything is read ahead', async () => {
    await reset(page);
    cold = await runGoldenSet(page, cases);
    expect(cold).toHaveLength(cases.length);
  });

  test('reads the whole site in one bounded background pass', async () => {
    await reset(page);

    const result = await page.evaluate(
      async (budget) => (await (window as any).ZeroSearch.enrich({ budget })) as BackfillResult,
      SITE_PAGES + 5,
    );

    expect(result.completed).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.indexed).toBe(SITE_PAGES);
  });

  test('scores the same golden set once the site has been read', async () => {
    enriched = await runGoldenSet(page, cases);
    expect(enriched).toHaveLength(cases.length);
  });

  test('routing measurably improves', () => {
    const before = cold.filter((r) => r.case.expect !== null);
    const after = enriched.filter((r) => r.case.expect !== null);

    const detail = `cold ${hitRate(before).toFixed(2)} -> enriched ${hitRate(after).toFixed(2)}\nstill missing:\n${report(after)}`;

    // Printed on success too. The number is the point of this test, and a green
    // tick that hides it makes the next person guess at what enrichment bought.
    console.log(
      `\n  routing hit rate: cold ${hits(before)}/${before.length} -> enriched ${hits(after)}/${after.length}` +
        (report(after) ? `\n  still missing:\n${report(after)}` : ''),
    );

    // The claim Phase 3 exists to make good on. Not merely "no worse": the
    // pages Phase 1 named as unreachable — `faq.html`, `about.html` — are
    // reachable now, so this has to move.
    expect(hitRate(after), detail).toBeGreaterThan(hitRate(before));
    // A floor, and a strict one: with the whole site indexed there is no
    // routing luck left in this: every question's page is already in the index,
    // so the run is deterministic. Measured 10/12 cold, 12/12 enriched.
    expect(hitRate(after), detail).toBe(1);
    expect(answerable.length).toBeGreaterThan(0);
  });

  test('answers without fetching anything, because it already read the page', () => {
    for (const item of enriched) {
      expect(item.result.fetched, `"${item.case.query}" still had to fetch`).toEqual([]);
    }
  });

  test('still refuses what the site does not answer', () => {
    // Reading more of the site must not lower the bar. A larger index is more
    // chances for a mediocre passage to look like an answer.
    for (const item of enriched.filter((r) => r.case.expect === null)) {
      expect(item.result.grounded, `"${item.case.query}" cited ${item.page}`).toBe(false);
    }
  });

  test('every citation still clears the relevance floor', () => {
    for (const item of enriched) {
      for (const citation of item.result.citations) {
        expect(citation.dense, `"${item.case.query}" cited ${citation.url}`).toBeGreaterThanOrEqual(0.28);
      }
    }
  });

  test('resumes cleanly when a pass is interrupted by leaving the page', async () => {
    await reset(page);

    const first = await page.evaluate(
      async (budget) => (await (window as any).ZeroSearch.enrich({ budget })) as BackfillResult,
      4,
    );
    expect(first.indexed).toBe(4);
    expect(first.completed).toBe(false);

    // Leave and come back. Nothing was checkpointed on the way out; each page
    // was committed as it was read, which is what makes this survivable.
    await page.reload();
    const afterReload = await page.evaluate(async () => {
      await (window as any).ZeroSearch.prepare();
      return await (window as any).ZeroSearch.stats();
    });
    expect(afterReload.pages).toBe(4);

    const second = await page.evaluate(
      async (budget) => (await (window as any).ZeroSearch.enrich({ budget })) as BackfillResult,
      SITE_PAGES,
    );

    // It continued rather than starting over: the pages it read this time are
    // the ones it had not read before, and together they are the whole site.
    expect(second.indexed).toBe(SITE_PAGES - 4);
    expect(second.completed).toBe(true);

    const stats = await page.evaluate(async () => await (window as any).ZeroSearch.stats());
    expect(stats.pages).toBe(SITE_PAGES);
  });

  test('does nothing on a later visit once the site has been read', async () => {
    await page.reload();
    const requests: string[] = [];
    const listener = (request: import('@playwright/test').Request): void => {
      if (request.url().endsWith('.html')) requests.push(request.url());
    };
    page.on('request', listener);

    const result = await page.evaluate(async (budget) => {
      await (window as any).ZeroSearch.prepare();
      return (await (window as any).ZeroSearch.enrich({ budget })) as BackfillResult;
    }, SITE_PAGES);
    page.off('request', listener);

    expect(result.indexed).toBe(0);
    expect(result.completed).toBe(true);
    // Only the navigation itself. A returning visitor costs the origin nothing.
    expect(requests.filter((url) => !url.endsWith('/demo/index.html'))).toEqual([]);
  });

  test('offers topics from URL structure before any page is fetched', async () => {
    await reset(page);

    const topics = await page.evaluate(async () => {
      await (window as any).ZeroSearch.prepare();
      return (await (window as any).ZeroSearch.topics()) as TopicsResult;
    });

    expect(topics.total).toBe(SITE_PAGES);
    expect(topics.enriched).toBe(0);
    expect(topics.suggestions.length).toBeGreaterThan(0);
    expect(topics.tree.children.map((c) => c.label).sort()).toEqual(['Blog', 'Docs']);
  });

  test('sharpens topics into the site’s own questions once it has read them', async () => {
    await page.evaluate(async (budget) => await (window as any).ZeroSearch.enrich({ budget }), SITE_PAGES);

    const topics = await page.evaluate(async () => (await (window as any).ZeroSearch.topics()) as TopicsResult);

    expect(topics.enriched).toBe(SITE_PAGES);
    // Verbatim from the demo FAQ's own headings — not written by anything.
    expect(topics.suggestions.map((s) => s.text)).toContain('Can I migrate from Prometheus?');
  });

  test('shows those questions in the widget as something to click', async () => {
    await page.reload();

    const rendered = await page.evaluate(async () => {
      const api = (window as any).ZeroSearch;
      await api.boot();
      api.open();
      await api.prepare();
      api.widget.showTopics(await api.topics());
      await api.enrich({ budget: 1 });

      const root = api.widget.element.shadowRoot as ShadowRoot;
      return {
        chips: [...root.querySelectorAll('.topic-chip')].map((el) => el.textContent),
        status: root.querySelector('.status')?.textContent ?? '',
      };
    });

    expect(rendered.chips.length).toBeGreaterThan(0);
    expect(rendered.chips).toContain('Can I migrate from Prometheus?');
    // The site name is trimmed off every title, so the chips read as pages
    // rather than as thirteen copies of "— Meridian".
    expect(rendered.chips.join(' ')).not.toContain('— Meridian');
    // And the status settles rather than saying "Reading…" for the session.
    expect(rendered.status).toMatch(/pages indexed$/);
  });

  test('files pages under the site’s own sections, not our URL layout', async () => {
    const tree = await page.evaluate(async () => ((await (window as any).ZeroSearch.topics()) as TopicsResult).tree);

    // The demo is served from /demo/, which is a mount point rather than a
    // section. It must appear nowhere — not as a category, and not smuggled
    // back in as the breadcrumb fallback for pages that have no breadcrumb.
    const labels = tree.children.map((c) => c.label);
    expect(labels).toEqual(['Blog', 'Docs']);
    expect(tree.pages.length).toBeGreaterThan(0);
  });

  test('a cancelled pass stops and keeps what it had read', async () => {
    await reset(page);

    const result = await page.evaluate(async (budget) => {
      const api = (window as any).ZeroSearch;
      await api.prepare();
      const running = api.enrich({ budget }) as Promise<BackfillResult>;
      // Long enough for the pass to be under way, short enough that it cannot
      // have finished the site.
      await new Promise((r) => setTimeout(r, 400));
      await api.cancelEnrichment();
      const backfill = await running;
      return { backfill, stats: await api.stats() };
    }, SITE_PAGES);

    expect(result.backfill.completed).toBe(false);
    expect(result.backfill.remaining).toBeGreaterThan(0);
    expect(result.stats.pages).toBeLessThan(SITE_PAGES);
    // Whatever it managed to read is still there — cancelling discards nothing.
    expect(result.stats.pages).toBe(result.backfill.indexed);
  });
});

/** Start from an empty store, the way a first-time visitor does. */
async function reset(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    indexedDB.deleteDatabase('zerosearch');
    await new Promise((r) => setTimeout(r, 300));
  });
  await page.reload();
  await page.evaluate(async () => await (window as any).ZeroSearch.prepare());
}

async function runGoldenSet(
  page: import('@playwright/test').Page,
  list: Case[],
): Promise<Scored[]> {
  return await page.evaluate(async (items: Case[]) => {
    const out = [];
    for (const item of items) {
      const result = await (window as any).ZeroSearch.ask(item.query);
      const top = result.citations[0];
      out.push({
        case: item,
        result,
        page: top ? top.url.replace('http://localhost:5173/demo/', '') : null,
      });
    }
    return out;
  }, list);
}
