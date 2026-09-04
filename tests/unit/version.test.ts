import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../../src/index.js';

/**
 * The version exists in two places — `package.json`, which npm publishes, and
 * the `VERSION` constant the library exports as `ZeroSearch.version`. A site
 * reporting a bug quotes the second one, so the two drifting apart sends
 * whoever reads the report to the wrong source revision.
 *
 * Resolved from the Vitest root rather than `import.meta.url`: these run under
 * jsdom, where `import.meta.url` is an http: URL that `readFileSync` refuses.
 */
describe('VERSION', () => {
  it('matches the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
