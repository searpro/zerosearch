import { expect, test } from '@playwright/test';

// The widget lives in an open shadow root; Playwright pierces it automatically.
const BUBBLE = 'web-ai-root >> .bubble';
const PANEL = 'web-ai-root >> .panel';

test.beforeEach(async ({ page }) => {
  await page.goto('/demo/index.html');
});

test('boots from the script tag and installs the instance, not the namespace', async ({ page }) => {
  const api = await page.evaluate(() => {
    const w = (window as unknown as { WebAI?: Record<string, unknown> }).WebAI;
    return {
      type: typeof w,
      open: typeof w?.['open'],
      onEvent: typeof w?.['onEvent'],
      ask: typeof w?.['ask'],
      // A module namespace would carry the class and the default export here.
      // Asserting their absence pins the regression without depending on a
      // class name, which minification renames in the production build.
      namespaceClass: typeof w?.['WebAI'],
      namespaceDefault: typeof w?.['default'],
    };
  });

  expect(api.type).toBe('object');
  expect(api.open).toBe('function');
  expect(api.onEvent).toBe('function');
  expect(api.ask).toBe('function');
  expect(api.namespaceClass).toBe('undefined');
  expect(api.namespaceDefault).toBe('undefined');
});

test('resolves data-* config against the document base', async ({ page }) => {
  const config = await page.evaluate(() => (window as any).WebAI.config);
  expect(config.sitemapUrl).toBe('http://localhost:5173/demo/sitemap.xml');
  expect(config.maxTier).toBe('small');
  expect(config.debug).toBe(true);
});

test('mounts a closed widget into a shadow root', async ({ page }) => {
  await expect(page.locator(BUBBLE)).toBeVisible();
  await expect(page.locator(PANEL)).toBeHidden();
});

test('opens and closes on click', async ({ page }) => {
  await page.locator(BUBBLE).click();
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(BUBBLE)).toBeHidden();

  await page.locator('web-ai-root >> .close').click();
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator(BUBBLE)).toBeVisible();
});

test('closes on Escape', async ({ page }) => {
  await page.locator(BUBBLE).click();
  await expect(page.locator(PANEL)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toBeHidden();
});

test('emits open and close through the onEvent hook', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__events = [];
    (window as any).WebAI.onEvent((e: { type: string }) => (window as any).__events.push(e.type));
  });

  await page.locator(BUBBLE).click();
  await page.locator('web-ai-root >> .close').click();

  expect(await page.evaluate(() => (window as any).__events)).toEqual(['open', 'close']);
});

test('host page styles do not leak into the widget', async ({ page }) => {
  // A hostile-ish host rule that would wreck the widget if the shadow boundary
  // were not doing its job.
  await page.addStyleTag({ content: 'button { display: none !important; font-size: 60px; }' });
  await expect(page.locator(BUBBLE)).toBeVisible();
});

test('adds no console errors to the host page', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/demo/docs/api.html');
  await page.locator(BUBBLE).click();
  await expect(page.locator(PANEL)).toBeVisible();

  expect(errors).toEqual([]);
});
