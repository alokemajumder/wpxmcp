import { schemaDescription } from "../dist/lib/tooling.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { installNodePlatform } from "../dist/platform-node.js";
import {
  detectSeoPlugin, parseHead, normalizeYoastHead, buildSeoMetaWrite, readSeoMeta, compareSeo, aioseoPostBody,
  metaKeysFor, yoastCollectionHeadsTrustworthy,
} from "../dist/lib/growth-seo.js";
import {
  extractLinks, isInternalUrl, contentKey, buildLinkGraph, suggestLinks, analyzeRobots, isoWeek, weekSeries,
  parseWpDate, csvCell, toCsv, encodeCursor, decodeCursor, mapLimit, sortBySeverity, worstSeverity, keywords,
} from "../dist/lib/growth-links.js";
import { growthTools } from "../dist/tools/growth.js";

installNodePlatform();

/* ------------------------------ SEO helpers ------------------------------ */

test("detectSeoPlugin prefers REST namespaces and falls back to the plugin list", () => {
  assert.deepEqual(detectSeoPlugin(["wp/v2", "yoast/v1"]), { plugin: "yoast", detected_via: "REST namespace yoast/v1" });
  assert.equal(detectSeoPlugin(["wp/v2"], [{ plugin: "autodescription/autodescription.php", status: "active" }]).plugin, "seo-framework");
  assert.equal(detectSeoPlugin(["wp/v2"], [{ plugin: "wordpress-seo/wp-seo.php", status: "inactive" }]).plugin, null);
  const both = detectSeoPlugin(["rankmath/v1", "yoast/v1"]);
  assert.equal(both.plugin, "rank-math");
  assert.deepEqual(both.also_active, ["yoast"]);
});

test("parseHead normalizes tags regardless of attribute order and quoting", () => {
  const html = `<html><head>
    <title>Tom &amp; Jerry &#8211; Home</title>
    <meta content="A &quot;quoted&quot; description" name="description">
    <meta name='robots' content='noindex, follow' />
    <link href="https://example.com/x/" rel="canonical">
    <meta property="og:title" content="OG T"><meta content="https://example.com/i.png" property="og:image">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":["Article","NewsArticle"]}]}</script>
    </head><body><meta name="description" content="body decoy"></body></html>`;
  const h = parseHead(html);
  assert.equal(h.title, "Tom & Jerry – Home");
  assert.equal(h.description, 'A "quoted" description');
  assert.equal(h.canonical, "https://example.com/x/");
  assert.deepEqual([h.robots.noindex, h.robots.nofollow], [true, false]);
  assert.equal(h.og.title, "OG T");
  assert.equal(h.og.image, "https://example.com/i.png");
  assert.deepEqual(h.schema_types.sort(), ["Article", "NewsArticle", "WebPage"]);
});

test("normalizeYoastHead reads robots and schema from yoast_head_json", () => {
  const n = normalizeYoastHead({ title: "T", description: "D", canonical: "https://e.com/", robots: { index: "noindex", follow: "follow" }, og_image: [{ url: "https://e.com/a.jpg" }], schema: { "@graph": [{ "@type": "Article" }] } });
  assert.equal(n.robots.noindex, true);
  assert.equal(n.og.image, "https://e.com/a.jpg");
  assert.deepEqual(n.schema_types, ["Article"]);
  assert.equal(normalizeYoastHead(null), null);
});

test("buildSeoMetaWrite maps normalized fields to each plugin's keys", () => {
  assert.deepEqual(buildSeoMetaWrite("yoast", { title: "T", noindex: true, nofollow: false }).meta, {
    _yoast_wpseo_title: "T", "_yoast_wpseo_meta-robots-noindex": "1", "_yoast_wpseo_meta-robots-nofollow": "0",
  });
  // Rank Math keeps robots as one array; other directives must survive.
  const rm = buildSeoMetaWrite("rank-math", { noindex: true }, { rank_math_robots: ["index", "noarchive"] });
  assert.deepEqual(rm.meta.rank_math_robots, ["noindex", "noarchive"]);
  const rm2 = buildSeoMetaWrite("rank-math", { nofollow: true }, { rank_math_robots: ["noindex"] });
  assert.deepEqual(rm2.meta.rank_math_robots, ["noindex", "nofollow"]);
  assert.deepEqual(buildSeoMetaWrite("seopress", { noindex: true }).meta, { _seopress_robots_index: "yes" });
  assert.deepEqual(buildSeoMetaWrite("seo-framework", { focus_keyword: "x" }).unsupported, ["focus_keyword"]);
  assert.deepEqual(aioseoPostBody(5, { focus_keyword: "k", noindex: true }), { id: 5, keyphrases: { focus: { keyphrase: "k" }, additional: [] }, robots_default: false, robots_noindex: true });
  assert.ok(metaKeysFor("rank-math").includes("rank_math_robots"));
});

test("readSeoMeta round-trips what buildSeoMetaWrite produces", () => {
  for (const plugin of ["yoast", "rank-math", "seopress", "seo-framework"]) {
    const { meta } = buildSeoMetaWrite(plugin, { title: "T", description: "D", canonical: "https://e.com/", noindex: true });
    const back = readSeoMeta(plugin, meta);
    assert.equal(back.title, "T", plugin);
    assert.equal(back.description, "D", plugin);
    assert.equal(back.noindex, true, plugin);
  }
});

test("compareSeo flags rendered differences and ignores unset expectations", () => {
  const rendered = parseHead('<title>Cached Title</title><meta name="description" content="Same">');
  const mm = compareSeo({ title: "Fresh Title", description: "same", canonical: null }, rendered);
  assert.deepEqual(mm.map((m) => m.field), ["title"]);
  assert.match(mm[0].likely_cause, /cache/i);
  assert.deepEqual(compareSeo({ title: null, description: null }, rendered), []);
});

test("identical Yoast heads across distinct posts are recognised as untrustworthy", () => {
  assert.equal(yoastCollectionHeadsTrustworthy([
    { title: { rendered: "A" }, yoast_head_json: { title: "Front - Site" } },
    { title: { rendered: "B" }, yoast_head_json: { title: "Front - Site" } },
  ]), false);
  assert.equal(yoastCollectionHeadsTrustworthy([
    { title: { rendered: "A" }, yoast_head_json: { title: "A - Site" } },
    { title: { rendered: "B" }, yoast_head_json: { title: "B - Site" } },
  ]), true);
});

/* ------------------------------ link helpers ------------------------------ */

test("extractLinks resolves, de-duplicates and skips non-web schemes", () => {
  const links = extractLinks(`<a href="/a/#x">1</a><a href='/a/'>2</a><a href=mailto:x@y.z>m</a><a href="#top">t</a>
    <!-- <a href="/commented/">c</a> --><img alt="" src="https://cdn.example.org/i.png"><a data-x="1" href="javascript:void(0)">j</a>`, "https://example.com/post/");
  assert.deepEqual(links, [{ url: "https://example.com/a/", kind: "a" }, { url: "https://cdn.example.org/i.png", kind: "img" }]);
  assert.equal(extractLinks('<img src="/x.png">', "https://e.com/", { images: false }).length, 0);
});

test("isInternalUrl and contentKey", () => {
  assert.equal(isInternalUrl("https://example.com", "http://EXAMPLE.com/x"), true);
  assert.equal(isInternalUrl("https://example.com", "https://www.example.com/x"), false);
  assert.equal(isInternalUrl("http://127.0.0.1:8090", "http://127.0.0.1:1/"), false);
  assert.equal(contentKey("http://e.com/?p=12&x=1"), "id:12");
  assert.equal(contentKey("https://e.com/Hello-World/"), "path:/hello-world");
});

test("link graph finds orphans, dead ends and links to unpublished content", () => {
  const site = "https://e.com";
  const items = [
    { id: 1, type: "post", status: "publish", title: "Growing tomatoes guide", link: "https://e.com/tomatoes/", slug: "tomatoes", terms: [5], html: '<a href="/watering-tomatoes/">w</a> <a href="https://e.com/?p=9">draft</a> <a href="/nowhere/">x</a>' },
    { id: 2, type: "post", status: "publish", title: "Watering tomatoes", link: "https://e.com/watering-tomatoes/", slug: "watering-tomatoes", terms: [5], html: "<p>none</p>" },
    { id: 3, type: "post", status: "publish", title: "Tomatoes pests", link: "https://e.com/pests/", slug: "pests", terms: [5], html: '<a href="https://e.com/tomatoes/">g</a>' },
  ];
  const g = buildLinkGraph(site, items, [{ id: 9, status: "draft", link: "https://e.com/?p=9" }]);
  assert.deepEqual([...g.inbound.get(2)], [1]);
  assert.equal(g.inbound.get(3).size, 0, "3 is an orphan");
  assert.equal(g.outbound.get(2).size, 0, "2 is a dead end");
  assert.deepEqual(g.toUnpublished.map((l) => [l.from, l.target, l.target_status]), [[1, 9, "draft"]]);
  assert.deepEqual(g.unresolved.map((u) => u.url), ["https://e.com/nowhere/"]);
  const s = suggestLinks(items, g, { max: 10 });
  assert.ok(s.length > 0);
  assert.ok(!s.some((x) => x.from === 1 && x.to === 2), "never suggests a link that exists");
  assert.equal(s[0].to, 3, "orphans are preferred targets");
  assert.deepEqual(keywords("The Best &amp; Easiest Way to Grow Tomatoes in 2026"), ["best", "easiest", "way", "grow", "tomatoes"]);
});

test("analyzeRobots detects a site-wide block and declared sitemaps", () => {
  const blocked = analyzeRobots("User-agent: *\nDisallow: /\n\nSitemap: https://e.com/wp-sitemap.xml");
  assert.equal(blocked.blocks_all, true);
  assert.deepEqual(blocked.sitemaps, ["https://e.com/wp-sitemap.xml"]);
  assert.equal(analyzeRobots("User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php").blocks_all, false);
  assert.equal(analyzeRobots("User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow:").blocks_all, false);
  assert.equal(analyzeRobots("User-agent: Googlebot\nUser-agent: *\nDisallow: / # all").blocks_all, true);
});

test("calendar maths: ISO weeks across year boundaries", () => {
  assert.equal(isoWeek(new Date("2026-01-01T12:00:00Z")), "2026-W01");
  assert.equal(isoWeek(new Date("2027-01-01T12:00:00Z")), "2026-W53");
  assert.equal(isoWeek(new Date("2026-09-15T00:00:00Z")), "2026-W38");
  const series = weekSeries(new Date("2026-09-15T00:00:00Z"), -1, 3);
  assert.deepEqual(series.map((w) => w.week), ["2026-W37", "2026-W38", "2026-W39"]);
  assert.equal(series[1].starts, "2026-09-14");
  assert.equal(parseWpDate("2026-09-15T10:00:00").toISOString(), "2026-09-15T10:00:00.000Z");
  assert.equal(parseWpDate("nope"), null);
});

test("CSV escaping neutralises formulas and quotes", () => {
  assert.equal(csvCell('He said "hi", then left'), '"He said ""hi"", then left"');
  assert.equal(csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
  assert.equal(csvCell(["a", "b"]), "a; b");
  assert.equal(toCsv(["id", "t"], [{ id: 1, t: null }]), "id,t\n1,");
});

test("cursors round-trip and reject garbage clearly", () => {
  assert.deepEqual(decodeCursor(encodeCursor({ t: 1, o: 200 })), { t: 1, o: 200 });
  assert.equal(decodeCursor(undefined), null);
  assert.throws(() => decodeCursor("%%%"), /cursor is not valid/);
});

test("mapLimit bounds concurrency, keeps order and isolates failures", async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (n === 4) throw new Error("boom");
    return n * 2;
  });
  assert.ok(peak <= 3);
  assert.equal(results[3].status, "rejected");
  assert.deepEqual(results.filter((r) => r.status === "fulfilled").map((r) => r.value), [2, 4, 6, 10, 12, 14]);
});

test("fleet rows sort worst first", () => {
  const rows = [
    { id: "b", issues: [{ severity: "warning", issue: "x" }] },
    { id: "a", issues: [] },
    { id: "c", issues: [{ severity: "critical", issue: "down" }] },
    { id: "d", issues: [{ severity: "warning", issue: "x" }, { severity: "warning", issue: "y" }] },
  ].map((r) => ({ ...r, severity: worstSeverity(r.issues) }));
  assert.deepEqual(sortBySeverity(rows).map((r) => r.id), ["c", "d", "b", "a"]);
});

/* ------------------------------ tool handlers ------------------------------ */

function fakeClient({ namespaces = ["wp/v2", "wpxmcp/v1"], routes = [], meta = {}, item = {} } = {}) {
  const calls = [];
  const post = { id: 7, status: "draft", title: { raw: "Hello" }, link: "https://example.com/?p=7", modified_gmt: "2026-01-01T00:00:00", meta: {}, ...item };
  const client = {
    calls,
    site: { id: "t", url: "https://example.com", helperNamespace: "wpxmcp/v1" },
    baseUrl: "https://example.com",
    hasCredentials: () => true,
    assertWritable: () => {},
    hasHelperPlugin: async () => namespaces.includes("wpxmcp/v1"),
    discovery: async () => ({ namespaces, routes }),
    postTypes: async () => ({ post: { rest_base: "posts", rest_namespace: "wp/v2" } }),
    taxonomies: async () => ({}),
    restBaseForType: async () => "posts",
    get: async (route, query) => {
      calls.push({ method: "GET", route, query });
      if (route === "/wp/v2/posts/7") return { data: post };
      if (route === "/wpxmcp/v1/meta") return { data: { meta } };
      if (route === "/wp/v2/plugins") return { data: [] };
      throw new Error(`unexpected GET ${route}`);
    },
    request: async (route, opts) => {
      calls.push({ method: opts.method, route, body: opts.body });
      return { data: { ok: true } };
    },
  };
  return client;
}

const tool = (client, name) => growthTools({ registry: { resolve: () => client, sites: [], has: () => false } }).find((t) => t.name === name);

test("every growth tool parameter is described and annotated", () => {
  const tools = growthTools({ registry: { resolve: () => { throw new Error("x"); }, sites: [] } });
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_links", "content_calendar", "content_inventory", "fleet_report", "get_seo_meta", "internal_link_report", "seo_site_check", "set_seo_meta"]);
  for (const t of tools) {
    assert.ok(t.description.length > 40, t.name);
    assert.equal(Boolean(t.readOnly) || Boolean(t.destructive), true, `${t.name} needs a readOnly or destructive annotation`);
    for (const [k, v] of Object.entries(t.schema)) {
      if (k === "site_id") continue;
      const d = schemaDescription(v);
      assert.ok(d, `${t.name}.${k} has no description`);
    }
  }
});

test("set_seo_meta refuses when no SEO plugin is active", async () => {
  const client = fakeClient();
  await assert.rejects(tool(client, "set_seo_meta").handler({ id: 7, description: "x" }), /No SEO plugin is active/);
  assert.equal(client.calls.filter((c) => c.method !== "GET").length, 0);
});

test("set_seo_meta previews, then writes Yoast keys through the companion route only with the token", async () => {
  const client = fakeClient({ namespaces: ["wp/v2", "wpxmcp/v1", "yoast/v1"], meta: { _yoast_wpseo_title: "Old" } });
  const t = tool(client, "set_seo_meta");
  const args = { id: 7, title: "New", noindex: true };
  const preview = await t.handler(args);
  const body = JSON.parse(preview.content[0].text.split("\n\n").slice(1).join("\n\n"));
  assert.equal(body.dry_run, true);
  assert.equal(body.changes.find((c) => c.field === "title").from, "Old");
  assert.equal(body.plan[0].route, "/wpxmcp/v1/meta");
  assert.equal(client.calls.filter((c) => c.method === "POST").length, 0, "preview must not write");

  const tampered = await t.handler({ ...args, title: "Other", confirm_token: body.confirm_token });
  assert.match(tampered.content[0].text, /not accepted/);

  await t.handler({ ...args, confirm_token: body.confirm_token });
  const writes = client.calls.filter((c) => c.method === "POST");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { post_id: 7, meta: { _yoast_wpseo_title: "New", "_yoast_wpseo_meta-robots-noindex": "1" } });
});

test("set_seo_meta uses Rank Math's updateMeta route when it is registered", async () => {
  const client = fakeClient({ namespaces: ["wp/v2", "rankmath/v1"], routes: ["/rankmath/v1/updateMeta"] });
  const t = tool(client, "set_seo_meta");
  const preview = await t.handler({ id: 7, description: "D" });
  const body = JSON.parse(preview.content[0].text.split("\n\n").slice(1).join("\n\n"));
  assert.equal(body.plan[0].route, "/rankmath/v1/updateMeta");
  await t.handler({ id: 7, description: "D", confirm_token: body.confirm_token });
  const write = client.calls.find((c) => c.method === "POST");
  assert.deepEqual(write.body, { objectType: "post", objectID: 7, meta: { rank_math_description: "D" } });
});

test("set_seo_meta without the companion plugin explains the unregistered-meta problem", async () => {
  const client = fakeClient({ namespaces: ["wp/v2", "yoast/v1"] });
  await assert.rejects(tool(client, "set_seo_meta").handler({ id: 7, title: "x" }), /not registered with show_in_rest/);
});

test("check_links refuses a URL on another host", async () => {
  const client = fakeClient();
  await assert.rejects(tool(client, "check_links").handler({ url: "https://evil.example.org/", type: "post", status: "publish", limit: 1, include_external: false, include_images: true, max_links: 5, concurrency: 1, timeout_ms: 1000 }), /points elsewhere/);
});
