import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /generation\.spec\.ts/ },
    /**
     * Generation only. Playwright's Chromium ships without WebGPU, so the
     * tier probe correctly reports it unavailable and nothing generates — the
     * flags below turn it on. Headed because macOS headless still does not
     * expose an adapter; this project is opt-in and slow regardless.
     */
    {
      name: 'webgpu',
      testMatch: /generation\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        headless: false,
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            '--use-angle=metal',
            '--disable-dawn-features=disallow_unsafe_apis',
          ],
        },
      },
    },
    // Safari has no WebGPU here and none of the Chromium-only capability
    // hints, which is exactly the environment the retrieval tier must survive.
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: /generation\.spec\.ts/ },
  ],
  webServer: {
    // Plain `vite`, not `npm run dev` — that script regenerates the demo pages
    // to load TypeScript source, which would undo `demo:dist` and quietly test
    // the dev path instead of what actually ships.
    command: 'npx vite',
    url: 'http://localhost:5173/demo/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
