import { test } from "node:test";
import assert from "node:assert/strict";
import {
  profileFindings, shapeReport, compactAssets, withoutToken, fmtMs, runProfile, profilerTools,
  DEFAULT_SECTIONS, PROFILE_SECTIONS,
} from "../dist/tools/profiler.js";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

/** A WordPressClient stand-in recording REST calls. */
function fakeClient({ helper = true, results = [], tokenResponse } = {}) {
  const calls = [];
  return {
    calls,
    site: { id: "t", url: "https://example.test", headers: { "X-Gate": "1" } },
    async hasHelperPlugin() { return helper; },
    async post(route, body) {
      calls.push({ method: "POST", route, body });
      return { data: tokenResponse ?? { token: TOKEN } };
    },
    async get(route, query) {
      calls.push({ method: "GET", route, query });
      return { data: results.length ? results.shift() : { ready: false, state: "none" } };
    },
  };
}

/** Replaces global fetch for one test. */
function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = original; });
}

const html = (status = 200, headers = {}) => new Response(status >= 300 && status < 400 ? null : "<html>ok</html>", { status, headers });

/* ------------------------------ findings ------------------------------ */

test("findings: flags many queries, duplicates, slow queries and plugin attribution", () => {
  const f = profileFindings({
    request: { status: 200, server_ms: 120 },
    queries: {
      count: 180, total_ms: 250, timed: true, duplicate_groups: 2,
      duplicates: [{ sql: "SELECT 1", count: 40, callers: ["related_posts()"] }, { sql: "SELECT 2", count: 3, callers: [] }],
      slowest: [{ ms: 90, caller: "WP_Query->get_posts()", component: "plugin:shop" }, { ms: 1, caller: "x", component: "core" }],
      by_component: [{ component: "core", count: 50 }, { component: "plugin:shop", count: 130 }],
    },
  }, { slowQueryMs: 5 });
  const text = f.join("\n");
  assert.match(text, /180 database queries/);
  assert.match(text, /2 distinct queries ran more than once \(41 redundant executions\); worst ran 40× from related_posts\(\)/);
  assert.match(text, /1 slow query \(≥ 5ms\); slowest 90ms from WP_Query->get_posts\(\) \[plugin:shop\]/);
  assert.match(text, /plugin:shop issues 130 queries/);
  assert.match(text, /took 250ms in total/);
});

test("findings: slow external HTTP, failed calls, PHP warnings (silenced ones ignored), child theme", () => {
  const f = profileFindings({
    request: { status: 200 },
    http: { calls: [
      { url: "https://api.example.com/v1?key=…", ms: 1200, status: 200, component: "plugin:social", blocking: true },
      { url: "http://down.example/", ms: 3, status: null, error: "cURL error 7", component: "theme:x", blocking: true },
    ] },
    errors: { count: 3, reported_count: 1, items: [
      { level: "deprecated", message: "old", file: "a.php", line: 1, component: "core", count: 2, silenced: true },
      { level: "warning", message: "Undefined array key", file: "wp-content/plugins/p/p.php", line: 9, component: "plugin:p", count: 1, silenced: false },
    ] },
    template: { file: "wp-content/themes/child/single.php", from_child_theme: true },
  });
  const text = f.join("\n");
  assert.match(text, /Slow external HTTP call to https:\/\/api\.example\.com\/v1\?key=… took 1\.20s \(plugin:social\)/);
  assert.match(text, /failed: cURL error 7/);
  assert.match(text, /PHP warning on page: 1 — e\.g\. "Undefined array key" in wp-content\/plugins\/p\/p\.php:9 \[plugin:p\]/);
  assert.doesNotMatch(text, /deprecated/);
  assert.match(text, /child theme: wp-content\/themes\/child\/single\.php/);
});

test("findings: redirect, 404, customised block templates, fatal errors, memory pressure", () => {
  const f = profileFindings({
    request: { status: 301, redirect_to: "https://example.test/new/", fatal_error: { component: "plugin:x", message: "boom", file: "f.php", line: 2 } },
    template: { block_template: { slug: "single", customized_in_database: true }, template_parts: [{ slug: "header", customized_in_database: true }, { slug: "footer", customized_in_database: false }] },
    memory: { peak_bytes: 110 * 1048576, limit_bytes: 128 * 1048576, object_cache: { persistent: true } },
  }, { timing: { status: 404 } });
  const text = f.join("\n");
  assert.match(text, /redirects \(HTTP 301\) to https:\/\/example\.test\/new\//);
  assert.match(text, /404/);
  assert.match(text, /Block template "single" has been customised/);
  assert.match(text, /Template part customised in the database .*: header\./);
  assert.match(text, /PHP fatal error in plugin:x: boom/);
  assert.match(text, /Peak memory 110\.0MB is 86% of the PHP memory limit/);
});

test("findings: a clean fast page produces no findings", () => {
  assert.deepEqual(profileFindings({
    request: { status: 200, server_ms: 30 },
    queries: { count: 22, total_ms: 5, timed: true, duplicates: [], slowest: [{ ms: 0.6 }], by_component: [{ component: "core", count: 22 }] },
    http: { calls: [] }, errors: { count: 0, reported_count: 0, items: [] },
    memory: { peak_bytes: 8e6, limit_bytes: 134217728, object_cache: { persistent: false } },
  }, { timing: { status: 200, ttfb_ms: 40 } }), []);
});

test("findings: untimed queries are called out instead of reported as fast", () => {
  const f = profileFindings({ queries: { count: 3, total_ms: null, timed: false, duplicates: [], slowest: [{ ms: null }] } });
  assert.match(f.join("\n"), /SAVEQUERIES is defined as false/);
});

/* ------------------------------ shaping ------------------------------ */

test("shapeReport keeps only queries at the slow threshold and drops false conditionals", () => {
  const timing = { status: 200, final_status: 200, final_url: "https://example.test/", content_type: "text/html", ttfb_ms: 10, total_ms: 12, total_with_redirects_ms: 12, bytes: 100, redirects: [] };
  const out = shapeReport("https://example.test/", timing, {
    request: { server_ms: 9 },
    conditionals: { true: ["is_home"], false: ["is_404"], queried_object: null, request_vars: {}, query_vars: {} },
    queries: { count: 3, total_ms: 12, timed: true, slowest: [{ ms: 8 }, { ms: 5 }, { ms: 1 }], duplicates: [] },
  }, 5);
  assert.deepEqual(out.queries.slow.map((q) => q.ms), [8, 5]);
  assert.equal(out.queries.slowest_ms, 8);
  assert.equal(out.conditionals.false, undefined);
  assert.deepEqual(out.conditionals.true, ["is_home"]);
  assert.equal(out.timing.server_ms, 9);
  assert.equal(out.redirects, undefined);
});

test("compactAssets separates downloaded files from inline-only handles", () => {
  const out = compactAssets({
    scripts: { count: 1, known_size_bytes: 10, items: [{ handle: "a", src: "/wp-content/plugins/p/a.js", deps: [], ver: "1", in_footer: true, size_bytes: 10, component: "plugin:p" }] },
    styles: { count: 2, known_size_bytes: 0, items: [{ handle: "s", src: null, deps: [], component: "inline" }, { handle: "t", src: "https://cdn.x/t.css", deps: ["s"], component: "external:cdn.x" }] },
  });
  assert.equal(out.scripts.files, 1);
  assert.equal(out.styles.inline_only, 1);
  assert.deepEqual(out.styles.inline_handles, ["s"]);
  assert.deepEqual(out.styles.items[0].deps, ["s"]);
  assert.deepEqual(out.by_component, { "plugin:p": 1, inline: 1, "external:cdn.x": 1 });
});

test("withoutToken and fmtMs", () => {
  assert.equal(withoutToken(`https://e.test/?p=1&wpxmcp_profile=${TOKEN}`), "https://e.test/?p=1");
  assert.equal(fmtMs(0.685), "0.69ms");
  assert.equal(fmtMs(42.4), "42ms");
  assert.equal(fmtMs(1500), "1.50s");
});

test("sections: hooks is opt-in; the schema accepts every section", () => {
  assert.ok(!DEFAULT_SECTIONS.includes("hooks"));
  assert.equal(DEFAULT_SECTIONS.length, PROFILE_SECTIONS.length - 1);
  const tools = profilerTools({ registry: { resolve: () => fakeClient() } });
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get_template_for_url", "profile_url"]);
  for (const t of tools) assert.equal(t.readOnly, true);
});

/* ------------------------------ flow ------------------------------ */

test("flow: token issued for the validated URL, page fetched with the token, report collected", async () => {
  const client = fakeClient({ results: [{ ready: false, state: "none" }, { ready: true, report: { request: { status: 200, server_ms: 5 } } }] });
  const fetched = [];
  await withFetch(async (url, init) => {
    fetched.push({ url: String(url), init });
    return html(200, { "content-type": "text/html" });
  }, async () => {
    const run = await runProfile(client, "profile_url", { url: "/about/?x=1", sections: ["template"], asLoggedIn: false });
    assert.equal(run.url, "https://example.test/about/?x=1");
    assert.equal(run.report.request.status, 200);
    assert.equal(run.timing.status, 200);
  });
  const post = client.calls.find((c) => c.method === "POST");
  assert.equal(post.route, "/wpxmcp/v1/profile/token");
  assert.deepEqual(post.body, { url: "https://example.test/about/?x=1", sections: ["template"], as_logged_in: false });
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, `https://example.test/about/?x=1&wpxmcp_profile=${TOKEN}`);
  assert.equal(fetched[0].init.redirect, "manual");
  // No REST credentials go to the front end; only the site's own custom headers.
  assert.equal(fetched[0].init.headers.Authorization, undefined);
  assert.equal(fetched[0].init.headers["X-Gate"], "1");
  assert.ok(client.calls.filter((c) => c.route === "/wpxmcp/v1/profile/result").every((c) => c.query.token === TOKEN));
});

test("flow: refuses other hosts before issuing a token; protocol-relative input stays on the site", async () => {
  const client = fakeClient();
  await assert.rejects(runProfile(client, "profile_url", { url: "https://evil.test/", sections: ["template"], asLoggedIn: false }), /only profiles pages on the configured site/);
  assert.equal(client.calls.length, 0);

  const fetched = [];
  await withFetch(async (url) => { fetched.push(new URL(String(url))); return html(200); }, async () => {
    const run = await runProfile(fakeClient({ results: [{ ready: true, report: { request: {} } }] }), "profile_url", { url: "//evil.test/x", sections: ["template"], asLoggedIn: false });
    assert.equal(new URL(run.url).hostname, "example.test");
  });
  assert.ok(fetched.every((u) => u.hostname === "example.test"));
});

test("flow: needs the companion plugin", async () => {
  await assert.rejects(runProfile(fakeClient({ helper: false }), "profile_url", { url: "/", sections: ["template"], asLoggedIn: false }), /companion plugin/);
});

test("flow: same-site redirects are followed and reported; off-site redirects are not followed; token never shown", async () => {
  const client = fakeClient({ results: [{ ready: true, report: { request: { status: 301 } } }] });
  const fetched = [];
  await withFetch(async (url) => {
    fetched.push(String(url));
    if (fetched.length === 1) return html(301, { location: `/new/?wpxmcp_profile=${TOKEN}` });
    return html(302, { location: "https://evil.test/steal" });
  }, async () => {
    const run = await runProfile(client, "profile_url", { url: "/old/", sections: ["template"], asLoggedIn: false });
    assert.equal(run.timing.status, 301);
    assert.deepEqual(run.timing.redirects, ["https://example.test/new/"]);
    assert.equal(run.timing.redirect_not_followed, "https://evil.test/steal");
    assert.ok(!JSON.stringify(run.timing).includes(TOKEN));
  });
  assert.equal(fetched.length, 2);
  assert.ok(!fetched.some((u) => u.includes("evil.test")));
});

test("flow: an unused token explains that a cache answered; a path mismatch is surfaced", async () => {
  await withFetch(async () => html(200), async () => {
    const cached = await runProfile(fakeClient({ results: Array(20).fill({ ready: false, state: "unused" }) }), "profile_url", { url: "/", sections: ["template"], asLoggedIn: false });
    assert.equal(cached.report, undefined);
    assert.match(cached.problem, /page cache/);

    const mismatch = await runProfile(fakeClient({ results: [{ ready: true, report: { error: "path_mismatch", message: "different URL" } }] }), "profile_url", { url: "/", sections: ["template"], asLoggedIn: false });
    assert.equal(mismatch.problem, "different URL");
  });
});

test("flow: a malformed token from the plugin is rejected rather than appended to a URL", async () => {
  const client = fakeClient({ tokenResponse: { token: "../../x&y=1" } });
  await assert.rejects(runProfile(client, "profile_url", { url: "/", sections: ["template"], asLoggedIn: false }), /did not return a profiling token/);
});
