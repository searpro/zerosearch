/**
 * Generates the demo site: a small, deliberately messy static site used as the
 * development target and the Playwright fixture.
 *
 * Kept as a generator rather than hand-written HTML so tests can mutate a
 * page's content and re-emit it — that's how the revalidation path gets
 * exercised.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
const ORIGIN = process.env.DEMO_ORIGIN ?? 'http://localhost:5173';
const BASE = '/demo';
// Dev serves TS straight from source; `DEMO_SCRIPT=/dist/web-ai.js` exercises the built bundle.
const SCRIPT = process.env.DEMO_SCRIPT ?? '/src/index.ts';
const SCRIPT_TYPE = SCRIPT.endsWith('.ts') ? ' type="module"' : '';

/** @type {{path:string,title:string,description:string,category:string,lastmod:string,body:string}[]} */
const pages = [
  {
    path: 'index.html',
    title: 'Meridian — the time-series database for operational data',
    description: 'Meridian is a columnar time-series database built for high-cardinality operational telemetry.',
    category: 'Company',
    lastmod: '2026-08-14',
    body: `
<h1>Time-series storage that does not fall over at high cardinality</h1>
<p>Meridian is a columnar time-series database designed for operational telemetry: metrics,
traces, events, and the messy high-cardinality tags that come with them. It ingests roughly
two million points per second per node and keeps queries interactive at a hundred billion
rows.</p>
<h2>Why teams pick Meridian</h2>
<p>Most time-series systems degrade sharply once tag cardinality passes a few million series.
Meridian's storage engine separates the series index from the value columns, so adding a
high-cardinality dimension such as <code>request_id</code> or <code>customer_id</code> costs
index space but does not slow down scans over the value columns.</p>
<p>Compression typically lands between 12x and 18x on real operational workloads, using
delta-of-delta encoding for timestamps and a per-column choice between Gorilla, dictionary,
and run-length encoding.</p>
<h2>Deployment</h2>
<p>Meridian runs as a single static binary with no external dependencies. A single node is a
complete installation; clustering is opt-in and uses Raft for metadata with independent
sharding for data. Object storage backends are supported for cold tiers, including S3, GCS,
and any S3-compatible endpoint.</p>
<p>The current stable release is <strong>v3.2.1</strong>. See the
<a href="${BASE}/changelog.html">changelog</a> for what shipped, or jump straight to the
<a href="${BASE}/docs/quickstart.html">quickstart</a>.</p>`,
  },
  {
    path: 'pricing.html',
    title: 'Pricing — Meridian',
    description: 'Meridian pricing: Free, Team at $49 per month, Business at $400 per month, and Enterprise.',
    category: 'Company',
    lastmod: '2026-08-29',
    body: `
<h1>Pricing</h1>
<p>All plans include the full query engine. Plans differ in retention, ingest ceiling, and
support terms. Prices are per organisation, billed monthly in US dollars.</p>
<h2>Free</h2>
<p><strong>$0 per month.</strong> One node, 7 days of retention, up to 50,000 points per
second of sustained ingest, and community support. No credit card required. Intended for
evaluation and personal projects, not production.</p>
<h2>Team</h2>
<p><strong>$49 per month.</strong> Up to 3 nodes, 90 days of retention, 500,000 points per
second, email support with a two business day response target, and 10,000 API requests per
minute. This is the plan most small engineering teams start on.</p>
<h2>Business</h2>
<p><strong>$400 per month.</strong> Up to 20 nodes, 400 days of retention, unmetered ingest,
object-storage cold tiers, SAML single sign-on, audit logging, and a four hour support
response target during business hours.</p>
<h2>Enterprise</h2>
<p>Custom pricing. Unlimited nodes, custom retention, a 99.95% uptime commitment, a named
support engineer, 24/7 escalation, and the option of a self-hosted deployment inside your own
VPC. Contact <a href="${BASE}/contact.html">sales</a> for a quote.</p>
<h2>Billing questions</h2>
<p>Plans can be changed at any time and are prorated to the day. Annual billing takes 15% off
the monthly price. We do not charge for query volume, only for ingest and retention, because
metering queries punishes exactly the people getting value from the product.</p>`,
  },
  {
    path: 'about.html',
    title: 'About — Meridian',
    description: 'Meridian was founded in 2021 and is a remote-first company of 34 people.',
    category: 'Company',
    lastmod: '2026-06-02',
    body: `
<h1>About Meridian</h1>
<p>Meridian was founded in 2021 by two engineers who had spent most of the previous decade
operating monitoring systems at scale and had grown tired of the same failure mode: a metrics
backend that worked beautifully in a demo and collapsed the first time somebody added a
per-user tag.</p>
<h2>The company</h2>
<p>We are 34 people across 11 countries, remote-first since day one, with no headquarters. The
engineering team is 19 people. We raised a $12M Series A in March 2024 led by Northlight
Ventures and have been default-alive since Q2 2025.</p>
<h2>How we work</h2>
<p>We ship on a six week cycle with a two week cooldown. Every engineer does a rotation on
support; there is no separate support tier that shields the people who wrote the code from the
people using it. Postmortems are public to customers on the Business plan and above.</p>
<h2>Open source</h2>
<p>The storage engine and query planner are source-available under the Business Source License,
converting to Apache 2.0 after four years. Client libraries are Apache 2.0 with no delay.</p>`,
  },
  {
    path: 'contact.html',
    title: 'Contact — Meridian',
    description: 'How to reach Meridian sales, support, and security.',
    category: 'Company',
    lastmod: '2026-05-19',
    body: `
<h1>Contact us</h1>
<h2>Sales</h2>
<p>For quotes, procurement paperwork, and Enterprise trials, email
<strong>sales@meridian.example</strong>. We reply within one business day. Enterprise trials
run for 30 days and include a shared Slack channel with an engineer.</p>
<h2>Support</h2>
<p>Free plan support happens in the community forum. Team and Business customers should email
<strong>support@meridian.example</strong> from the address on the account. Include your
organisation ID, which is the <code>MRD-</code> prefixed identifier at the top of the billing
page — for example <code>MRD-4400</code>.</p>
<h2>Security</h2>
<p>Report vulnerabilities to <strong>security@meridian.example</strong>. We acknowledge within
24 hours and pay bounties between $250 and $15,000 depending on severity. Please do not test
against other customers' data.</p>
<h2>Mailing address</h2>
<p>Meridian Data Ltd, 4th Floor, 18 Fitzwilliam Street, Dublin 2, Ireland.</p>`,
  },
  {
    path: 'faq.html',
    title: 'Frequently asked questions — Meridian',
    description: 'Common questions about Meridian: migration, retention, cardinality limits, and support.',
    category: 'Support',
    lastmod: '2026-08-22',
    body: `
<h1>Frequently asked questions</h1>
<h2>Can I migrate from Prometheus?</h2>
<p>Yes. Meridian exposes a Prometheus remote-write endpoint, so pointing an existing Prometheus
at Meridian is a configuration change rather than a migration. PromQL is supported for reads,
though a handful of subqueries behave differently and are listed in the compatibility notes.</p>
<h2>What is the actual cardinality limit?</h2>
<p>There is no hard limit. Practically, a single node handles about 50 million active series
before memory pressure on the index becomes the binding constraint. Past that, shard.</p>
<h2>Do you support downsampling?</h2>
<p>Yes, via continuous aggregates that are maintained incrementally as data arrives rather than
recomputed on a schedule. Aggregates can target any retention tier independently.</p>
<h2>Is there a data residency option?</h2>
<p>Business and Enterprise plans can pin storage to the EU, the US, or Australia. Enterprise
can additionally self-host inside their own VPC, in which case no data leaves their account.</p>
<h2>What happens if I exceed my ingest ceiling?</h2>
<p>Writes are throttled rather than dropped, and you get an alert. We do not silently bill
overage. Sustained excess for more than seven days triggers a conversation about moving up a
plan, not an automatic charge.</p>
<h2>How do I cancel?</h2>
<p>Self-serve from the billing page. Cancellation takes effect at the end of the billing period
and your data stays readable for 30 days afterwards so you can export it.</p>`,
  },
  {
    path: 'changelog.html',
    title: 'Changelog — Meridian',
    description: 'Release notes for Meridian v3.2.1, v3.2.0, v3.1.0, and earlier.',
    category: 'Product',
    lastmod: '2026-08-30',
    body: `
<h1>Changelog</h1>
<h2>v3.2.1 — 30 August 2026</h2>
<p>Fixes a regression in the Gorilla decoder that could return stale values for series whose
last write landed exactly on a block boundary. Affects v3.2.0 only. Upgrading is strongly
recommended for anyone running v3.2.0.</p>
<h2>v3.2.0 — 12 August 2026</h2>
<p>Adds object-storage cold tiers for S3, GCS, and S3-compatible endpoints. Adds SAML single
sign-on on the Business plan. Query planner now pushes filters below joins, which cut p99
latency on our benchmark suite by 38%.</p>
<h2>v3.1.0 — 24 June 2026</h2>
<p>Continuous aggregates are now maintained incrementally rather than on a schedule. Adds the
<code>/v1/query/explain</code> endpoint. Raises the default rate limit from 6,000 to 10,000
requests per minute on the Team plan.</p>
<h2>v3.0.0 — 3 April 2026</h2>
<p>New storage engine separating the series index from value columns, which is what makes high
cardinality survivable. Breaking: the v2 line protocol is removed; use the v3 protocol or the
Prometheus remote-write endpoint. Breaking: <code>meridiand.conf</code> moves from INI to TOML.</p>`,
  },
  {
    path: 'docs/index.html',
    title: 'Documentation — Meridian',
    description: 'Meridian documentation index.',
    category: 'Docs',
    lastmod: '2026-08-14',
    body: `
<h1>Documentation</h1>
<p>Start with the <a href="${BASE}/docs/quickstart.html">quickstart</a> to get a node running
in about five minutes. From there, the <a href="${BASE}/docs/api.html">HTTP API reference</a>
covers reads and writes, <a href="${BASE}/docs/authentication.html">authentication</a> covers
tokens and scopes, and <a href="${BASE}/docs/limits.html">limits</a> documents rate limits and
quotas per plan.</p>
<h2>Conventions</h2>
<p>All API endpoints are versioned under <code>/v1</code>. Timestamps are RFC 3339 with a
mandatory offset. Durations use Go syntax: <code>15m</code>, <code>72h</code>. Every response
carries an <code>X-Meridian-Request-Id</code> header; include it when contacting support.</p>`,
  },
  {
    path: 'docs/quickstart.html',
    title: 'Quickstart — Meridian docs',
    description: 'Run a Meridian node and write your first points in five minutes.',
    category: 'Docs',
    lastmod: '2026-08-14',
    body: `
<h1>Quickstart</h1>
<p>This walks through running a single node locally and writing your first points. It takes
about five minutes and needs nothing installed beyond Docker or a downloaded binary.</p>
<h2>1. Run a node</h2>
<p>The container image is <code>ghcr.io/meridian/meridiand:3.2.1</code>. Run it with a mounted
data directory and port 9080 published. A single node is a complete installation — there is no
separate coordinator or metadata service to stand up first.</p>
<h2>2. Create a token</h2>
<p>On first boot the node prints a bootstrap token to stdout. Exchange it for a long-lived
token at <code>POST /v1/auth/token</code>. The bootstrap token expires after 15 minutes, which
catches people who leave a node running overnight before coming back to it.</p>
<h2>3. Write points</h2>
<p>Write with <code>POST /v1/write</code> using the v3 line protocol. A point is a measurement
name, an optional set of tags, one or more fields, and an optional timestamp. Omitting the
timestamp means server time at ingest.</p>
<h2>4. Query</h2>
<p>Query with <code>POST /v1/query</code>. The body takes either MeridianQL or PromQL; set
<code>"dialect": "promql"</code> for the latter. Responses stream as newline-delimited JSON so
large result sets do not need to buffer.</p>
<h2>Next steps</h2>
<p>Read <a href="${BASE}/docs/limits.html">limits</a> before you point production traffic at a
node, and <a href="${BASE}/docs/authentication.html">authentication</a> before you hand tokens
to anything.</p>`,
  },
  {
    path: 'docs/api.html',
    title: 'HTTP API reference — Meridian docs',
    description: 'Meridian v1 HTTP API: write, query, explain, and admin endpoints.',
    category: 'Docs',
    lastmod: '2026-08-12',
    body: `
<h1>HTTP API reference</h1>
<p>Every endpoint lives under <code>/v1</code> and speaks JSON unless noted. All requests need
a bearer token; see <a href="${BASE}/docs/authentication.html">authentication</a>.</p>
<h2>POST /v1/write</h2>
<p>Writes points in the v3 line protocol. The body is <code>text/plain</code>, one point per
line, up to 5,000 points or 4 MB per request, whichever comes first. Returns 204 on success.
A partial failure returns 207 with a per-line error list; the successful lines are still
written, because dropping a whole batch for one malformed line is how you lose data.</p>
<h2>POST /v1/query</h2>
<p>Runs a query. Takes <code>query</code>, an optional <code>dialect</code> of
<code>meridianql</code> or <code>promql</code>, and an optional <code>timeout</code> capped at
120 seconds. Responses stream as newline-delimited JSON.</p>
<h2>POST /v1/query/explain</h2>
<p>Returns the physical plan without executing it, including estimated rows scanned per stage
and which filters were pushed down. Added in v3.1.0.</p>
<h2>GET /v1/series</h2>
<p>Lists series matching a selector. Paginated with a cursor; the page size defaults to 1,000
and caps at 10,000.</p>
<h2>DELETE /v1/series</h2>
<p>Deletes series matching a selector. Asynchronous — returns a job ID to poll at
<code>GET /v1/jobs/{id}</code>. Deletes are tombstoned immediately and reclaimed at the next
compaction, so space does not come back instantly.</p>
<h2>Errors</h2>
<p>Errors return a JSON body with <code>code</code>, <code>message</code>, and
<code>request_id</code>. Codes are stable strings such as <code>rate_limited</code>,
<code>invalid_query</code>, and <code>retention_exceeded</code>. Do not match on message text;
it changes.</p>`,
  },
  {
    path: 'docs/authentication.html',
    title: 'Authentication — Meridian docs',
    description: 'Tokens, scopes, rotation, and single sign-on in Meridian.',
    category: 'Docs',
    lastmod: '2026-07-30',
    body: `
<h1>Authentication</h1>
<p>Meridian authenticates with bearer tokens. There are no API keys and no basic auth; a single
token type keeps the audit trail coherent.</p>
<h2>Token types</h2>
<p><strong>Bootstrap tokens</strong> are printed once at first boot and expire after 15
minutes. <strong>User tokens</strong> inherit the permissions of the user who created them and
expire after 90 days by default. <strong>Service tokens</strong> are not tied to a user, carry
an explicit scope list, and do not expire unless you set an expiry.</p>
<h2>Scopes</h2>
<p>Scopes are <code>write</code>, <code>read</code>, <code>admin</code>, and
<code>billing</code>. They do not nest: an <code>admin</code> token cannot write points unless
it also carries <code>write</code>. This is deliberate — it makes the blast radius of a leaked
admin token smaller.</p>
<h2>Rotation</h2>
<p>Rotate with <code>POST /v1/auth/token/rotate</code>. The old token stays valid for a grace
period of 60 minutes so a rolling deploy does not have to be atomic. Revoke immediately with
<code>DELETE /v1/auth/token/{id}</code> when a token is known to be compromised.</p>
<h2>Single sign-on</h2>
<p>SAML SSO is available on Business and Enterprise, added in v3.2.0. SCIM provisioning is
Enterprise only. When SSO is enforced, existing user tokens keep working until they expire;
service tokens are unaffected.</p>`,
  },
  {
    path: 'docs/limits.html',
    title: 'Limits and quotas — Meridian docs',
    description: 'Rate limits, request size caps, and per-plan quotas.',
    category: 'Docs',
    lastmod: '2026-08-25',
    body: `
<h1>Limits and quotas</h1>
<h2>Rate limits</h2>
<p>Rate limits are per organisation, not per token. Free allows 1,000 requests per minute, Team
allows 10,000, Business allows 60,000, and Enterprise is negotiated. Exceeding the limit
returns <code>429</code> with a <code>Retry-After</code> header and the
<code>rate_limited</code> error code.</p>
<h2>Request size</h2>
<p>A write request caps at 5,000 points or 4 MB, whichever comes first. A query body caps at
64 KB. A query result set is unbounded but a query times out at 120 seconds.</p>
<h2>Retention</h2>
<p>Retention is a plan ceiling, not a default: Free 7 days, Team 90 days, Business 400 days,
Enterprise custom. Set a shorter retention per measurement if you want it. Data past the
ceiling is deleted at the next compaction, typically within an hour.</p>
<h2>Cardinality</h2>
<p>There is no enforced cardinality limit. A node handles roughly 50 million active series
before index memory becomes the binding constraint. A series counts as active if it has
received a point within the last 24 hours.</p>
<h2>Concurrency</h2>
<p>Concurrent queries per organisation: Free 4, Team 16, Business 64, Enterprise negotiated.
Queries beyond the limit queue for up to 30 seconds before returning
<code>too_many_concurrent_queries</code>.</p>`,
  },
  {
    path: 'blog/why-columnar.html',
    title: 'Why we went columnar — Meridian blog',
    description: 'The engineering argument for separating the series index from value columns.',
    category: 'Blog',
    lastmod: '2026-05-08',
    body: `
<h1>Why we went columnar</h1>
<p>The conventional time-series design stores each series as its own contiguous run of
timestamp and value pairs. It is a good design right up until the moment somebody adds a tag
with a million distinct values, at which point you have a million tiny files and an index that
no longer fits in memory.</p>
<h2>The problem with series-per-file</h2>
<p>Every write touches the index. Every query touches the index. Once the index stops fitting
in RAM, both paths start hitting disk on the critical path, and the failure is not graceful —
throughput falls off a cliff rather than degrading smoothly.</p>
<h2>What we did instead</h2>
<p>We store values in columns partitioned by time, and keep the series index as a separate
structure that maps tag sets to compact series IDs. A query resolves the selector against the
index once, producing a set of series IDs, then scans value columns filtered by that set.</p>
<p>The consequence is that adding a high-cardinality tag costs index space, which is cheap and
compressible, rather than fragmenting the value storage, which is expensive. In our benchmarks
going from 100,000 to 50 million active series raised query latency by about 2.1x, against
more than 40x for a series-per-file layout on the same hardware.</p>
<h2>What it cost us</h2>
<p>Single-series point lookups got slower — roughly 3x — because we now do two lookups instead
of one. We decided that was the right trade: nobody runs a monitoring system to fetch one point
at a time, but plenty of people run one with a per-customer tag.</p>`,
  },
  {
    path: 'blog/v3-launch.html',
    title: 'Meridian v3 is out — Meridian blog',
    description: 'What shipped in Meridian v3.0.0 and what breaks.',
    category: 'Blog',
    lastmod: '2026-04-03',
    body: `
<h1>Meridian v3 is out</h1>
<p>v3.0.0 is the largest release we have shipped. It replaces the storage engine, and with it
the reason people were hitting a wall at around five million series.</p>
<h2>What is new</h2>
<p>The new engine separates the series index from the value columns. Compression improved from
roughly 8x to between 12x and 18x on the workloads we test against. Query planning now happens
against real column statistics rather than estimates, which mostly shows up as fewer
pathological plans rather than a uniform speedup.</p>
<h2>What breaks</h2>
<p>The v2 line protocol is removed. Use the v3 protocol or the Prometheus remote-write
endpoint. The config file moves from INI to TOML; run <code>meridiand config migrate</code> to
convert an existing <code>meridiand.conf</code> in place.</p>
<p>Upgrading rewrites storage on first boot. On a node holding a terabyte, expect somewhere
between 20 and 40 minutes during which the node serves reads but rejects writes. Plan for it.</p>
<h2>Upgrading</h2>
<p>Go through v2.9 first if you are on anything older; v3 does not read pre-v2.9 storage
directly. The current patch release is v3.2.1 and that is what new installations should use.</p>`,
  },
];

const layout = (page) => {
  const depth = page.path.split('/').length - 1;
  const home = depth === 0 ? './' : '../';
  const crumbs =
    depth === 0
      ? ''
      : `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>
      <li><a href="${BASE}/index.html">Home</a></li>
      <li><a href="${BASE}/${page.path.split('/')[0]}/index.html">${page.category}</a></li>
      <li aria-current="page">${page.title.split(' — ')[0]}</li>
    </ol></nav>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title}</title>
<meta name="description" content="${page.description}">
<meta property="og:title" content="${page.title}">
<meta property="og:description" content="${page.description}">
<meta property="og:type" content="website">
<link rel="canonical" href="${ORIGIN}${BASE}/${page.path}">
<script type="application/ld+json">
${JSON.stringify(
  {
    '@context': 'https://schema.org',
    '@type': page.category === 'Blog' ? 'BlogPosting' : 'WebPage',
    headline: page.title,
    description: page.description,
    dateModified: page.lastmod,
    publisher: { '@type': 'Organization', name: 'Meridian Data Ltd' },
  },
  null,
  2,
)}
</script>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 24px 20px 80px; }
  header.site, footer.site { background: #f4f4f6; padding: 12px 20px; }
  header.site nav a { margin-right: 14px; }
  .breadcrumbs ol { list-style: none; display: flex; gap: 8px; padding: 0; font-size: 14px; }
  .breadcrumbs li + li::before { content: "/"; margin-right: 8px; opacity: .5; }
  code { background: #ececf0; padding: 1px 5px; border-radius: 4px; font-size: .9em; }
  .promo { border: 1px dashed #bbb; padding: 12px; margin: 24px 0; font-size: 14px; }
</style>
</head>
<body>
<!-- Site chrome: Readability should strip all of this. -->
<header class="site">
  <nav aria-label="Main">
    <a href="${BASE}/index.html">Meridian</a>
    <a href="${BASE}/docs/index.html">Docs</a>
    <a href="${BASE}/pricing.html">Pricing</a>
    <a href="${BASE}/changelog.html">Changelog</a>
    <a href="${BASE}/faq.html">FAQ</a>
    <a href="${BASE}/about.html">About</a>
    <a href="${BASE}/contact.html">Contact</a>
  </nav>
</header>
<div class="wrap">
${crumbs}
<main>
<article>
${page.body.trim()}
</article>
</main>
<aside class="promo">Ready to try Meridian? Start free, no credit card required.</aside>
</div>
<footer class="site">
  <p>&copy; 2026 Meridian Data Ltd. All rights reserved. Registered in Ireland.</p>
  <p><a href="${BASE}/index.html">Home</a> &middot; <a href="${home}">Up</a></p>
</footer>
<script${SCRIPT_TYPE} src="${SCRIPT}" data-web-ai data-sitemap="${BASE}/sitemap.xml" data-debug></script>
</body>
</html>
`;
};

const sitemap = () => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (p) => `  <url>
    <loc>${ORIGIN}${BASE}/${p.path}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${p.path === 'index.html' ? '1.0' : p.path.startsWith('docs/') ? '0.8' : '0.6'}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`;

const robots = () => `User-agent: *
Allow: /
Disallow: /demo/private/
Sitemap: ${ORIGIN}${BASE}/sitemap.xml
`;

for (const page of pages) {
  const file = join(OUT, page.path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, layout(page), 'utf8');
}
await writeFile(join(OUT, 'sitemap.xml'), sitemap(), 'utf8');
await writeFile(join(OUT, 'robots.txt'), robots(), 'utf8');

console.log(`demo: wrote ${pages.length} pages + sitemap.xml + robots.txt`);
export { pages };
