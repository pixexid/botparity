// botparity shared pure checker — no I/O, no network, no dependencies.
//
// Input is an observations object the caller (CLI today, nuvyr.com page
// tomorrow) builds by fetching exactly two resources: the target page and
// the origin /robots.txt. The checker never fetches anything itself, so it
// can never crawl, follow derived links (canonical, sitemap), or leak a
// request anywhere. "Unknown" always means "could not observe", never a
// failure: unknowns never count as failures.
//
// Observations shape:
// {
//   url: string,          // URL as requested
//   finalUrl: string,     // URL after redirects (same as url if none)
//   status: number|null,  // final HTTP status, null when no response
//   headers: object,      // lowercased response header map; repeat
//                         // headers (e.g. x-robots-tag) joined with ", "
//   html: string|null,    // response body text, null when not retrieved
//   htmlBytes: number|null,
//   htmlTruncated: boolean,
//   redirectHops: number, // redirects followed to reach finalUrl
//   robotsTxt: string|null|undefined,
//                         // origin robots.txt text; null = absent/unparseable,
//                         // undefined = not fetched (unknown)
//   elapsedMs: number|null
// }
//
// Output: { url, finalUrl, checks: [...], summary: { total, pass, fail, unknown } }
// Each check: { id, title, category, status, reason, fix }

const SEARCH_BOTS = ["Googlebot", "Bingbot"];
const AI_BOTS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Applebot-Extended"];

const CATEGORIES = {
  transport: "Transport",
  indexability: "Indexability",
  content: "Content basics",
  crawl: "Crawl files",
};

function check(id, title, category, status, reason, fix) {
  return { id, title, category, status, reason, fix };
}

function unknown(id, title, category, reason) {
  return check(id, title, category, "unknown", reason, "");
}

// --- tiny HTML parsing ---------------------------------------------------
// Honest regex parsing of static HTML only: no script execution, no
// external resources, first match wins for singletons. Anything rendered
// client-side by JavaScript is invisible to these checks.

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function headScope(html) {
  const m = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(html);
  return m ? m[1] : html; // shortcut: no <head> found, scan whole doc; parsers below still work
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let m;
  let first = true;
  while ((m = re.exec(tag)) !== null) {
    if (first) {
      first = false; // skip the tag name itself
      continue;
    }
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (!(name in attrs)) attrs[name] = value;
  }
  return attrs;
}

function findTags(scope, name) {
  const re = new RegExp(`<${name}\\b[^>]*>`, "gi");
  return scope.match(re) ?? [];
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return Number.isSafeInteger(c) && c <= 0x10ffff ? String.fromCodePoint(c) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const c = parseInt(h, 16);
      return Number.isSafeInteger(c) && c <= 0x10ffff ? String.fromCodePoint(c) : _;
    });
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, "");
}

// Exported for tests and for the future site layer.
export function parseHead(html) {
  const clean = stripComments(html);
  const head = headScope(clean);

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(clean);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : "";

  let description = "";
  let viewport = "";
  const robotsDirectives = [];
  const og = {};
  for (const tag of findTags(head, "meta")) {
    const a = parseAttrs(tag);
    const key = (a.name ?? a.property ?? "").toLowerCase();
    if (!key || !("content" in a)) continue;
    if (key === "description" && !description) description = a.content.trim();
    else if (key === "viewport" && !viewport) viewport = a.content.trim();
    else if ((key === "robots" || key === "googlebot") && a.content.trim()) {
      robotsDirectives.push(...a.content.split(/[\s,]+/).filter(Boolean));
    } else if (key.startsWith("og:") && !(key in og)) og[key] = a.content.trim();
  }

  let canonical = "";
  const hreflangs = [];
  for (const tag of findTags(head, "link")) {
    const a = parseAttrs(tag);
    const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("canonical") && a.href && !canonical) canonical = a.href.trim();
    if (rel.includes("alternate") && "hreflang" in a) hreflangs.push({ lang: a.hreflang, href: a.href });
  }

  const h1s = [];
  const h1Re = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi;
  let hm;
  while ((hm = h1Re.exec(clean)) !== null) {
    h1s.push(decodeEntities(stripTags(hm[1])).trim());
  }

  const htmlTag = /<html\b[^>]*>/i.exec(clean);
  const lang = htmlTag ? (parseAttrs(htmlTag[0]).lang ?? "").trim() : "";

  const jsonLd = { ok: 0, bad: 0 };
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let sm;
  while ((sm = scriptRe.exec(clean)) !== null) {
    const type = (parseAttrs(sm[0]).type ?? "").toLowerCase().trim();
    if (type !== "application/ld+json") continue;
    try {
      JSON.parse(sm[1].trim());
      jsonLd.ok += 1;
    } catch {
      jsonLd.bad += 1;
    }
  }

  const imgs = { total: 0, missingAlt: 0 };
  for (const tag of findTags(clean, "img")) {
    imgs.total += 1;
    const alt = parseAttrs(tag).alt;
    if (alt === undefined || alt.trim() === "") imgs.missingAlt += 1;
  }

  return { title, description, viewport, robotsDirectives, og, canonical, h1s, lang, hreflangs, jsonLd, imgs };
}

function robotsTokens(value) {
  return String(value ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

// --- robots.txt parsing (RFC 9309 subset) --------------------------------
// Longest-match wins; Allow beats Disallow on ties. Supports "*" and "$".
// Group selection: groups naming the agent win over "*" groups.

export function parseRobots(txt) {
  const groups = [];
  let current = null;
  let sawRule = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (sawRule || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
        sawRule = false;
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === "allow" || field === "disallow") && current) {
      if (value === "") continue; // Disallow: <empty> allows everything
      if (value.length > 256 || groups.reduce((n, group) => n + group.rules.length, 0) >= 64) throw new Error("robots rules exceed parser limit");
      current.rules.push({ type: field, path: value });
      sawRule = true;
    }
  }
  return groups;
}

function longestMatchLength(rulePath, targetPath) {
  const anchored = rulePath.endsWith("$");
  const pattern = anchored ? rulePath.slice(0, -1) : rulePath;
  let i = 0, j = 0, star = -1, retry = 0;
  while (i < targetPath.length) {
    if (j < pattern.length && pattern[j] === targetPath[i]) { i++; j++; }
    else if (pattern[j] === "*") { star = j++; retry = i; }
    else if (star !== -1) { j = star + 1; i = ++retry; }
    else return -1;
    if (!anchored && j === pattern.length) return pattern.replace(/\*/g, "").length;
  }
  while (pattern[j] === "*") j++;
  return j === pattern.length ? pattern.replace(/\*/g, "").length : -1;
}

// Returns true (allowed), false (disallowed), or "unknown" (no robots.txt).
export function robotsAllowed(groups, userAgent, path) {
  if (!groups) return "unknown";
  const ua = userAgent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && (ua === a || ua.startsWith(a))));
  const pool = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  if (pool.length === 0) return true; // no applicable group: allowed
  let best = -1;
  let verdict = true;
  for (const g of pool) {
    for (const rule of g.rules) {
      const len = longestMatchLength(rule.path, path);
      if (len < 0) continue;
      if (len > best || (len === best && rule.type === "allow")) {
        best = len;
        verdict = rule.type === "allow";
      }
    }
  }
  return verdict;
}

function normalizeUrl(u) {
  try {
    const p = new URL(u);
    p.hash = "";
    if ((p.protocol === "https:" && p.port === "443") || (p.protocol === "http:" && p.port === "80")) p.port = "";
    let s = p.toString();
    if (s.endsWith("/") && p.pathname === "/" && !p.search) s = p.origin + "/";
    return s.replace(/\/$/, "");
  } catch {
    return null;
  }
}

// --- the checks ---------------------------------------------------------

export const CHECK_COUNT = 19;

export function runChecks(obs) {
  const headers = obs.headers ?? {};
  const headerRobots = robotsTokens(headers["x-robots-tag"]);
  // Reject pathological malformed markup before regex parsing; report it as unknown.
  let html = typeof obs.html === "string" ? obs.html : null;
  if (html !== null) {
    let pos = 0, tags = 0;
    const open = { head: 0, title: 0, h1: 0, script: 0 };
    while ((pos = html.indexOf("<", pos)) !== -1) {
      if (html.startsWith("<!--", pos)) {
        const end = html.indexOf("-->", pos + 4);
        if (end === -1) { html = null; break; }
        pos = end + 3;
        continue;
      }
      const end = html.indexOf(">", pos + 1);
      const next = html.indexOf("<", pos + 1);
      if (end === -1 || end - pos > 8192 || (next !== -1 && next < end) || ++tags > 4096) { html = null; break; }
      const tag = /^<(\/)?(head|title|h1|script)\b/i.exec(html.slice(pos, end + 1));
      if (tag) {
        const name = tag[2].toLowerCase();
        open[name] += tag[1] ? -1 : 1;
        if (open[name] < 0 || open[name] > 1) { html = null; break; }
      }
      pos = end + 1;
    }
    if (html !== null && Object.values(open).some(Boolean)) html = null;
  }
  const head = html !== null ? parseHead(html) : null;
  const metaRobots = head ? head.robotsDirectives.map((t) => t.toLowerCase()) : [];
  const noindexHeader = headerRobots.includes("noindex");
  const noindexMeta = metaRobots.includes("noindex");
  const nofollowHeader = headerRobots.includes("nofollow");
  const nofollowMeta = metaRobots.includes("nofollow");
  const checks = [];

  // 1. HTTPS
  let finalProto = null;
  try {
    finalProto = new URL(obs.finalUrl).protocol;
  } catch {
    finalProto = null;
  }
  if (finalProto === "https:") checks.push(check("https", "Served over HTTPS", CATEGORIES.transport, "pass", "Final URL uses HTTPS.", ""));
  else if (finalProto === "http:") checks.push(check("https", "Served over HTTPS", CATEGORIES.transport, "fail", "Final URL uses plain HTTP.", "Redirect HTTP to HTTPS."));
  else checks.push(unknown("https", "Served over HTTPS", CATEGORIES.transport, "Final URL is not a valid HTTP(S) URL."));

  // 2. HTTP status
  const status = obs.status ?? null;
  if (status === null) checks.push(unknown("http-status", "Page returns success status", CATEGORIES.transport, "No HTTP response was received."));
  else if (status >= 200 && status < 300) checks.push(check("http-status", "Page returns success status", CATEGORIES.transport, "pass", `Final status is ${status}.`, ""));
  else checks.push(check("http-status", "Page returns success status", CATEGORIES.transport, "fail", `Final status is ${status}.`, "Fix the server response so the page returns 200."));

  // 3. Redirect hops
  const hops = obs.redirectHops ?? 0;
  if (status === null) checks.push(unknown("redirect-hops", "Short redirect chain", CATEGORIES.transport, "No HTTP response was received."));
  else if (hops <= 2) checks.push(check("redirect-hops", "Short redirect chain", CATEGORIES.transport, "pass", hops === 0 ? "No redirects." : `${hops} redirect hop${hops === 1 ? "" : "s"}.`, ""));
  else checks.push(check("redirect-hops", "Short redirect chain", CATEGORIES.transport, "fail", `${hops} redirect hops before the final page.`, "Link directly to the final URL and remove redirect hops."));

  // 4. Response weight
  const bytes = obs.htmlBytes ?? (html !== null ? Buffer.byteLength(html, "utf8") : null);
  if (obs.htmlTruncated) checks.push(check("response-weight", "Lean HTML payload", CATEGORIES.transport, "fail", "Page body exceeded the 1 MB fetch cap and was cut off.", "Reduce HTML size; move data to subresources."));
  else if (html === null || bytes === null) checks.push(unknown("response-weight", "Lean HTML payload", CATEGORIES.transport, "No page body was retrieved."));
  else if (bytes <= 200 * 1024) checks.push(check("response-weight", "Lean HTML payload", CATEGORIES.transport, "pass", `HTML body is ${(bytes / 1024).toFixed(1)} KB (within 200 KB).`, ""));
  else checks.push(check("response-weight", "Lean HTML payload", CATEGORIES.transport, "fail", `HTML body is ${(bytes / 1024).toFixed(1)} KB (over 200 KB).`, "Reduce inline HTML: paginate, code-split, or defer non-critical markup."));

  if (Number.isFinite(obs.elapsedMs) && obs.elapsedMs >= 0) checks[checks.length - 1].reason += ` Measured fetch response duration: ${Math.round(obs.elapsedMs)} ms; this is not a Core Web Vital.`;

  // 5. Index allowed
  if (html === null && headerRobots.length === 0) checks.push(unknown("index-allowed", "Page allows indexing", CATEGORIES.indexability, "No page body or header directives were retrieved."));
  else if (noindexHeader || noindexMeta) {
    const where = [noindexHeader ? "X-Robots-Tag header" : "", noindexMeta ? "robots meta tag" : ""].filter(Boolean).join(" and ");
    checks.push(check("index-allowed", "Page allows indexing", CATEGORIES.indexability, "fail", `noindex found in ${where}.`, "Remove noindex if this page should appear in search results."));
  } else checks.push(check("index-allowed", "Page allows indexing", CATEGORIES.indexability, "pass", "Neither header nor meta tag sets noindex.", ""));

  // 6. Header/meta parity
  if (html === null) checks.push(unknown("robots-parity", "Header and meta directives agree", CATEGORIES.indexability, "No page body was retrieved, so meta directives are unknown."));
  else if ((noindexHeader && !noindexMeta) || (!noindexHeader && noindexMeta) || (nofollowHeader && !nofollowMeta) || (!nofollowHeader && nofollowMeta)) {
    checks.push(check("robots-parity", "Header and meta directives agree", CATEGORIES.indexability, "fail", `X-Robots-Tag (${headerRobots.join(" ") || "none"}) conflicts with robots meta (${metaRobots.join(" ") || "none"}).`, "Make the header and the meta tag say the same thing; the stricter one wins in practice."));
  } else checks.push(check("robots-parity", "Header and meta directives agree", CATEGORIES.indexability, "pass", "Header and meta directives do not conflict.", ""));

  // 7. Canonical present
  if (head === null) checks.push(unknown("canonical-present", "Canonical tag present", CATEGORIES.indexability, "No page body was retrieved."));
  else if (!head.canonical) checks.push(check("canonical-present", "Canonical tag present", CATEGORIES.indexability, "fail", "No canonical link tag found.", 'Add <link rel="canonical" href="..."> with the absolute preferred URL.'));
  else if (!/^https?:\/\//i.test(head.canonical)) checks.push(check("canonical-present", "Canonical tag present", CATEGORIES.indexability, "fail", `Canonical href is not absolute: ${head.canonical}.`, "Use the absolute URL including https:// and host."));
  else checks.push(check("canonical-present", "Canonical tag present", CATEGORIES.indexability, "pass", `Canonical: ${head.canonical}.`, ""));

  // 8. Canonical parity
  if (head === null || !head.canonical) checks.push(unknown("canonical-parity", "Canonical matches final URL", CATEGORIES.indexability, "No usable canonical tag was found; presence is reported separately."));
  else {
    const a = normalizeUrl(head.canonical);
    const b = normalizeUrl(obs.finalUrl);
    if (a !== null && b !== null && a === b) checks.push(check("canonical-parity", "Canonical matches final URL", CATEGORIES.indexability, "pass", "Canonical points at the final URL.", ""));
    else if (a === null) checks.push(check("canonical-parity", "Canonical matches final URL", CATEGORIES.indexability, "fail", `Canonical href does not parse as a URL: ${head.canonical}.`, "Use the absolute preferred URL."));
    else checks.push(check("canonical-parity", "Canonical matches final URL", CATEGORIES.indexability, "fail", `Canonical (${head.canonical}) differs from the final URL.`, "Point the canonical at the final URL, or fix the redirect so they match."));
  }

  // Robots-based checks share one parse.
  let groups = null;
  let robotsState = "unknown"; // unknown | unavailable | ok
  if (obs.robotsTxt === undefined) robotsState = "unknown";
  else if (obs.robotsTxt === null) robotsState = "unavailable";
  else {
    robotsState = "ok";
    try {
      groups = parseRobots(obs.robotsTxt);
    } catch {
      robotsState = "unavailable";
      groups = null;
    }
  }
  let pagePath = "/";
  try {
    pagePath = new URL(obs.finalUrl).pathname || "/";
  } catch {
    pagePath = "/";
  }

  // 9. Search crawlers
  if (robotsState !== "ok") {
    checks.push(unknown("robots-search", "Search crawlers allowed (Googlebot, Bingbot)", CATEGORIES.crawl, robotsState === "unavailable" ? "No robots.txt was retrieved for the origin." : "robots.txt was not fetched."));
  } else {
    const verdicts = SEARCH_BOTS.map((b) => [b, robotsAllowed(groups, b, pagePath)]);
    const blocked = verdicts.filter(([, v]) => v === false);
    if (blocked.length === 0) checks.push(check("robots-search", "Search crawlers allowed (Googlebot, Bingbot)", CATEGORIES.crawl, "pass", `Allowed: ${verdicts.map(([b]) => b).join(", ")}.`, ""));
    else checks.push(check("robots-search", "Search crawlers allowed (Googlebot, Bingbot)", CATEGORIES.crawl, "fail", `Blocked for this page: ${blocked.map(([b]) => b).join(", ")}. This page cannot be indexed by them.`, "Allow the page in robots.txt if it should appear in search results."));
  }

  // 10. AI crawlers (reported separately from search; blocking can be intentional)
  if (robotsState !== "ok") {
    checks.push(unknown("robots-ai", "AI crawlers allowed (GPTBot, ClaudeBot, PerplexityBot, Applebot-Extended)", CATEGORIES.crawl, robotsState === "unavailable" ? "No robots.txt was retrieved for the origin." : "robots.txt was not fetched."));
  } else {
    const verdicts = AI_BOTS.map((b) => [b, robotsAllowed(groups, b, pagePath)]);
    const blocked = verdicts.filter(([, v]) => v === false).map(([b]) => b);
    const allowed = verdicts.filter(([, v]) => v !== false).map(([b]) => b);
    if (blocked.length === 0) checks.push(check("robots-ai", "AI crawlers allowed (GPTBot, ClaudeBot, PerplexityBot, Applebot-Extended)", CATEGORIES.crawl, "pass", `Allowed: ${allowed.join(", ")}.`, ""));
    else checks.push(check("robots-ai", "AI crawlers allowed (GPTBot, ClaudeBot, PerplexityBot, Applebot-Extended)", CATEGORIES.crawl, "fail", `Blocked for this page: ${blocked.join(", ")}. Only change this if you want AI search visibility.`, "Allow the page in robots.txt if you want these AI crawlers to read it; blocking is fine if deliberate."));
  }

  // A sitemap declaration is an observation, not proof that a page is listed.
  if (robotsState !== "ok") checks.push(unknown("sitemap", "Sitemap declared in robots.txt", CATEGORIES.crawl, "robots.txt was unavailable; sitemap declaration is unknown."));
  else if (/^\s*sitemap\s*:\s*https?:\/\/\S+/im.test(obs.robotsTxt)) checks.push(check("sitemap", "Sitemap declared in robots.txt", CATEGORIES.crawl, "pass", "A sitemap URL is declared; its contents were not checked.", ""));
  else checks.push(unknown("sitemap", "Sitemap declared in robots.txt", CATEGORIES.crawl, "No sitemap URL was declared in robots.txt. A sitemap may still be submitted elsewhere."));

  // 11. Title
  if (head === null) checks.push(unknown("title", "Descriptive title tag", CATEGORIES.content, "No page body was retrieved."));
  else if (!head.title) checks.push(check("title", "Descriptive title tag", CATEGORIES.content, "fail", "No title text found.", "Add a unique <title> describing the page."));
  else if (head.title.length < 10) checks.push(check("title", "Descriptive title tag", CATEGORIES.content, "fail", `Title is very short (${head.title.length} chars): "${head.title}".`, "Write a descriptive title of roughly 10-60 characters."));
  else if (head.title.length > 60) checks.push(check("title", "Descriptive title tag", CATEGORIES.content, "fail", `Title is long (${head.title.length} chars) and may be truncated in results: "${head.title}".`, "Shorten the title to roughly 10-60 characters."));
  else checks.push(check("title", "Descriptive title tag", CATEGORIES.content, "pass", `Title (${head.title.length} chars): "${head.title}".`, ""));

  // 12. Meta description
  if (head === null) checks.push(unknown("meta-description", "Meta description present", CATEGORIES.content, "No page body was retrieved."));
  else if (!head.description) checks.push(check("meta-description", "Meta description present", CATEGORIES.content, "fail", "No meta description found.", 'Add <meta name="description" content="..."> summarising the page.'));
  else if (head.description.length < 50 || head.description.length > 160) checks.push(check("meta-description", "Meta description present", CATEGORIES.content, "fail", `Description is ${head.description.length} chars (aim for 50-160).`, "Rewrite the description to roughly 50-160 characters."));
  else checks.push(check("meta-description", "Meta description present", CATEGORIES.content, "pass", `Description is ${head.description.length} chars.`, ""));

  // 13. H1
  if (head === null) checks.push(unknown("h1", "Single H1 heading", CATEGORIES.content, "No page body was retrieved."));
  else {
    const nonEmpty = head.h1s.filter((t) => t.length > 0);
    if (head.h1s.length === 0) checks.push(check("h1", "Single H1 heading", CATEGORIES.content, "fail", "No H1 found.", "Add one H1 describing the page."));
    else if (head.h1s.length > 1) checks.push(check("h1", "Single H1 heading", CATEGORIES.content, "fail", `Found ${head.h1s.length} H1 tags.`, "Keep one H1 per page; use H2/H3 for subsections."));
    else if (nonEmpty.length === 0) checks.push(check("h1", "Single H1 heading", CATEGORIES.content, "fail", "The H1 is empty.", "Give the H1 descriptive text."));
    else checks.push(check("h1", "Single H1 heading", CATEGORIES.content, "pass", `One H1: "${nonEmpty[0].slice(0, 80)}".`, ""));
  }

  // 14. html lang
  if (head === null) checks.push(unknown("html-lang", "HTML language set", CATEGORIES.content, "No page body was retrieved."));
  else if (!head.lang) checks.push(check("html-lang", "HTML language set", CATEGORIES.content, "fail", "No lang attribute on <html>.", 'Set <html lang="en"> (or the page locale).'));
  else if (!/^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{2,8})*$/.test(head.lang)) checks.push(check("html-lang", "HTML language set", CATEGORIES.content, "fail", `lang value looks invalid: "${head.lang}".`, "Use a BCP 47 tag such as en or pt-BR."));
  else checks.push(check("html-lang", "HTML language set", CATEGORIES.content, "pass", `lang="${head.lang}".`, ""));

  const langCheck = checks[checks.length - 1];
  if (head && head.hreflangs.length) {
    const valid = head.hreflangs.every(({ lang, href }) => {
      if (!/^(x-default|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/i.test(lang)) return false;
      try { return ["http:", "https:"].includes(new URL(href).protocol); } catch { return false; }
    });
    langCheck.title = "HTML language and hreflang";
    if (!valid) { langCheck.status = "fail"; langCheck.reason += " An hreflang alternate has an invalid language or URL."; langCheck.fix = "Use valid language tags and absolute HTTP(S) alternate URLs."; }
    else langCheck.reason += ` ${head.hreflangs.length} hreflang alternate(s) present; counterparts were not checked.`;
  } else if (head) langCheck.reason += " No hreflang alternates found; they are not required for every site.";

  // 15. Viewport
  if (head === null) checks.push(unknown("viewport", "Mobile viewport set", CATEGORIES.content, "No page body was retrieved."));
  else if (/width\s*=\s*device-width/i.test(head.viewport)) checks.push(check("viewport", "Mobile viewport set", CATEGORIES.content, "pass", "Viewport uses width=device-width.", ""));
  else if (!head.viewport) checks.push(check("viewport", "Mobile viewport set", CATEGORIES.content, "fail", "No viewport meta tag found.", 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.'));
  else checks.push(check("viewport", "Mobile viewport set", CATEGORIES.content, "fail", `Viewport does not use width=device-width: "${head.viewport}".`, "Set width=device-width so the page scales on mobile."));

  // 16. Open Graph
  if (head === null) checks.push(unknown("open-graph", "Open Graph title for sharing", CATEGORIES.content, "No page body was retrieved."));
  else if (!head.og["og:title"]) checks.push(check("open-graph", "Open Graph title for sharing", CATEGORIES.content, "fail", "No og:title found.", 'Add <meta property="og:title" content="..."> for link previews.'));
  else checks.push(check("open-graph", "Open Graph title for sharing", CATEGORIES.content, "pass", `og:title: "${head.og["og:title"].slice(0, 80)}".`, ""));

  // 17. JSON-LD
  if (head === null) checks.push(unknown("json-ld", "Structured data (JSON-LD) present", CATEGORIES.content, "No page body was retrieved."));
  else if (head.jsonLd.ok > 0 && head.jsonLd.bad === 0) checks.push(check("json-ld", "Structured data (JSON-LD) present", CATEGORIES.content, "pass", `${head.jsonLd.ok} JSON-LD block${head.jsonLd.ok === 1 ? "" : "s"} parsed. Presence only: content accuracy is not verified.`, ""));
  else if (head.jsonLd.bad > 0) checks.push(check("json-ld", "Structured data (JSON-LD) present", CATEGORIES.content, "fail", `${head.jsonLd.bad} JSON-LD block${head.jsonLd.bad === 1 ? "" : "s"} failed to parse.`, "Fix the JSON syntax in the broken script block."));
  else checks.push(check("json-ld", "Structured data (JSON-LD) present", CATEGORIES.content, "fail", "No JSON-LD structured data found.", "Consider adding JSON-LD matching visible page facts."));

  // 18. Image alt
  if (head === null) checks.push(unknown("image-alt", "Images have alt text", CATEGORIES.content, "No page body was retrieved."));
  else if (head.imgs.total === 0) checks.push(check("image-alt", "Images have alt text", CATEGORIES.content, "pass", "No images found.", ""));
  else if (head.imgs.missingAlt === 0) checks.push(check("image-alt", "Images have alt text", CATEGORIES.content, "pass", `All ${head.imgs.total} image${head.imgs.total === 1 ? "" : "s"} have alt text.`, ""));
  else checks.push(check("image-alt", "Images have alt text", CATEGORIES.content, "fail", `${head.imgs.missingAlt} of ${head.imgs.total} images missing alt text.`, "Add descriptive alt text to every informative image."));

  const summary = { total: checks.length, pass: 0, fail: 0, unknown: 0 };
  for (const c of checks) summary[c.status] += 1;
  return { url: obs.url, finalUrl: obs.finalUrl, checks, summary };
}
