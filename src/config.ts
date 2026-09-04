import type { Enrich, Generate, Position, Preload, Theme, Tier, WebAIConfig } from './types.js';
import { TIERS } from './types.js';

export const DEFAULT_CONFIG: WebAIConfig = {
  sitemapUrl: '/sitemap.xml',
  maxTier: 'small',
  modelBaseUrl: null,
  libraryUrl: null,
  generate: 'ask',
  enrich: 'idle',
  enrichPages: 25,
  indexUrl: null,
  maxPages: 500,
  version: null,
  preload: 'idle',
  widget: true,
  position: 'bottom-right',
  theme: 'auto',
  accent: '#4f46e5',
  workerUrl: null,
  debug: false,
};

/** Raw `data-*` values, already stripped of the `data-` prefix and camel-cased. */
export type RawAttrs = Record<string, string | null | undefined>;

export interface ResolvedConfig {
  config: WebAIConfig;
  /** Non-fatal problems. A widget must never break the host page, so bad input degrades to a default. */
  warnings: string[];
}

const MAX_PAGES_RANGE = [1, 5000] as const;
/** Zero is a legitimate setting: it disables the pass without disabling the config. */
const ENRICH_PAGES_RANGE = [0, 5000] as const;

function pickEnum<T extends string>(
  raw: string | null | undefined,
  allowed: readonly T[],
  fallback: T,
  key: string,
  warnings: string[],
): T {
  if (raw == null || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(value)) return value as T;
  warnings.push(`${key}: expected one of ${allowed.join(', ')} but got "${raw}" — using "${fallback}"`);
  return fallback;
}

function pickBool(raw: string | null | undefined, fallback: boolean, key: string, warnings: string[]): boolean {
  if (raw == null) return fallback;
  const value = raw.trim().toLowerCase();
  // A bare attribute (`data-debug`) reads as an empty string and means "on".
  if (value === '' || value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  warnings.push(`${key}: expected a boolean but got "${raw}" — using ${fallback}`);
  return fallback;
}

function pickInt(
  raw: string | null | undefined,
  fallback: number,
  [min, max]: readonly [number, number],
  key: string,
  warnings: string[],
): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    warnings.push(`${key}: expected an integer but got "${raw}" — using ${fallback}`);
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, parsed));
  if (clamped !== parsed) {
    warnings.push(`${key}: ${parsed} is outside ${min}-${max} — clamped to ${clamped}`);
  }
  return clamped;
}

function pickUrl(
  raw: string | null | undefined,
  fallback: string | null,
  base: string,
  key: string,
  warnings: string[],
  { warnCrossOrigin = false } = {},
): string | null {
  if (raw == null || raw.trim() === '') return fallback;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    warnings.push(`${key}: "${raw}" is not a valid URL — using ${fallback ?? 'the default'}`);
    return fallback;
  }
  // Anything but http(s) is a vector, not a resource. Reject outright.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    warnings.push(`${key}: refusing non-http(s) URL "${raw}"`);
    return fallback;
  }
  if (warnCrossOrigin && url.origin !== new URL(base).origin) {
    warnings.push(`${key}: "${url.href}" is cross-origin and will need CORS headers to be readable`);
  }
  return url.href;
}

/**
 * Merge defaults, `data-*` attributes and programmatic overrides into a usable
 * config. Never throws: every unusable value falls back to its default and is
 * reported in `warnings`.
 */
export function resolveConfig(
  attrs: RawAttrs = {},
  overrides: Partial<WebAIConfig> = {},
  base: string = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/',
): ResolvedConfig {
  const warnings: string[] = [];
  const d = DEFAULT_CONFIG;

  const config: WebAIConfig = {
    sitemapUrl:
      pickUrl(attrs['sitemap'], null, base, 'data-sitemap', warnings, { warnCrossOrigin: true }) ??
      new URL(d.sitemapUrl, base).href,
    maxTier: pickEnum<Tier>(attrs['maxTier'], TIERS, d.maxTier, 'data-max-tier', warnings),
    modelBaseUrl: pickUrl(attrs['modelBaseUrl'], d.modelBaseUrl, base, 'data-model-base-url', warnings),
    libraryUrl: pickUrl(attrs['libraryUrl'], d.libraryUrl, base, 'data-library-url', warnings),
    generate: pickEnum<Generate>(attrs['generate'], ['ask', 'auto', 'never'], d.generate, 'data-generate', warnings),
    enrich: pickEnum<Enrich>(attrs['enrich'], ['idle', 'never'], d.enrich, 'data-enrich', warnings),
    enrichPages: pickInt(attrs['enrichPages'], d.enrichPages, ENRICH_PAGES_RANGE, 'data-enrich-pages', warnings),
    indexUrl: pickUrl(attrs['index'], d.indexUrl, base, 'data-index', warnings, { warnCrossOrigin: true }),
    maxPages: pickInt(attrs['maxPages'], d.maxPages, MAX_PAGES_RANGE, 'data-max-pages', warnings),
    version: attrs['version']?.trim() || d.version,
    preload: pickEnum<Preload>(attrs['preload'], ['idle', 'open', 'never'], d.preload, 'data-preload', warnings),
    widget: pickBool(attrs['widget'], d.widget, 'data-widget', warnings),
    position: pickEnum<Position>(
      attrs['position'],
      ['bottom-right', 'bottom-left'],
      d.position,
      'data-position',
      warnings,
    ),
    theme: pickEnum<Theme>(attrs['theme'], ['auto', 'light', 'dark'], d.theme, 'data-theme', warnings),
    accent: attrs['accent']?.trim() || d.accent,
    workerUrl: pickUrl(attrs['workerUrl'], d.workerUrl, base, 'data-worker-url', warnings),
    debug: pickBool(attrs['debug'], d.debug, 'data-debug', warnings),
    ...overrides,
  };

  return { config, warnings };
}

/** Pull `data-*` values off the script tag that loaded us. */
export function readScriptAttributes(el: Element): RawAttrs {
  const attrs: RawAttrs = {};
  for (const { name, value } of Array.from(el.attributes)) {
    if (!name.startsWith('data-')) continue;
    const key = name
      .slice('data-'.length)
      .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    attrs[key] = value;
  }
  return attrs;
}
