import test from "node:test";
import assert from "node:assert/strict";
import { runChecks, parseHead, CHECK_COUNT } from "../src/checks.mjs";

const GOOD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Example page title here</title>
<meta name="description" content="A clear description of this example page that is long enough to pass.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://example.com/page">
<meta property="og:title" content="Example page">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage"}</script>
</head>
<body><h1>Hello</h1><img src="a.png" alt="demo"><p>text</p></body>
</html>`;

const baseObs = (over = {}) => ({
  url: "https://example.com/page",
  finalUrl: "https://example.com/page",
  status: 200,
  headers: {},
  html: GOOD_HTML,
  htmlBytes: Buffer.byteLength(GOOD_HTML),
  htmlTruncated: false,
  redirectHops: 0,
  robotsTxt: "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml",
  elapsedMs: 42,
  ...over,
});

const byId = (result) => Object.fromEntries(result.checks.map((c) => [c.id, c]));

test("checker runs exactly 19 checks with pass/fail/unknown only", () => {
  const r = runChecks(baseObs());
  assert.equal(r.checks.length, 19);
  assert.equal(r.checks.length, CHECK_COUNT);
  for (const c of r.checks) assert.ok(["pass", "fail", "unknown"].includes(c.status), c.id);
  assert.equal(r.summary.pass + r.summary.fail + r.summary.unknown, 19);
});

test("all-green page passes everything", () => {
  const r = runChecks(baseObs());
  assert.equal(r.summary.fail, 0);
  assert.equal(r.summary.unknown, 0);
});

test("no html means unknown, never fail", () => {
  const r = runChecks(baseObs({ html: null, htmlBytes: null, robotsTxt: undefined, status: null }));
  for (const c of r.checks) assert.notEqual(c.status, "fail", c.id);
  assert.ok(r.summary.unknown > 0);
});

test("parser: attribute order does not matter (content before name)", () => {
  const head = parseHead(`<head><meta content="desc text here for testing" name="description"></head>`);
  assert.equal(head.description, "desc text here for testing");
});

test("parser: single quotes, unquoted values, uppercase tags", () => {
  const head = parseHead(`<HEAD><META NAME='robots' CONTENT='noindex'><LINK REL=canonical HREF='https://example.com/x'></HEAD>`);
  assert.ok(head.robotsDirectives.includes("noindex"));
  assert.equal(head.canonical, "https://example.com/x");
});

test("parser: entities decoded in title, comments ignored", () => {
  const head = parseHead(`<head><!-- <title>fake</title> --><title>A &amp; B &#39;test&#39;</title></head>`);
  assert.equal(head.title, "A & B 'test'");
});

test("parser: first canonical wins, relative canonical fails presence", () => {
  const r = runChecks(baseObs({ html: GOOD_HTML.replace('href="https://example.com/page"', 'href="/page"') }));
  assert.equal(byId(r)["canonical-present"].status, "fail");
});

test("header/meta conflict fails parity in both directions", () => {
  const withHeader = (headers) => byId(runChecks(baseObs({ headers })))["robots-parity"].status;
  assert.equal(withHeader({ "x-robots-tag": "noindex" }), "fail"); // header noindex, meta index
  const html = GOOD_HTML.replace("</head>", `<meta name="robots" content="noindex">\n</head>`);
  assert.equal(byId(runChecks(baseObs({ html })))["robots-parity"].status, "fail"); // meta noindex, header clean
  assert.equal(byId(runChecks(baseObs({ headers: { "x-robots-tag": "noindex" }, html })))["index-allowed"].status, "fail");
});

test("canonical parity ignores trailing slash, flags wrong host", () => {
  const slash = GOOD_HTML.replace("https://example.com/page", "https://example.com/page/");
  assert.equal(byId(runChecks(baseObs({ html: slash })))["canonical-parity"].status, "pass");
  const other = GOOD_HTML.replace("https://example.com/page", "https://other.com/page");
  const c = byId(runChecks(baseObs({ html: other })))["canonical-parity"];
  assert.equal(c.status, "fail");
});

test("title/description boundaries discriminate", () => {
  const short = (t) => byId(runChecks(baseObs({ html: GOOD_HTML.replace("Example page title here", t) })))["title"].status;
  assert.equal(short("Hi"), "fail");
  assert.equal(short("x".repeat(61)), "fail");
  assert.equal(short("A fine title of proper length"), "pass");
  const noDesc = GOOD_HTML.replace(/<meta name="description"[^>]*>\n/, "");
  assert.equal(byId(runChecks(baseObs({ html: noDesc })))["meta-description"].status, "fail");
});

test("h1: zero and multiple fail, one passes", () => {
  const noH1 = GOOD_HTML.replace("<h1>Hello</h1>", "<p>Hello</p>");
  assert.equal(byId(runChecks(baseObs({ html: noH1 })))["h1"].status, "fail");
  const twoH1 = GOOD_HTML.replace("</h1>", "</h1><h1>Again</h1>");
  assert.equal(byId(runChecks(baseObs({ html: twoH1 })))["h1"].status, "fail");
});

test("viewport/lang/og/jsonld/img-alt each discriminate", () => {
  const noViewport = GOOD_HTML.replace(/<meta name="viewport"[^>]*>\n/, "");
  assert.equal(byId(runChecks(baseObs({ html: noViewport })))["viewport"].status, "fail");
  const noLang = GOOD_HTML.replace(' lang="en"', "");
  assert.equal(byId(runChecks(baseObs({ html: noLang })))["html-lang"].status, "fail");
  const noOg = GOOD_HTML.replace(/<meta property="og:title"[^>]*>\n/, "");
  assert.equal(byId(runChecks(baseObs({ html: noOg })))["open-graph"].status, "fail");
  const badJson = GOOD_HTML.replace('{"@context":"https://schema.org","@type":"WebPage"}', "{not json");
  assert.equal(byId(runChecks(baseObs({ html: badJson })))["json-ld"].status, "fail");
  const noAlt = GOOD_HTML.replace(' alt="demo"', "");
  assert.equal(byId(runChecks(baseObs({ html: noAlt })))["image-alt"].status, "fail");
});

test("redirect hops and status discriminate", () => {
  assert.equal(byId(runChecks(baseObs({ redirectHops: 3 })))["redirect-hops"].status, "fail");
  assert.equal(byId(runChecks(baseObs({ redirectHops: 2 })))["redirect-hops"].status, "pass");
  assert.equal(byId(runChecks(baseObs({ status: 404 })))["http-status"].status, "fail");
  assert.equal(byId(runChecks(baseObs({ finalUrl: "http://example.com/page" })))["https"].status, "fail");
});

test("oversize/truncated body fails weight, keeps content unknown-safe", () => {
  const r = runChecks(baseObs({ html: null, htmlBytes: 2 * 1024 * 1024, htmlTruncated: true }));
  assert.equal(byId(r)["response-weight"].status, "fail");
  assert.ok(r.checks.every((c) => c.status !== "fail" || c.id === "response-weight" || ["https", "http-status", "redirect-hops"].includes(c.id)));
});


test("sitemap, hreflang and measured duration remain honest", () => {
  let checks = byId(runChecks(baseObs()));
  assert.equal(checks.sitemap.status, "pass");
  assert.match(checks["response-weight"].reason, /42 ms.*not a Core Web Vital/);
  assert.match(checks["html-lang"].reason, /not required/);
  checks = byId(runChecks(baseObs({ robotsTxt: "User-agent: *\nAllow: /", html: GOOD_HTML.replace("</head>", '<link rel="alternate" hreflang="bad!" href="/relative"></head>') })));
  assert.equal(checks.sitemap.status, "unknown");
  assert.equal(checks["html-lang"].status, "fail");
});

test("hostile markup and robots rules produce unknown safely", () => {
  const result = byId(runChecks(baseObs({ html: "<title".repeat(100000), robotsTxt: "User-agent: *\n" + "Disallow: /*".repeat(10000) })));
  assert.equal(result.title.status, "unknown");
  assert.equal(byId(runChecks(baseObs({ html: "<h1>".repeat(3000) + "x".repeat(900000) }))).h1.status, "unknown");
  assert.equal(result["robots-search"].status, "unknown");
});
