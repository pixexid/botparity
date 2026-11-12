import test from "node:test";
import assert from "node:assert/strict";
import { parseRobots, robotsAllowed, runChecks } from "../src/checks.mjs";

const obsWith = (robotsTxt) => ({
  url: "https://example.com/page",
  finalUrl: "https://example.com/page",
  status: 200,
  headers: {},
  html: `<html lang="en"><head><title>A decent page title</title></head><body><h1>Hi</h1></body></html>`,
  htmlBytes: 120,
  htmlTruncated: false,
  redirectHops: 0,
  robotsTxt,
  elapsedMs: 1,
});

test("specific group beats wildcard for the named bot", () => {
  const groups = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /");
  assert.equal(robotsAllowed(groups, "Googlebot", "/page"), true);
  assert.equal(robotsAllowed(groups, "Bingbot", "/page"), false);
});

test("longest match wins; Allow wins ties", () => {
  const groups = parseRobots("User-agent: *\nDisallow: /page\nAllow: /page\nDisallow: /page/sub\nAllow: /");
  assert.equal(robotsAllowed(groups, "Somebot", "/page"), true); // tie -> Allow
  assert.equal(robotsAllowed(groups, "Somebot", "/page/sub"), false); // longer Disallow wins
  assert.equal(robotsAllowed(groups, "Somebot", "/page/sub/deep"), false); // prefix of longer rule
  assert.equal(robotsAllowed(groups, "Somebot", "/"), true);
});

test("wildcards and end anchors", () => {
  const groups = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp/");
  assert.equal(robotsAllowed(groups, "Somebot", "/files/doc.pdf"), false);
  assert.equal(robotsAllowed(groups, "Somebot", "/files/doc.pdf?v=1"), true);
  assert.equal(robotsAllowed(groups, "Somebot", "/tmp/x"), false);
});

test("matching is case-insensitive; empty file allows all", () => {
  const groups = parseRobots("USER-AGENT: gptbot\nDISALLOW: /secret");
  assert.equal(robotsAllowed(groups, "GPTBot", "/secret"), false);
  assert.equal(robotsAllowed([], "GPTBot", "/secret"), true);
});

test("search vs AI bots reported separately; unavailable robots is unknown", () => {
  const txt = "User-agent: Googlebot\nAllow: /\nUser-agent: Bingbot\nAllow: /\nUser-agent: GPTBot\nDisallow: /\nUser-agent: ClaudeBot\nDisallow: /\nUser-agent: PerplexityBot\nDisallow: /\nUser-agent: Applebot-Extended\nDisallow: /";
  const r = runChecks(obsWith(txt));
  const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.equal(byId["robots-search"].status, "pass");
  assert.equal(byId["robots-ai"].status, "fail");
  assert.match(byId["robots-ai"].reason, /GPTBot/);

  const missing = runChecks(obsWith(null));
  const m = Object.fromEntries(missing.checks.map((c) => [c.id, c]));
  assert.equal(m["robots-search"].status, "unknown");
  assert.equal(m["robots-ai"].status, "unknown");

  const unfetched = runChecks(obsWith(undefined));
  const u = Object.fromEntries(unfetched.checks.map((c) => [c.id, c]));
  assert.equal(u["robots-search"].status, "unknown");
  assert.equal(u["robots-ai"].status, "unknown");
});

test("blocked search bots fail with fix hint", () => {
  const r = runChecks(obsWith("User-agent: *\nDisallow: /"));
  const c = r.checks.find((x) => x.id === "robots-search");
  assert.equal(c.status, "fail");
  assert.ok(c.fix.length > 0);
});
