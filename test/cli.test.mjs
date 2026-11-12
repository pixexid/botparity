import test from "node:test";
import assert from "node:assert/strict";
import { main } from "../bin/botparity.mjs";

test("CLI treats only text/plain robots responses as rules", async () => {
  const originalLog = console.log;
  try {
    for (const [type, expected] of [["text/plain; charset=utf-8", "fail"], ["text/html", "unknown"], ["application/json", "unknown"]]) {
      let output;
      console.log = (value) => { output = JSON.parse(value); };
      await main(["node", "botparity", "https://example.com/", "--json"], {
        fetch: async (url) => url.endsWith("/robots.txt")
          ? { status: 200, headers: { "content-type": type }, body: "User-agent: *\nDisallow: /", truncated: false }
          : { status: 200, headers: {}, body: "<html></html>", bytes: 13, truncated: false, finalUrl: url, redirectHops: 0 },
      });
      assert.equal(output.checks.find((check) => check.id === "robots-search").status, expected, type);
    }
  } finally { console.log = originalLog; }
});
