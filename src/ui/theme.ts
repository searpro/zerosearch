import type { WebAIConfig } from '../types.js';

/**
 * Styles for the widget's shadow root.
 *
 * Shadow DOM blocks the host page's selectors, but inherited properties still
 * cross the boundary, so `:host` sets font and colour explicitly rather than
 * trusting whatever the page happens to have on `body`.
 */
export function styles(config: WebAIConfig): string {
  const edge = config.position === 'bottom-left' ? 'left: 20px;' : 'right: 20px;';

  return `
:host {
  --wa-accent: ${escapeCss(config.accent)};
  --wa-accent-fg: #ffffff;
  --wa-bg: #ffffff;
  --wa-surface: #f6f6f7;
  --wa-fg: #16161a;
  --wa-muted: #6b6b76;
  --wa-border: #e2e2e6;
  --wa-shadow: 0 10px 40px rgb(0 0 0 / 0.16), 0 2px 8px rgb(0 0 0 / 0.08);
  --wa-radius: 14px;

  all: initial;
  position: fixed;
  bottom: 20px;
  ${edge}
  z-index: 2147483000;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--wa-fg);
  color-scheme: light dark;
}

${config.theme === 'auto' ? '@media (prefers-color-scheme: dark) { :host {' : ''}
${config.theme === 'dark' ? ':host {' : ''}
${
  config.theme !== 'light'
    ? `
  --wa-bg: #17171a;
  --wa-surface: #212126;
  --wa-fg: #ececf1;
  --wa-muted: #9a9aa6;
  --wa-border: #303038;
  --wa-shadow: 0 10px 40px rgb(0 0 0 / 0.5), 0 2px 8px rgb(0 0 0 / 0.3);
`
    : ''
}
${config.theme === 'dark' ? '}' : ''}
${config.theme === 'auto' ? '} }' : ''}

*, *::before, *::after { box-sizing: border-box; }

.bubble {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border: 0;
  border-radius: 50%;
  background: var(--wa-accent);
  color: var(--wa-accent-fg);
  box-shadow: var(--wa-shadow);
  cursor: pointer;
  transition: transform 140ms ease, opacity 140ms ease;
}
.bubble:hover { transform: scale(1.06); }
.bubble:focus-visible { outline: 2px solid var(--wa-accent); outline-offset: 3px; }
.bubble[hidden] { display: none; }

.panel {
  display: flex;
  flex-direction: column;
  width: min(400px, calc(100vw - 40px));
  height: min(600px, calc(100vh - 120px));
  background: var(--wa-bg);
  border: 1px solid var(--wa-border);
  border-radius: var(--wa-radius);
  box-shadow: var(--wa-shadow);
  overflow: hidden;
}
.panel[hidden] { display: none; }

.header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--wa-border);
  background: var(--wa-surface);
}
.title { font-weight: 600; flex: 1; margin: 0; font-size: 14px; }
.status { color: var(--wa-muted); font-size: 12px; }

.close {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--wa-muted);
  cursor: pointer;
}
.close:hover { background: var(--wa-border); color: var(--wa-fg); }
.close:focus-visible { outline: 2px solid var(--wa-accent); outline-offset: 2px; }

.body {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
}

.placeholder {
  color: var(--wa-muted);
  text-align: center;
  padding: 32px 16px;
}

@media (prefers-reduced-motion: reduce) {
  .bubble { transition: none; }
  .bubble:hover { transform: none; }
}
`;
}

const FALLBACK_ACCENT = '#4f46e5';

/**
 * Only let a real colour through.
 *
 * An allowlist rather than a blocklist, because stripping delimiters still
 * leaves `url(...)` intact, and `background: var(--wa-accent)` would happily
 * fetch it. Anything unrecognised falls back rather than reaching the sheet.
 */
export function escapeCss(value: string): string {
  const v = value.trim();
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
  if (/^(?:rgba?|hsla?)\(\s*[0-9.,%\s/deg]+\)$/i.test(v)) return v;
  // Bare words cover the CSS named colours. An unknown one is simply an
  // invalid value, which the browser drops — no way to escape the declaration.
  if (/^[a-z]+$/i.test(v)) return v;
  return FALLBACK_ACCENT;
}
