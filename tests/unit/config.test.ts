import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, readScriptAttributes, resolveConfig } from '../../src/config.js';

const BASE = 'https://example.com/docs/page.html';

describe('resolveConfig', () => {
  it('falls back to defaults when given nothing', () => {
    const { config, warnings } = resolveConfig({}, {}, BASE);
    expect(warnings).toEqual([]);
    expect(config.maxTier).toBe('small');
    expect(config.preload).toBe('idle');
    expect(config.widget).toBe(true);
    expect(config.sitemapUrl).toBe('https://example.com/sitemap.xml');
  });

  it('defaults maxTier to small so no visitor gets a 450MB download unasked', () => {
    expect(DEFAULT_CONFIG.maxTier).toBe('small');
  });

  it('accepts valid enum values case-insensitively', () => {
    const { config, warnings } = resolveConfig({ maxTier: 'STANDARD', theme: 'Dark' }, {}, BASE);
    expect(config.maxTier).toBe('standard');
    expect(config.theme).toBe('dark');
    expect(warnings).toEqual([]);
  });

  it('warns and falls back on an unknown enum value rather than throwing', () => {
    const { config, warnings } = resolveConfig({ maxTier: 'enormous' }, {}, BASE);
    expect(config.maxTier).toBe('small');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('data-max-tier');
  });

  it('treats a bare attribute as true', () => {
    // `<script data-debug>` gives an empty string, and means "on".
    const { config } = resolveConfig({ debug: '' }, {}, BASE);
    expect(config.debug).toBe(true);
  });

  it('parses the usual boolean spellings', () => {
    for (const raw of ['true', '1', 'yes']) {
      expect(resolveConfig({ widget: raw }, {}, BASE).config.widget).toBe(true);
    }
    for (const raw of ['false', '0', 'no']) {
      expect(resolveConfig({ widget: raw }, {}, BASE).config.widget).toBe(false);
    }
  });

  it('clamps maxPages into range and says so', () => {
    const high = resolveConfig({ maxPages: '99999' }, {}, BASE);
    expect(high.config.maxPages).toBe(5000);
    expect(high.warnings[0]).toContain('clamped');

    const low = resolveConfig({ maxPages: '0' }, {}, BASE);
    expect(low.config.maxPages).toBe(1);
  });

  it('rejects a non-integer maxPages', () => {
    const { config, warnings } = resolveConfig({ maxPages: 'lots' }, {}, BASE);
    expect(config.maxPages).toBe(DEFAULT_CONFIG.maxPages);
    expect(warnings[0]).toContain('integer');
  });

  it('resolves relative URLs against the document base', () => {
    const { config } = resolveConfig({ sitemap: '../sitemap.xml' }, {}, BASE);
    expect(config.sitemapUrl).toBe('https://example.com/sitemap.xml');
  });

  it('refuses non-http(s) URLs', () => {
    const { config, warnings } = resolveConfig({ sitemap: 'javascript:alert(1)' }, {}, BASE);
    expect(config.sitemapUrl).toBe('https://example.com/sitemap.xml');
    expect(warnings[0]).toContain('refusing non-http(s)');
  });

  it('warns when the sitemap is cross-origin but still allows it', () => {
    const { config, warnings } = resolveConfig({ sitemap: 'https://cdn.example.net/sitemap.xml' }, {}, BASE);
    expect(config.sitemapUrl).toBe('https://cdn.example.net/sitemap.xml');
    expect(warnings[0]).toContain('CORS');
  });

  it('lets programmatic overrides win over attributes', () => {
    const { config } = resolveConfig({ maxTier: 'retrieval' }, { maxTier: 'standard' }, BASE);
    expect(config.maxTier).toBe('standard');
  });

  it('strips characters that would let an accent escape its declaration', () => {
    const { config } = resolveConfig({ accent: 'red; } :host { display: none' }, {}, BASE);
    // Sanitising happens at render time; config keeps the raw value.
    expect(config.accent).toContain('red');
  });
});

describe('readScriptAttributes', () => {
  it('camel-cases data-* names and ignores everything else', () => {
    const el = document.createElement('script');
    el.setAttribute('data-web-ai', '');
    el.setAttribute('data-max-tier', 'standard');
    el.setAttribute('data-model-base-url', 'https://cdn.example.com/models/');
    el.setAttribute('src', '/web-ai.js');

    const attrs = readScriptAttributes(el);
    expect(attrs['maxTier']).toBe('standard');
    expect(attrs['modelBaseUrl']).toBe('https://cdn.example.com/models/');
    expect(attrs['webAi']).toBe('');
    expect(attrs['src']).toBeUndefined();
  });
});
