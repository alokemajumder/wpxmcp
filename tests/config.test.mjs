import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../dist/lib/config.js";
import { SiteRegistry } from "../dist/lib/registry.js";

test("single-site environment variables produce one site", () => {
  const config = loadConfig({
    WORDPRESS_URL: "example.com",
    WORDPRESS_USERNAME: "admin",
    WORDPRESS_APP_PASSWORD: "abcd EFGH",
  });
  assert.equal(config.sites.length, 1);
  assert.equal(config.sites[0].url, "https://example.com", "a bare host should be upgraded to https");
  assert.equal(config.defaultSiteId, "default");
});

test("a trailing slash is trimmed so routes never double up", () => {
  const config = loadConfig({ WORDPRESS_URL: "https://example.com/" });
  assert.equal(config.sites[0].url, "https://example.com");
});

test("WPX_SITES accepts an array", () => {
  const config = loadConfig({
    WPX_SITES: JSON.stringify([
      { id: "blog", url: "https://blog.test", username: "u", appPassword: "p" },
      { id: "shop", url: "https://shop.test", username: "u", appPassword: "p" },
    ]),
  });
  assert.equal(config.sites.length, 2);
  assert.equal(config.defaultSiteId, "blog");
});

test("WPX_SITES accepts an object map keyed by id", () => {
  const config = loadConfig({
    WPX_SITES: JSON.stringify({ blog: { url: "https://blog.test" }, shop: { url: "https://shop.test" } }),
  });
  assert.deepEqual(config.sites.map((s) => s.id).sort(), ["blog", "shop"]);
});

test("WP_SITE_* triples are collected", () => {
  const config = loadConfig({
    WP_SITE_MAIN_URL: "https://main.test",
    WP_SITE_MAIN_USERNAME: "u",
    WP_SITE_MAIN_APP_PASSWORD: "p",
    WP_SITE_STAGING_URL: "https://staging.test",
  });
  assert.deepEqual(config.sites.map((s) => s.id).sort(), ["main", "staging"]);
});

test("an unknown WPX_DEFAULT_SITE is rejected with the valid ids", () => {
  assert.throws(
    () => loadConfig({ WORDPRESS_URL: "https://example.com", WPX_DEFAULT_SITE: "nope" }),
    /does not match any configured site/
  );
});

test("malformed WPX_SITES reports the parse error", () => {
  assert.throws(() => loadConfig({ WPX_SITES: "{not json" }), /Could not parse WPX_SITES/);
});

test("the registry resolves the default and names unknown ids", () => {
  const registry = new SiteRegistry(loadConfig({
    WPX_SITES: JSON.stringify([{ id: "a", url: "https://a.test" }, { id: "b", url: "https://b.test" }]),
  }));
  assert.equal(registry.resolve().site.id, "a");
  assert.equal(registry.resolve("b").site.id, "b");
  assert.throws(() => registry.resolve("c"), /Configured sites: a, b/);
});

test("an unconfigured registry explains how to configure itself", () => {
  const registry = new SiteRegistry(loadConfig({}));
  assert.throws(() => registry.resolve(), /No WordPress sites are configured/);
});

test("redacted config never leaks the password", () => {
  const registry = new SiteRegistry(loadConfig({
    WORDPRESS_URL: "https://example.com",
    WORDPRESS_USERNAME: "admin",
    WORDPRESS_APP_PASSWORD: "sup3r s3cret",
  }));
  const dump = JSON.stringify(registry.redacted(registry.sites[0]));
  assert.equal(dump.includes("sup3r"), false, "the application password must never be returned");
  assert.match(dump, /application password/);
});

test("read-only sites refuse writes before any request is made", () => {
  const registry = new SiteRegistry(loadConfig({
    WPX_SITES: JSON.stringify([{ id: "prod", url: "https://prod.test", username: "u", appPassword: "p", writable: false }]),
  }));
  assert.throws(() => registry.resolve("prod").assertWritable("update_content"), /read-only/);
});

test("a site with no credentials refuses writes rather than failing at the API", () => {
  const registry = new SiteRegistry(loadConfig({ WORDPRESS_URL: "https://example.com" }));
  assert.throws(() => registry.resolve().assertWritable("create_content"), /no credentials/);
});

test("REST URLs are built for both permalink styles", () => {
  const pretty = new SiteRegistry(loadConfig({ WORDPRESS_URL: "https://example.com" })).resolve();
  assert.equal(pretty.buildUrl("/wp/v2/posts"), "https://example.com/wp-json/wp/v2/posts");

  const plain = new SiteRegistry(loadConfig({
    WPX_SITES: JSON.stringify([{ id: "p", url: "https://example.com", restPrefix: "/?rest_route=" }]),
  })).resolve();
  assert.match(plain.buildUrl("/wp/v2/posts"), /rest_route=%2Fwp%2Fv2%2Fposts/);
});

test("query serialisation handles arrays and booleans", () => {
  const client = new SiteRegistry(loadConfig({ WORDPRESS_URL: "https://example.com" })).resolve();
  const url = client.buildUrl("/wp/v2/posts", { categories: [1, 2], hide_empty: true, blank: "", missing: undefined, nested: { a: 1 } });
  const params = new URL(url).searchParams;
  assert.equal(params.get("categories"), "1,2", "arrays serialise as a comma list");
  assert.equal(params.get("hide_empty"), "true", "booleans serialise as true/false");
  assert.equal(params.has("blank"), false, "empty strings are dropped");
  assert.equal(params.has("missing"), false, "undefined values are dropped");
  assert.equal(params.get("nested"), '{"a":1}', "objects serialise as JSON");
});
