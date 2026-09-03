/**
 * Enforces the bundle budgets from the plan. The main bundle is the number that
 * matters: it lands on every page view of every site that embeds us.
 */
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BUDGETS = [{ file: 'dist/web-ai.js', maxBrotli: 30 * 1024, label: 'main (script tag)' }];

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

let failed = false;
for (const { file, maxBrotli, label } of BUDGETS) {
  let raw;
  try {
    raw = await readFile(join(process.cwd(), file));
  } catch {
    console.error(`✗ ${file} — not built`);
    failed = true;
    continue;
  }
  const br = brotliCompressSync(raw).length;
  const gz = gzipSync(raw).length;
  const ok = br <= maxBrotli;
  failed ||= !ok;
  console.log(
    `${ok ? '✓' : '✗'} ${label.padEnd(20)} ${kb(raw.length).padStart(9)} raw ${kb(gz).padStart(9)} gzip ` +
      `${kb(br).padStart(9)} brotli  (budget ${kb(maxBrotli)} brotli)`,
  );
}

// Reported, not budgeted: fetched lazily, once per browser.
try {
  const raw = await readFile(join(process.cwd(), 'dist/web-ai.worker.js'));
  console.log(
    `  ${'worker (lazy)'.padEnd(20)} ${kb(raw.length).padStart(9)} raw ${kb(gzipSync(raw).length).padStart(9)} gzip ` +
      `${kb(brotliCompressSync(raw).length).padStart(9)} brotli`,
  );
} catch {}

process.exit(failed ? 1 : 0);
