#!/usr/bin/env node
// botparity CLI: single-page check over one bounded fetch + origin robots.txt.
// Zero dependencies. Never crawls, renders, logs, or stores anything.
//
// Security boundary (per #84): http/https only, public hostnames only, no
// credentials, default ports only, IP literals rejected, DNS-resolved
// addresses rejected when private/link-local/loopback, the validated
// resolved IP pinned into the connection (custom lookup) so a rebinding
// hostname cannot swap the address mid-check, every redirect re-validated,
// total deadline ~8s, body capped at 1 MB. Derived URLs (canonical,
// sitemap) are never fetched: the checker only reports their presence.

import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { runChecks } from "../src/checks.mjs";

export const TOTAL_DEADLINE_MS = 8000;
export const MAX_BYTES = 1024 * 1024; // 1 MB page cap
export const MAX_ROBOTS_BYTES = 64 * 1024;
export const MAX_REDIRECTS = 5;

// --- pure boundary helpers (exported for tests) ---------------------------

export function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (family !== 6) return true;
  // Canonicalize compressed and embedded IPv4 forms before prefix checks.
  let words;
  try { words = new URL(`http://[${ip}]/`).hostname.slice(1, -1).split(":"); }
  catch { return true; }
  const first = parseInt(words[0], 16);
  const second = parseInt(words[1] || "0", 16);
  // Only global unicast; exclude special-purpose and transition prefixes.
  return (first & 0xe000) !== 0x2000 || first === 0x2002 ||
    (first === 0x3fff && second < 0x1000) ||
    (first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

// Throws on any boundary violation. resolvedIp is the DNS answer for
// urlObj.hostname and is checked separately (see resolvePublic).
export function assertPublicUrl(urlObj) {
  if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
    throw new Error(`blocked: only http/https allowed (got ${urlObj.protocol})`);
  }
  if (urlObj.username || urlObj.password) throw new Error("blocked: credentials in URL are not allowed");
  if (urlObj.port && !((urlObj.protocol === "http:" && urlObj.port === "80") || (urlObj.protocol === "https:" && urlObj.port === "443"))) {
    throw new Error(`blocked: non-default port ${urlObj.port}`);
  }
  const host = urlObj.hostname.toLowerCase();
  if (host === "localhost") throw new Error("blocked: localhost is not a public host");
  // WHATWG URL keeps brackets on IPv6 literals ("[::1]"); strip them first.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (net.isIP(bare)) throw new Error("blocked: IP literals are not allowed");
}

export function resolvePublic(hostname, lookup = dns.lookup, { skipPrivateCheck = false } = {}) {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: false }, (err, address, family) => {
      if (err) return reject(new Error(`DNS lookup failed for ${hostname}: ${err.message}`));
      if (!skipPrivateCheck && isPrivateIp(address)) {
        return reject(new Error(`blocked: ${hostname} resolves to a non-public address`));
      }
      resolve({ address, family });
    });
  });
}

// --- bounded HTTP -----------------------------------------------------------

function singleRequest(urlObj, pinned, msLeft, byteCap) {
  return new Promise((resolve, reject) => {
    if (msLeft <= 0) return reject(new Error("check timed out"));
    const lib = urlObj.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        headers: { "user-agent": "botparity/0.1 (+https://nuvyr.com)", accept: "text/html,*/*", host: urlObj.host },
        // autoSelectFamily would call lookup with { all: true } and expect an
        // array; disabled so the single pinned (address, family) pair is used.
        autoSelectFamily: false,
        // Pin the validated resolved IP so DNS cannot rebind mid-check.
        lookup: (_host, _opts, cb) => cb(null, pinned.address, pinned.family),
      },
      (res) => {
        const headers = {};
        for (const [k, v] of Object.entries(res.headers)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
        }
        const chunks = [];
        let bytes = 0;
        let truncated = false;
        res.on("data", (c) => {
          bytes += c.length;
          if (bytes > byteCap) {
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8"), bytes, truncated }),
        );
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("check timed out")), msLeft);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

async function fetchBounded(
  startUrl,
  { deadline, byteCap, maxRedirects, lookup, unsafeTestLoopback = false } = {},
) {
  // unsafeTestLoopback is test-only: it lets the local test suite reach a
  // loopback server on an ephemeral port for hop 0 only. Every redirect
  // target is still fully validated, and the flag is never set by the CLI.
  let current = new URL(startUrl);
  let hops = 0;
  let first = true;
  // biome-ignore lint: bounded loop, hops capped
  for (;;) {
    const testHop = unsafeTestLoopback && first;
    first = false;
    if (!testHop) assertPublicUrl(current);
    const msForDns = deadline - Date.now();
    if (msForDns <= 0) throw new Error("check timed out");
    let timer;
    const pinned = await Promise.race([
      resolvePublic(current.hostname, lookup, { skipPrivateCheck: testHop }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("check timed out")), msForDns); }),
    ]).finally(() => clearTimeout(timer));
    const msLeft = deadline - Date.now();
    const res = await singleRequest(current, pinned, msLeft, byteCap);
    if (REDIRECT.has(res.status) && res.headers.location) {
      hops += 1;
      if (hops > maxRedirects) throw new Error(`too many redirects (over ${maxRedirects})`);
      current = new URL(res.headers.location, current);
      continue;
    }
    return { ...res, finalUrl: current.toString(), redirectHops: hops };
  }
}

// --- CLI --------------------------------------------------------------------

function usage(code = 1) {
  console.log(`usage:
  botparity <url> [--json]

Runs a single-page indexability and crawler-parity check.
Zero dependencies. Exits 0 when the check completes, 1 on usage errors,
2 when the page cannot be fetched safely.`);
  process.exit(code);
}

function renderText(result) {
  const line = (s) => console.log(s);
  line(`botparity: ${result.url}`);
  line(`final: ${result.finalUrl} (${result.checks.length} checks)`);
  line("");
  for (const c of result.checks) {
    const mark = c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "????";
    line(`[${mark}] ${c.title}`);
    line(`       ${c.reason}`);
    if (c.fix) line(`       fix: ${c.fix}`);
  }
  const { pass, fail, unknown } = result.summary;
  line("");
  line(`${pass} passed, ${fail} failed, ${unknown} unknown — unknowns are not failures.`);
  line("Maintained by Nuvyr (https://nuvyr.com)");
}

export async function main(argv, deps = {}) {
  const fetch = deps.fetch ?? fetchBounded;
  const args = argv.slice(2);
  const json = args.includes("--json");
  const positional = args.filter((a) => a !== "--json");
  if (positional.length !== 1 || positional[0].startsWith("-")) usage(1);
  let start;
  try {
    start = new URL(positional[0]);
  } catch {
    console.error("error: not a valid URL");
    process.exit(1);
  }

  const t0 = Date.now();
  const deadline = t0 + TOTAL_DEADLINE_MS;
  let page;
  try {
    page = await fetch(start.toString(), {
      deadline,
      byteCap: MAX_BYTES,
      maxRedirects: MAX_REDIRECTS,
      lookup: deps.lookup,
    });
  } catch (e) {
    console.error(`error: cannot check ${positional[0]}: ${e.message}`);
    process.exit(2);
  }

  const elapsedMs = Date.now() - t0;
  let robotsTxt;
  try {
    const origin = new URL(page.finalUrl);
    const robotsUrl = `${origin.protocol}//${origin.host}/robots.txt`;
    const res = await fetch(robotsUrl, {
      deadline,
      byteCap: MAX_ROBOTS_BYTES,
      maxRedirects: 3,
      lookup: deps.lookup,
    });
    robotsTxt = res.status >= 200 && res.status < 300 && !res.truncated && /^text\/plain\b/i.test(res.headers["content-type"] ?? "") ? res.body : undefined;
  } catch {
    robotsTxt = undefined; // not fetched: checks report unknown
  }

  const result = runChecks({
    url: positional[0],
    finalUrl: page.finalUrl,
    status: page.status,
    headers: page.headers,
    html: page.truncated ? null : page.body,
    htmlBytes: page.bytes,
    htmlTruncated: page.truncated,
    redirectHops: page.redirectHops,
    robotsTxt,
    elapsedMs,
  });

  if (json) console.log(JSON.stringify(result, null, 2));
  else renderText(result);
}

const isMain = process.argv[1] === new URL(import.meta.url).pathname;
if (isMain) await main(process.argv);

export { fetchBounded, renderText };
