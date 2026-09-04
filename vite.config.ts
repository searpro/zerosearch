import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const r = (p: string) => resolve(here, p);

/**
 * Three build targets, each with a different job:
 *
 *  - `main`   -> `zerosearch.js`, the IIFE a site puts in a <script> tag. Config,
 *                events, the widget shell and DOM extraction. No ML code, so it
 *                stays inside the size budget and costs a page view almost
 *                nothing. Exports nothing: Vite assigns an IIFE's module
 *                namespace to the global, which would clobber `window.ZeroSearch`.
 *  - `lib`    -> `zerosearch.mjs`, the ESM build for npm consumers. Same code, but
 *                keeps its named exports and installs no global of its own.
 *  - `worker` -> `zerosearch.worker.js`, the heavy chunk bundling transformers.js.
 *                Fetched lazily, once per browser, only when actually needed.
 *
 * The split is what keeps the main bundle small: an IIFE cannot code-split, so
 * a lazily-imported dependency living in the same bundle is simply inlined.
 */
const targets = {
  main: {
    entry: r('src/script-entry.ts'),
    formats: ['iife'] as const,
    fileName: () => 'zerosearch.js',
    name: 'ZeroSearchScript',
    empty: true,
  },
  lib: {
    entry: r('src/index.ts'),
    formats: ['es'] as const,
    fileName: () => 'zerosearch.mjs',
    name: 'ZeroSearch',
    empty: false,
  },
  // ES module, not IIFE. An IIFE cannot code-split, so Rollup inlines every
  // asset reached through `new URL(..., import.meta.url)` — which for the ONNX
  // runtime means base64-encoding its .wasm binaries straight into the bundle
  // and turning a ~2MB worker into a 63MB one. As a module the wasm stays a
  // separate file the runtime fetches only when it actually needs it.
  worker: {
    entry: r('src/worker/worker.ts'),
    formats: ['es'] as const,
    fileName: () => 'zerosearch.worker.js',
    name: 'ZeroSearchWorker',
    empty: false,
  },
};

export default defineConfig(({ mode }) => {
  const target = targets[mode as keyof typeof targets] ?? targets.main;

  return {
    root: here,
    server: { open: '/demo/index.html', port: 5173 },
    build: {
      emptyOutDir: target.empty,
      target: 'es2022',
      lib: {
        entry: target.entry,
        name: target.name,
        formats: [...target.formats],
        fileName: target.fileName,
      },
    },
    test: {
      environment: 'jsdom',
      include: ['tests/unit/**/*.test.ts'],
      globals: false,
    },
  };
});
