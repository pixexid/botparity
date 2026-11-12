# botparity

Single-page indexability and AI-crawler parity check. Zero dependencies, one fast look at exactly two resources: the target page and the origin `robots.txt`.

Maintained by [Nuvyr](https://nuvyr.com) — Modern Web Engineering & AI Search Optimization.

## Run

Requires Node.js 20 or newer; tested with Node.js 22.

```sh
node bin/botparity.mjs https://example.com/page
node bin/botparity.mjs https://example.com/page --json
```

(A future `npx botparity <url>` entry point will use this same package once published; runtime behavior will not change.)

## What it checks

Transport: HTTPS, success status, short redirect chain (≤2 hops), lean HTML payload (≤200 KB), with measured fetch duration (not a Core Web Vital).
Indexability: page allows indexing, header vs meta directive parity, canonical present, canonical matches final URL.
Crawl files: search crawlers allowed (Googlebot, Bingbot), AI crawlers allowed (GPTBot, ClaudeBot, PerplexityBot, Applebot-Extended) — reported separately because blocking AI crawlers can be deliberate.
Sitemap: declaration in robots.txt only; absence is unknown.
Content basics: title, meta description, single H1, html lang and hreflang syntax when present, mobile viewport, Open Graph title, JSON-LD presence, image alt text.

Each check reports `pass`, `fail`, or `unknown` with a plain-language reason and a fix hint. Unknown means "could not be observed" and is never a failure. There is no score and no ranking prediction: the tool reports observations only.

## Reuse (site layer)

The pure checker has no I/O and can be imported directly:

```js
import { runChecks } from "./src/checks.mjs"; // or "botparity/src/checks.mjs"
const result = runChecks({ url, finalUrl, status, headers, html, htmlBytes, htmlTruncated, redirectHops, robotsTxt, elapsedMs });
```

`headers` is a lowercased map (repeat headers joined with `", "`). `robotsTxt` is the origin robots.txt text, `null` when absent, `undefined` when not fetched. Helpers `parseHead`, `parseRobots`, and `robotsAllowed(groups, userAgent, path)` are also exported.

## Security boundary

Server-side fetch of a user-supplied URL: only `http`/`https`, public hostnames only, no credentials, default ports only (80/443), IP literals and `localhost` rejected, DNS-resolved addresses must be public IPv4 or global unicast IPv6; reserved, documentation, multicast, shared, transition and other non-public ranges are rejected, the validated resolved IP pinned into the connection so DNS cannot rebind mid-check, every redirect target re-validated, at most 5 page redirect hops (3 for robots.txt), 1 MB page cap (64 KB for robots.txt), ~8 s total deadline shared by DNS, redirects, page and robots.txt. Derived URLs (canonical, sitemap) are never fetched — presence is reported only. No cookies or credentials are sent, and nothing is logged or stored.

## Limitations

- Static HTML only: content rendered client-side by JavaScript is invisible.
- robots.txt rules are read only from successful, complete `text/plain` responses.
- Bounded regex parsing, first match wins for singletons (`title`, canonical); no full DOM. Malformed markup, over 4,096 tags, or a tag over 8,192 characters makes content checks unknown.
- robots.txt covers `Allow`/`Disallow` with `*` and trailing-`$` matching (longest match wins, `Allow` wins ties); crawl-delay is ignored; sitemap declaration is reported without fetching it.
- JSON-LD presence means "at least one block parses", not "the data is correct".
- Blocking AI crawlers is reported as `fail` with an explicit "only change this if you want AI visibility" note, because for most sites it is accidental.
- `unsafeTestLoopback` in `bin/botparity.mjs` is a test-only seam for the local suite and is never set by the CLI.

## Test

```sh
node --test "test/**/*.test.mjs"
```
