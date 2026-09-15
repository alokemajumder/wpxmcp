import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { installNodePlatform } from "../dist/platform-node.js";
import { SiteRegistry } from "../dist/lib/registry.js";
import { loadConfig } from "../dist/lib/config.js";
import { inspectSql, enforceRowLimit, fingerprintOp } from "../dist/lib/safety.js";
import { applyEdits } from "../dist/lib/content-utils.js";

installNodePlatform();

/* ------------------------------- config ------------------------------ */

test("a JSON error in WPX_SITES never echoes the secret it contains", () => {
  assert.throws(
    () => loadConfig({ WPX_SITES: '[{"id":"m","url":"https://x.test","appPassword": abcd efgh ijkl}]' }),
    (e) => /Could not parse WPX_SITES/.test(e.message) && !e.message.includes("abcd")
  );
});

test("string booleans are parsed, so writable: \"false\" really is read-only", () => {
  const config = loadConfig({
    WPX_SITES: JSON.stringify([{ id: "p", url: "https://p.test", writable: "false", allowInsecureTLS: "false" }]),
  });
  assert.equal(config.sites[0].writable, false);
  assert.equal(config.sites[0].allowInsecureTLS, false);
  assert.throws(() => loadConfig({ WPX_SITES: JSON.stringify([{ id: "p", url: "https://p.test", writable: "nope" }]) }), /not a boolean/);
});

test("a non-numeric timeout is rejected rather than timing out every request", () => {
  assert.throws(() => loadConfig({ WPX_SITES: JSON.stringify([{ id: "p", url: "https://p.test", timeoutMs: "abc" }]) }), /timeoutMs/);
});

test("site URLs drop a pasted /wp-json and query, and restPrefix gains its slash", () => {
  const config = loadConfig({
    WPX_SITES: JSON.stringify([{ id: "p", url: "https://example.com/blog/wp-json/?x=1", restPrefix: "wp-json" }]),
  });
  assert.equal(config.sites[0].url, "https://example.com/blog");
  const client = new SiteRegistry(config).resolve();
  assert.equal(client.buildUrl("/wp/v2/posts"), "https://example.com/blog/wp-json/wp/v2/posts");
  assert.throws(() => loadConfig({ WORDPRESS_URL: "https://exa mple.com" }), /invalid url/);
});

/* ------------------------------- client ------------------------------ */

test("a query string inside the route survives ?rest_route= mode", () => {
  const client = new SiteRegistry(loadConfig({
    WPX_SITES: JSON.stringify([{ id: "p", url: "https://example.com", restPrefix: "/?rest_route=" }]),
  })).resolve();
  const url = new URL(client.buildUrl("/wp/v2/posts?status=draft", { per_page: 5 }));
  assert.equal(url.searchParams.get("rest_route"), "/wp/v2/posts");
  assert.equal(url.searchParams.get("status"), "draft");
  assert.equal(url.searchParams.get("per_page"), "5");
});

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}
const clientAt = (port, extra = {}) =>
  new SiteRegistry(loadConfig({
    WPX_SITES: JSON.stringify([{ id: "t", url: `http://127.0.0.1:${port}`, username: "u", appPassword: "p", timeoutMs: 1500, ...extra }]),
  })).resolve();

test("a redirected POST is stopped instead of silently becoming a GET", async () => {
  const methods = [];
  const server = await serve((req, res) => {
    methods.push(req.method);
    if (req.url.startsWith("/wp-json/wp/v2/posts") && !req.url.includes("moved")) {
      res.writeHead(301, { Location: "/wp-json/wp/v2/posts?moved=1" });
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("[]");
  });
  try {
    await assert.rejects(() => clientAt(server.address().port).post("/wp/v2/posts", { title: "x" }), (e) => e.code === "redirect");
    assert.deepEqual(methods, ["POST"], "the redirect must not be followed as a GET");
  } finally { server.close(); }
});

test("a same-origin redirect on a read is followed with credentials intact", async () => {
  const server = await serve((req, res) => {
    if (!req.url.includes("moved")) {
      res.writeHead(302, { Location: "/wp-json/wp/v2/posts?moved=1" });
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
  });
  try {
    const res = await clientAt(server.address().port).get("/wp/v2/posts");
    assert.match(res.data.auth, /^Basic /);
  } finally { server.close(); }
});

test("a cross-origin redirect is refused so site headers never leave the origin", async () => {
  let leaked = false;
  const other = await serve((req, res) => { leaked = Boolean(req.headers["x-gate"]); res.end("{}"); });
  const server = await serve((req, res) => {
    res.writeHead(301, { Location: `http://localhost:${other.address().port}/wp-json/wp/v2/posts` });
    res.end();
  });
  try {
    await assert.rejects(() => clientAt(server.address().port, { headers: { "X-Gate": "secret" } }).get("/wp/v2/posts"), (e) => e.code === "redirect" && /different origin/.test(e.hint));
    assert.equal(leaked, false);
  } finally { server.close(); other.close(); }
});

test("a body that stalls after the headers still times out", async () => {
  const server = await serve((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write("[");
  });
  try {
    await assert.rejects(() => clientAt(server.address().port, { timeoutMs: 300 }).get("/wp/v2/posts"), /timed out/);
  } finally { server.closeAllConnections(); server.close(); }
});

test("JSON behind a PHP warning is recovered", async () => {
  const server = await serve((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end('<br />\n<b>Deprecated</b>:  Creation of dynamic property in <b>/var/www/x.php</b> on line <b>12</b><br />\n{"id":5}');
  });
  try {
    const res = await clientAt(server.address().port).get("/wp/v2/posts/5");
    assert.equal(res.data.id, 5);
  } finally { server.close(); }
});

test("a declared-JSON body that does not parse is an error, not a string", async () => {
  const server = await serve((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"id":');
  });
  try {
    await assert.rejects(() => clientAt(server.address().port).get("/wp/v2/posts/5"), (e) => e.code === "invalid_json");
  } finally { server.close(); }
});

/* ------------------------------ SQL guard ---------------------------- */

test("comment markers inside string literals are data, not comments", () => {
  const v = inspectSql("SELECT * FROM wp_options WHERE option_value LIKE '%#fff%' AND option_name <> '-- x'", false);
  assert.equal(v.allowed, true);
  assert.match(v.normalized, /'%#fff%' AND option_name <> '-- x'$/, "nothing after # or -- may be cut off");
});

test("whitespace inside a literal is preserved, so a mutation writes what was asked", () => {
  const v = inspectSql("UPDATE wp_posts SET post_content = 'a\n\n  b' WHERE ID = 1", true);
  assert.equal(v.normalized, "UPDATE wp_posts SET post_content = 'a\n\n  b' WHERE ID = 1");
});

test("keywords and semicolons inside strings do not trip the guard", () => {
  const v = inspectSql("SELECT ID FROM wp_posts WHERE post_title = 'How to delete; or update'", false);
  assert.equal(v.allowed, true);
  assert.equal(v.mutating, false);
});

test("MySQL executable comments are treated as code", () => {
  const v = inspectSql("SELECT user_pass FROM wp_users /*!50000 INTO OUTFILE '/tmp/x' */", false);
  assert.equal(v.allowed, false);
  assert.match(v.normalized, /INTO OUTFILE/);
});

test("a -- without trailing whitespace is not a comment in MySQL", () => {
  const v = inspectSql("SELECT ID --ID INTO OUTFILE '/tmp/x' FROM wp_users", false);
  assert.equal(v.allowed, false, "MySQL reads --ID as minus minus ID, so the OUTFILE runs");
});

test("a string that only closes without backslash escapes cannot hide a keyword", () => {
  // Under NO_BACKSLASH_ESCAPES '\\' is a complete string and INTO OUTFILE is live.
  const v = inspectSql("SELECT '\\', 1 INTO OUTFILE '/tmp/x' -- '", false);
  assert.equal(v.allowed, false);
});

test("file reads and deliberate stalls need approval", () => {
  for (const q of ["SELECT LOAD_FILE('/etc/passwd')", "SELECT SLEEP(600)", "SELECT BENCHMARK(1e9, MD5('a'))"]) {
    assert.equal(inspectSql(q, false).allowed, false, `${q} should be refused`);
  }
});

test("REPLACE(), INSERT() and TRUNCATE() as functions are ordinary reads", () => {
  for (const q of ["SELECT REPLACE(post_content, 'http:', 'https:') FROM wp_posts", "SELECT TRUNCATE(1.25, 1)", "SELECT INSERT('abc', 1, 1, 'x')"]) {
    assert.equal(inspectSql(q, false).allowed, true, `${q} should be allowed`);
  }
  assert.equal(inspectSql("REPLACE INTO wp_options (option_name) VALUES ('x')", false).allowed, false);
});

test("a data-modifying CTE is still caught", () => {
  assert.equal(inspectSql("WITH t AS (SELECT 1) DELETE FROM wp_posts", false).allowed, false);
});

test("the row limit ignores LIMITs in subqueries and cannot be commented out", () => {
  assert.equal(enforceRowLimit("SELECT * FROM (SELECT * FROM wp_posts LIMIT 5) t", 50).applied, true);
  assert.equal(enforceRowLimit("SELECT * FROM wp_posts -- all of them", 50).query, "SELECT * FROM wp_posts LIMIT 50");
  assert.equal(enforceRowLimit("SELECT * FROM wp_posts WHERE post_title = 'limit 5'", 50).applied, true);
});

test("fingerprints distinguish non-ASCII arguments", () => {
  assert.notEqual(fingerprintOp(["x", "Ā"]), fingerprintOp(["x", " "]));
});

/* ------------------------------- edits ------------------------------- */

test("a literal edit inserts $ sequences verbatim", () => {
  const out = applyEdits("<p>price</p><p>tail</p>", [{ find: "price", replace: "costs $' or $&" }]);
  assert.equal(out.content, "<p>costs $' or $&</p><p>tail</p>");
});

/* ------------------------ shared spent tokens ------------------------ */

test("a token spent in another isolate is refused when a shared store is available", async () => {
  const { platform, setPlatform } = await import("../dist/lib/platform.js");
  const { issueConfirmation, consumeConfirmation, fingerprintOp: fp } = await import("../dist/lib/safety.js");
  const original = platform();
  const store = new Map();
  setPlatform({ ...original, spentTokens: { has: async (h) => store.has(h), add: async (h, x) => void store.set(h, x) } });
  try {
    const f = fp(["shared", 1]);
    const token = await issueConfirmation("site", "shared store", f);
    assert.equal((await consumeConfirmation(token, f)).valid, true);
    assert.equal(store.size, 1, "the spent token is recorded in the shared store");

    // Simulate a different isolate: a fresh token whose hash is already in the store.
    const other = await issueConfirmation("site", "shared store", f);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(other)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    store.set(hash, Date.now() + 60_000);
    const replay = await consumeConfirmation(other, f);
    assert.equal(replay.valid, false);
    assert.match(replay.reason, /already been used/);
  } finally {
    setPlatform(original);
  }
});
