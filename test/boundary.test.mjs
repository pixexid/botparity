import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isPrivateIp, assertPublicUrl, resolvePublic, fetchBounded } from "../bin/botparity.mjs";

test("private ranges rejected, public addresses pass", () => {
  for (const ip of ["100.64.0.1", "64:ff9b::7f00:1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "::ffff:7f00:1", "2001:db8::1", "3fff::1", "fe80::1%lo0", "invalid", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "127.0.0.1", "169.254.169.254", "0.0.0.0", "::1", "::", "fe80::1", "fc00::1", "fd00::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "192.167.0.1", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("URL validation rejects credentials, ports, literals, localhost, schemes", () => {
  assert.throws(() => assertPublicUrl(new URL("https://user@example.com/")), /credentials/);
  assert.throws(() => assertPublicUrl(new URL("https://example.com:8443/")), /port/);
  assert.throws(() => assertPublicUrl(new URL("http://93.184.216.34/")), /IP literals/);
  assert.throws(() => assertPublicUrl(new URL("http://[::1]/")), /IP literals/);
  assert.throws(() => assertPublicUrl(new URL("http://localhost/")), /localhost/);
  assert.throws(() => assertPublicUrl(new URL("ftp://example.com/")), /http\/https/);
  assert.doesNotThrow(() => assertPublicUrl(new URL("https://example.com/")));
});

test("DNS resolving to private address is blocked", async () => {
  const fakeLookup = (_h, _o, cb) => cb(null, "10.0.0.1", 4);
  await assert.rejects(() => resolvePublic("example.com", fakeLookup), /non-public/);
});

test("redirect to private address is blocked", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/go") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const allowLoopback = (h, o, cb) => cb(null, "127.0.0.1", 4);
  try {
    await assert.rejects(
      fetchBounded(`http://localhost:${port}/go`, {
        deadline: Date.now() + 3000,
        byteCap: 1024,
        maxRedirects: 5,
        lookup: allowLoopback,
        unsafeTestLoopback: true,
      }),
      /blocked: IP literals/,
    );
  } finally {
    server.close();
  }
});

test("oversize body is truncated, not buffered whole", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("x".repeat(10000));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const allowLoopback = (h, o, cb) => cb(null, "127.0.0.1", 4);
  try {
    const res = await fetchBounded(`http://localhost:${port}/`, {
      deadline: Date.now() + 3000,
      byteCap: 100,
      maxRedirects: 5,
      lookup: allowLoopback,
      unsafeTestLoopback: true,
    });
    assert.equal(res.truncated, true);
    assert.ok(res.bytes > 100);
  } finally {
    server.close();
  }
});

test("slow server hits the deadline", async () => {
  const server = http.createServer((_req, _res) => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const allowLoopback = (h, o, cb) => cb(null, "127.0.0.1", 4);
  try {
    await assert.rejects(
      fetchBounded(`http://localhost:${port}/`, {
        deadline: Date.now() + 200,
        byteCap: 1024,
        maxRedirects: 5,
        lookup: allowLoopback,
        unsafeTestLoopback: true,
      }),
      /timed out/,
    );
  } finally {
    server.close();
  }
});

test("DNS deadline prevents a late lookup from connecting", async () => {
  let callback;
  const lookup = (_h, _o, cb) => { callback = cb; };
  await assert.rejects(fetchBounded("http://example.com/", {
    deadline: Date.now() + 80, byteCap: 1024, maxRedirects: 5, lookup,
  }), /timed out/);
  callback(null, "127.0.0.1", 4);
});

test("trickling response cannot extend absolute deadline", async () => {
  const server = http.createServer((_req, res) => {
    let count = 0;
    const timer = setInterval(() => { res.write("x"); if (++count === 12) res.end(); }, 20);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(fetchBounded(`http://localhost:${server.address().port}/`, {
      deadline: Date.now() + 100, byteCap: 1024, maxRedirects: 5,
      lookup: (_h, _o, cb) => cb(null, "127.0.0.1", 4), unsafeTestLoopback: true,
    }), /timed out/);
  } finally { server.closeAllConnections(); server.close(); }
});
