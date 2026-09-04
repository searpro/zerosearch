/**
 * robots.txt parsing and matching.
 *
 * We are a crawler, even though we run inside a visitor's browser and fetch
 * only same-origin pages the visitor could read anyway. Honouring Disallow is
 * both correct and self-serving: the paths a site excludes are usually the
 * ones that would pollute an index — search result pages, session-scoped URLs,
 * printer views.
 */

export interface RobotsRule {
  allow: boolean;
  pattern: string;
  /** Longer patterns are more specific and win. */
  length: number;
}

export interface Robots {
  groups: Map<string, RobotsRule[]>;
  sitemaps: string[];
}

export const AGENT = 'zerosearch';

export function parseRobots(text: string): Robots {
  const groups = new Map<string, RobotsRule[]>();
  const sitemaps: string[] = [];

  let currentAgents: string[] = [];
  // Consecutive User-agent lines share one block of rules; a rule line ends
  // the header and starts a new group on the next agent line.
  let expectingRules = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line.length === 0) continue;

    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }

    if (field === 'user-agent') {
      if (expectingRules) {
        currentAgents = [];
        expectingRules = false;
      }
      const agent = value.toLowerCase();
      currentAgents.push(agent);
      if (!groups.has(agent)) groups.set(agent, []);
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    if (currentAgents.length === 0) continue;
    expectingRules = true;

    // `Disallow:` with an empty value means "nothing is disallowed" — it is a
    // permission, not a rule, so it must not match every path as a prefix.
    if (value === '') continue;

    const rule: RobotsRule = { allow: field === 'allow', pattern: value, length: value.length };
    for (const agent of currentAgents) groups.get(agent)!.push(rule);
  }

  return { groups, sitemaps };
}

/**
 * Google's precedence: the most specific matching group wins, and within it the
 * longest matching pattern wins, with Allow beating Disallow on a tie.
 */
export function isAllowed(robots: Robots, path: string, agent: string = AGENT): boolean {
  const rules = groupFor(robots, agent);
  if (!rules || rules.length === 0) return true;

  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    if (
      best === null ||
      rule.length > best.length ||
      (rule.length === best.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best === null ? true : best.allow;
}

function groupFor(robots: Robots, agent: string): RobotsRule[] | undefined {
  const lower = agent.toLowerCase();
  // Exact match first, then the longest prefix match, then the wildcard group.
  const exact = robots.groups.get(lower);
  if (exact) return exact;

  let best: { name: string; rules: RobotsRule[] } | null = null;
  for (const [name, rules] of robots.groups) {
    if (name === '*') continue;
    if (!lower.startsWith(name)) continue;
    if (best === null || name.length > best.name.length) best = { name, rules };
  }
  return best?.rules ?? robots.groups.get('*');
}

/** robots.txt path patterns support `*` as a wildcard and `$` as an end anchor. */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const source = body
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}
