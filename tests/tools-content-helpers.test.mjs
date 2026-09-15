import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contentTools, decodeEntities, detectBuilder, matchTermByName, resolveTermIds, routeFor,
} from "../dist/tools/content.js";
import { checkDownloadUrl, filenameFromDisposition, isPrivateAddress } from "../dist/tools/media.js";
import { mediaFileStem } from "../dist/tools/bulk.js";
import { userTools } from "../dist/tools/users.js";
import { taxonomyTools } from "../dist/tools/taxonomy.js";
import { WPError } from "../dist/lib/errors.js";

/* ---------------------------------------------------------------- *
 * A fake WordPressClient that records every request.
 * ---------------------------------------------------------------- */
function fakeClient(routes = {}) {
  const calls = [];
  const types = {
    post: { rest_base: "posts", rest_namespace: "wp/v2", taxonomies: ["category", "post_tag"] },
    page: { rest_base: "pages", rest_namespace: "wp/v2" },
    doc: { rest_base: "docs", rest_namespace: "acme/v1" },
  };
  const taxes = {
    category: { rest_base: "categories", types: ["post"], hierarchical: true },
    post_tag: { rest_base: "tags", types: ["post"], hierarchical: false },
  };
  const handle = (method) => async (route, a, b) => {
    const call = { method, route, body: method === "POST" ? a : undefined, query: method === "POST" ? b : a };
    calls.push(call);
    const handler = routes[`${method} ${route}`];
    if (!handler) throw new Error(`unexpected ${method} ${route}`);
    return { data: typeof handler === "function" ? handler(call) : handler };
  };
  return {
    calls,
    site: { id: "t", url: "https://example.com" },
    baseUrl: "https://example.com",
    hasCredentials: () => true,
    assertWritable: () => {},
    postTypes: async () => types,
    taxonomies: async () => taxes,
    restBaseForType: async (t) => types[t]?.rest_base ?? Object.values(types).find((x) => x.rest_base === t)?.rest_base ?? (() => { throw new Error("unknown type"); })(),
    restBaseForTaxonomy: async (t) => taxes[t]?.rest_base ?? Object.values(taxes).find((x) => x.rest_base === t)?.rest_base,
    get: handle("GET"),
    post: handle("POST"),
    del: handle("DELETE"),
  };
}

const tool = (tools, name) => tools.find((t) => t.name === name);
const registryFor = (client) => ({ registry: { resolve: () => client } });

/* ---------------------------------------------------------------- */

test("routeFor honours a custom rest_namespace and defaults to wp/v2", () => {
  assert.equal(routeFor(undefined, "posts"), "/wp/v2/posts");
  assert.equal(routeFor("acme/v1/", "docs"), "/acme/v1/docs");
});

test("term names are compared after decoding WordPress's HTML escaping", () => {
  assert.equal(decodeEntities("Q&amp;A &#8211; &#x27;x&#x27;"), "Q&A – 'x'");
  const hit = matchTermByName([{ id: 4, name: "Q&amp;A", slug: "qa" }], "q&a");
  assert.equal(hit?.id, 4);
});

test("resolveTermIds reuses the existing term when create reports term_exists", async () => {
  const client = fakeClient({
    "GET /wp/v2/tags": [],
    "POST /wp/v2/tags": () => {
      throw new WPError("exists", 400, "term_exists", "u", "POST", { code: "term_exists", data: { status: 400, term_id: 77 } });
    },
  });
  const out = await resolveTermIds(client, { route: "/wp/v2/tags" }, ["Q&A", 5], true);
  assert.deepEqual(out.ids, [77, 5]);
});

test("update_content: edits that miss still write the other supplied fields", async () => {
  const client = fakeClient({
    "GET /wp/v2/posts/9": { id: 9, content: { raw: "<p>hi</p>", rendered: "<p>hi</p>" } },
    "POST /wp/v2/posts/9": ({ body }) => ({ id: 9, status: "draft", title: { raw: body.title }, content: { raw: "<p>hi</p>" } }),
  });
  const res = await tool(contentTools(registryFor(client)), "update_content").handler({
    id: 9, type: "post", title: "New", edits: [{ find: "absent", replace: "x", required: false }],
  });
  const post = client.calls.find((c) => c.method === "POST");
  assert.deepEqual(post.body, { title: "New" });
  assert.match(res.content[0].text, /"updated": true/);
});

test("update_content refuses edits when only rendered content is available", async () => {
  const client = fakeClient({ "GET /wp/v2/posts/9": { id: 9, content: { rendered: "<p>hi</p>" } } });
  await assert.rejects(
    tool(contentTools(registryFor(client)), "update_content").handler({ id: 9, type: "post", edits: [{ find: "hi", replace: "yo" }] }),
    /raw stored content/
  );
  assert.equal(client.calls.filter((c) => c.method === "POST").length, 0);
});

test("status trash is applied through DELETE, since REST rejects it as a status", async () => {
  const client = fakeClient({
    "POST /wp/v2/posts/9": { id: 9, status: "draft" },
    "DELETE /wp/v2/posts/9": { id: 9, status: "trash" },
  });
  await tool(contentTools(registryFor(client)), "update_content").handler({ id: 9, type: "post", title: "T", status: "trash" });
  assert.deepEqual(client.calls.map((c) => `${c.method} ${c.route}`), ["POST /wp/v2/posts/9", "DELETE /wp/v2/posts/9"]);
  assert.equal(client.calls[0].body.status, undefined);
});

test("content tools use a custom post type's own REST namespace", async () => {
  const client = fakeClient({ "GET /acme/v1/docs/3": { id: 3, content: { raw: "x" } } });
  await tool(contentTools(registryFor(client)), "get_content").handler({ id: 3, type: "doc", raw: true, include_meta: false, max_content_chars: 1000 });
  assert.equal(client.calls[0].route, "/acme/v1/docs/3");
});

test("terms for a taxonomy not attached to the type are refused before any term is created", async () => {
  const client = fakeClient({});
  await assert.rejects(
    tool(contentTools(registryFor(client)), "create_content").handler({ type: "page", title: "x", terms: { tags: ["new"] } }),
    /not attached/
  );
  assert.equal(client.calls.length, 0);
});

test("assign_terms_to_content in remove mode never creates terms", async () => {
  const client = fakeClient({
    "GET /wp/v2/posts/1": { id: 1, tags: [3, 4] },
    "GET /wp/v2/tags": [],
    "POST /wp/v2/posts/1": ({ body }) => ({ id: 1, tags: body.tags }),
  });
  await tool(taxonomyTools(registryFor(client)), "assign_terms_to_content").handler({
    content_id: 1, type: "post", taxonomy: "post_tag", terms: ["ghost", 3], mode: "remove", create_missing: true,
  });
  assert.equal(client.calls.filter((c) => c.method === "POST" && c.route === "/wp/v2/tags").length, 0);
  assert.deepEqual(client.calls.at(-1).body, { tags: [4] });
});

test("delete_user without reassign_to sends reassign=false, not an empty (dropped) value", async () => {
  const client = fakeClient({ "DELETE /wp/v2/users/5": { deleted: true } });
  await tool(userTools(registryFor(client)), "delete_user").handler({ id: 5, confirm: true });
  assert.deepEqual(client.calls[0].query, { force: true, reassign: "false" });
});

test("detectBuilder flags builder markup and ignores ordinary prose", () => {
  assert.equal(detectBuilder({ content: { raw: "[et_pb_section]x[/et_pb_section]", rendered: "" } }), "Divi");
  assert.equal(detectBuilder({ content: { raw: "", rendered: '<div data-elementor-type="wp-page">' } }), "Elementor");
  assert.equal(detectBuilder({ content: { raw: "<p>a breakdance battle on elementor street</p>", rendered: "" } }), null);
});

/* ---------------------------------------------------------------- *
 * create_media URL safety
 * ---------------------------------------------------------------- */

test("isPrivateAddress covers v4, v6 and mapped forms", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "[::1]"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1111", "100.128.0.1"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("checkDownloadUrl refuses non-http schemes and internal hosts, including obfuscated literals", () => {
  for (const url of ["file:///etc/passwd", "data:image/png;base64,AAAA", "ftp://example.com/a.png"]) {
    assert.throws(() => checkDownloadUrl(url), /Only http/, url);
  }
  for (const url of ["http://127.1/x.png", "http://0x7f000001/x.png", "http://[::ffff:127.0.0.1]/x.png", "http://169.254.169.254/latest/meta-data", "http://localhost:3000/a.png", "http://printer.local/a.png", "http://intranet/a.png"]) {
    assert.throws(() => checkDownloadUrl(url), /Refusing/, url);
  }
  assert.equal(checkDownloadUrl("https://images.example.com/a.png").hostname, "images.example.com");
  // The configured WordPress host is always allowed, so local dev sites keep working.
  assert.equal(checkDownloadUrl("http://localhost:8080/wp-content/uploads/a.png", ["localhost"]).hostname, "localhost");
});

test("filenameFromDisposition prefers filename* and survives malformed escapes", () => {
  assert.equal(filenameFromDisposition(`attachment; filename="a b.jpg"; filename*=UTF-8''caf%C3%A9.jpg`), "café.jpg");
  assert.equal(filenameFromDisposition(`inline; filename="report.pdf"`), "report.pdf");
  assert.equal(filenameFromDisposition(`attachment; filename*=UTF-8''100%.png`), "100%.png");
  assert.equal(filenameFromDisposition(null), undefined);
});

test("mediaFileStem strips size, scaled and rotated suffixes", () => {
  assert.equal(mediaFileStem("https://x.test/wp-content/uploads/2026/01/hero-scaled.jpg"), "hero");
  assert.equal(mediaFileStem("https://x.test/uploads/hero-1024x768.jpg?ver=2"), "hero");
  assert.equal(mediaFileStem("https://x.test/uploads/photo-rotated.png"), "photo");
});
