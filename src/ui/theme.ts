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
  margin: 0;
}

.transcript { display: flex; flex-direction: column; gap: 14px; }

.turn { font-size: 14px; }
.turn-user {
  align-self: flex-end;
  max-width: 85%;
  padding: 8px 12px;
  border-radius: 12px 12px 2px 12px;
  background: var(--wa-accent);
  color: var(--wa-accent-fg);
  overflow-wrap: anywhere;
}
.turn-pending { color: var(--wa-muted); font-style: italic; }
.turn-error { color: #b4232b; }
@media (prefers-color-scheme: dark) { .turn-error { color: #ff8a8a; } }

.answer-intro { margin: 0 0 8px; color: var(--wa-muted); font-size: 13px; }
.answer-empty { margin: 0 0 8px; }

.citations, .suggestions { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }

.citation {
  padding: 10px 12px;
  border: 1px solid var(--wa-border);
  border-radius: 10px;
  background: var(--wa-surface);
}
.citation-source {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--wa-accent);
  text-decoration: none;
  margin-bottom: 6px;
  overflow-wrap: anywhere;
}
.citation-source:hover { text-decoration: underline; }
.citation-body { margin: 0; overflow-wrap: anywhere; }

.suggestions a { color: var(--wa-accent); }

.answer-text { margin: 0 0 10px; overflow-wrap: anywhere; }

.answer-cite {
  display: inline-block;
  min-width: 15px;
  padding: 0 4px;
  margin: 0 1px;
  border-radius: 4px;
  background: var(--wa-accent);
  color: var(--wa-accent-fg);
  font-size: 10px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
  text-decoration: none;
  vertical-align: 2px;
}
.answer-cite:hover { filter: brightness(1.15); }

.turn-streaming .answer-text::after {
  content: '';
  display: inline-block;
  width: 7px;
  height: 13px;
  margin-left: 2px;
  background: var(--wa-muted);
  vertical-align: -2px;
  animation: wa-blink 1s steps(2, start) infinite;
}
@keyframes wa-blink { to { visibility: hidden; } }
@media (prefers-reduced-motion: reduce) {
  .turn-streaming .answer-text::after { animation: none; }
}

.offer-slot:empty { display: none; }
.offer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-top: 1px solid var(--wa-border);
  background: var(--wa-surface);
  font-size: 12px;
}
.offer-text { flex: 1; color: var(--wa-muted); }
.offer-button {
  flex: none;
  padding: 5px 11px;
  border: 1px solid var(--wa-accent);
  border-radius: 7px;
  background: transparent;
  color: var(--wa-accent);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.offer-button:hover { background: var(--wa-accent); color: var(--wa-accent-fg); }
.offer-button:focus-visible { outline: 2px solid var(--wa-accent); outline-offset: 2px; }
.offer-slot .turn { padding: 9px 12px; border-top: 1px solid var(--wa-border); }

.composer {
  display: flex;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--wa-border);
  background: var(--wa-surface);
}
.input {
  flex: 1;
  resize: none;
  padding: 9px 11px;
  border: 1px solid var(--wa-border);
  border-radius: 9px;
  background: var(--wa-bg);
  color: var(--wa-fg);
  font: inherit;
  max-height: 120px;
}
.input:focus-visible { outline: 2px solid var(--wa-accent); outline-offset: -1px; }
.input:disabled { opacity: .6; }

.send {
  padding: 0 16px;
  border: 0;
  border-radius: 9px;
  background: var(--wa-accent);
  color: var(--wa-accent-fg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.send:disabled { opacity: .5; cursor: default; }
.send:focus-visible { outline: 2px solid var(--wa-accent); outline-offset: 2px; }

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
