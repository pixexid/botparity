import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { main } from "../bin/botparity.mjs";

test("CLI runs when invoked through a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "botparity-bin-"));
  const link = join(dir, "botparity");
  symlinkSync(new URL("../bin/botparity.mjs", import.meta.url), link);
  try {
    const result = spawnSync(process.execPath, [link, "https://127.0.0.1"], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /error: cannot check https:\/\/127\.0\.0\.1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
