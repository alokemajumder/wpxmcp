import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { installNodePlatform } from "../dist/platform-node.js";
import { SiteRegistry } from "../dist/lib/registry.js";
import { loadConfig } from "../dist/lib/config.js";

installNodePlatform();

/** A server that fails a set number of times before succeeding. */
function flakyServer(failures, status, extraHeaders = {}) {
  let seen = 0;
  const server = http.createServer((req, res) => {
    seen++;
    if (seen <= failures) {
      res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
      return res.end('{"code":"transient","message":"try again"}');
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port, seen: () => seen })));
}

function clientFor(port) {
  return new SiteRegistry(loadConfig({
    WPX_SITES: JSON.stringify([{ id: "t", url: `http://127.0.0.1:${port}`, username: "u", appPassword: "p", timeoutMs: 4000 }]),
  })).resolve();
}

test("a transient 502 on a read is retried and recovers", async () => {
  const { server, port, seen } = await flakyServer(2, 502);
  try {
    const res = await clientFor(port).get("/wp/v2/posts");
    assert.equal(res.data.ok, true);
    assert.equal(seen(), 3, "should have taken three attempts");
  } finally { server.close(); }
});

test("a 429 is retried", async () => {
  const { server, port, seen } = await flakyServer(1, 429, { "Retry-After": "0" });
  try {
    await clientFor(port).get("/wp/v2/posts");
    assert.equal(seen(), 2);
  } finally { server.close(); }
});

test("a 500 is not retried — it is usually a real PHP fatal", async () => {
  const { server, port, seen } = await flakyServer(5, 500);
  try {
    await assert.rejects(() => clientFor(port).get("/wp/v2/posts"));
    assert.equal(seen(), 1, "a 500 should fail on the first attempt");
  } finally { server.close(); }
});

test("a write is never replayed", async () => {
  const { server, port, seen } = await flakyServer(2, 502);
  try {
    await assert.rejects(() => clientFor(port).post("/wp/v2/posts", { title: "x" }));
    assert.equal(seen(), 1, "replaying a POST could create duplicate content");
  } finally { server.close(); }
});

test("HTML on a 200 is reported as an error, not returned as data", async () => {
  // A WAF or login wall answering instead of WordPress.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><html><body>Checking your browser</body></html>");
  });
  await new Promise((r) => server.listen(0, r));
  try {
    await assert.rejects(
      () => clientFor(server.address().port).get("/wp/v2/posts"),
      (e) => /HTML where JSON was expected/.test(e.message)
    );
  } finally { server.close(); }
});

test("a timeout is reported once, not retried", async () => {
  const server = http.createServer(() => { /* never responds */ });
  await new Promise((r) => server.listen(0, r));
  const client = new SiteRegistry(loadConfig({
    WPX_SITES: JSON.stringify([{ id: "t", url: `http://127.0.0.1:${server.address().port}`, timeoutMs: 300 }]),
  })).resolve();
  const started = Date.now();
  try {
    await assert.rejects(() => client.get("/wp/v2/posts"), /timed out after 300ms/);
    // Retrying a timeout would multiply the wait past the caller's budget.
    assert.ok(Date.now() - started < 900, "a timeout must not be retried");
  } finally { server.close(); }
});
