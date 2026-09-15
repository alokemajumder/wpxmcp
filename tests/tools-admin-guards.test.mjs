import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classicThemeScaffold, headerText, sanitizeThemeSlug, phpPrefix, cssToken,
} from "../dist/lib/theme-scaffold.js";
import { parseCliArgs, isCliDryRun, protectedOptionReason } from "../dist/tools/power.js";
import { resolveSiteUrl, isSameSite, effectiveRestMethod } from "../dist/tools/site.js";
import { pluginId } from "../dist/tools/plugins.js";
import { themeStylesheet } from "../dist/tools/themes.js";
import { routeId, deepMerge } from "../dist/tools/appearance.js";

/* ------------------------- theme scaffold ------------------------- */

test("scaffold: a name cannot close a PHP docblock and inject code", () => {
  const files = classicThemeScaffold({
    name: "Evil */ system($_GET['c']); /*",
    slug: "evil",
    description: "x",
    author: "a",
    tokens: {},
  });
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".php")) continue;
    // Remove comments the way PHP's lexer would; the injected call must not survive as code.
    const code = content.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!code.includes("system("), `${path}: injected text escaped its docblock`);
  }
  assert.ok(!files["style.css"].match(/Theme Name:[^\n]*\*\//), "style.css header must not be closed early");
});

test("scaffold: newlines cannot inject extra theme headers", () => {
  const files = classicThemeScaffold({
    name: "Nice",
    slug: "nice",
    description: "Hello\nTemplate: twentytwentyfive\nVersion: 9",
    author: "me\r\nLicense: none",
    tokens: {},
  });
  const header = files["style.css"].split("*/")[0];
  assert.equal((header.match(/^Template:/gm) ?? []).length, 0);
  assert.equal((header.match(/^Version:/gm) ?? []).length, 1);
  assert.equal((header.match(/^License:/gm) ?? []).length, 1);
});

test("scaffold: slugs starting with a digit still yield valid PHP identifiers", () => {
  assert.equal(phpPrefix("3d-studio"), "theme_3d_studio");
  assert.equal(phpPrefix("northwind"), "northwind");
  const files = classicThemeScaffold({ name: "3D Studio", slug: "3d-studio", description: "", author: "", tokens: {} });
  assert.match(files["functions.php"], /function theme_3d_studio_setup\(\)/);
  assert.match(files["functions.php"], /define\( 'THEME_3D_STUDIO_VERSION'/);
  assert.doesNotMatch(files["functions.php"], /function 3d/);
});

test("scaffold: slug sanitisation and refusal of empty slugs", () => {
  assert.equal(sanitizeThemeSlug("Café Olé!"), "cafe-ole");
  assert.equal(sanitizeThemeSlug("../../etc"), "etc");
  assert.equal(sanitizeThemeSlug("日本"), "");
  assert.throws(() => classicThemeScaffold({ name: "x", slug: "日本", description: "", author: "", tokens: {} }));
  const files = classicThemeScaffold({ name: "x", slug: "My Theme'); evil(); //", description: "", author: "", tokens: {} });
  assert.doesNotMatch(files["functions.php"], /evil\(\);/);
});

test("scaffold: tokens cannot break out of the :root rule", () => {
  assert.equal(cssToken("red; } body { display:none", "#000"), "red  body  display:none");
  assert.equal(cssToken(undefined, "#000"), "#000");
  assert.equal(cssToken("", "#000"), "#000");
  assert.equal(cssToken("'Inter', sans-serif", "x"), "'Inter', sans-serif");
  assert.equal(cssToken("'Inter, sans-serif", "x"), "Inter, sans-serif");
  const files = classicThemeScaffold({ name: "t", slug: "t", description: "", author: "", tokens: { primary: "#fff;}</style><script>" } });
  const root = files["theme.css"].split(":root {")[1].split("\n}")[0];
  assert.doesNotMatch(root, /[{}<>]/);
});

test("headerText strips control characters and comment markers", () => {
  assert.equal(headerText("a\n\tb */ c /* d"), "a b * / c / * d");
  assert.equal(headerText("x".repeat(500), 10).length, 10);
});

/* ------------------------------ WP-CLI ----------------------------- */

test("parseCliArgs mirrors the plugin's quoting rules", () => {
  assert.deepEqual(parseCliArgs(`search-replace "old site" 'new site' --dry-run --precise=yes`), {
    args: ["search-replace", "old site", "new site"],
    flags: { "dry-run": true, precise: "yes" },
  });
});

test("search-replace dry-run detection cannot be spoofed", () => {
  assert.equal(isCliDryRun("search-replace a b --dry-run"), true);
  assert.equal(isCliDryRun("search-replace a b --dry-run=1"), true);
  // Each of these made the old /--dry-run\b/ check skip confirmation while the
  // plugin performed the real replacement.
  assert.equal(isCliDryRun("search-replace a b --dry-run-now"), false);
  assert.equal(isCliDryRun(`search-replace a b "--dry-run"`), false);
  assert.equal(isCliDryRun(`search-replace 'x --dry-run' y`), false);
  assert.equal(isCliDryRun("search-replace a b --dry-run=0"), false);
});

test("set_option refuses escalation and guard-bypass options", () => {
  assert.ok(protectedOptionReason("siteurl", "x"));
  assert.ok(protectedOptionReason("wp_user_roles", {}));
  assert.ok(protectedOptionReason("wp2_user_roles", {}));
  assert.ok(protectedOptionReason("wpxmcp_snippets", {}));
  assert.ok(protectedOptionReason("wpxmcp_audit_log", []));
  assert.ok(protectedOptionReason("default_role", "administrator"));
  assert.ok(protectedOptionReason("auth_salt", "x"));
  // The companion plugin refuses default_role outright, so the server must not suggest otherwise.
  assert.ok(protectedOptionReason("default_role", "subscriber"));
  assert.equal(protectedOptionReason("blogdescription", "hi"), undefined);
  assert.equal(protectedOptionReason("woocommerce_currency", "EUR"), undefined);
});

/* ---------------------------- get_page_html ------------------------ */

test("resolveSiteUrl keeps every input on the configured site", () => {
  const site = "https://example.com/blog";
  assert.equal(resolveSiteUrl(site, "/about/").toString(), "https://example.com/blog/about/");
  assert.equal(resolveSiteUrl(site, "about/").toString(), "https://example.com/blog/about/");
  assert.equal(resolveSiteUrl(site, "https://example.com/other/").toString(), "https://example.com/other/");
  assert.equal(resolveSiteUrl(site, "http://example.com/").hostname, "example.com");
  assert.equal(resolveSiteUrl(site, "//evil.com/x").hostname, "example.com");
  assert.equal(resolveSiteUrl(site, "\\\\evil.com/x").hostname, "example.com");
  assert.equal(resolveSiteUrl(site, "/\\evil.com").hostname, "example.com");
  assert.equal(resolveSiteUrl(site, "@evil.com").hostname, "example.com");
  for (const bad of [
    "https://evil.com/", "https://example.com@evil.com/", "https://user:pw@example.com/",
    "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd", "javascript:alert(1)",
    "https://example.com.evil.com/", "https://example.com:8443/",
  ]) {
    assert.throws(() => resolveSiteUrl(site, bad), undefined, bad);
  }
});

test("isSameSite allows the http→https upgrade but not a host change", () => {
  assert.equal(isSameSite("http://example.com", new URL("https://example.com/x")), true);
  assert.equal(isSameSite("https://example.com", new URL("https://www.example.com/x")), false);
  assert.equal(isSameSite("http://localhost:8080", new URL("http://localhost:8080/x")), true);
  assert.equal(isSameSite("http://localhost:8080", new URL("http://localhost:9090/x")), false);
});

/* ------------------------------ rest_api --------------------------- */

test("a _method override counts as the method WordPress will dispatch", () => {
  assert.equal(effectiveRestMethod("GET", "/wp/v2/posts"), "GET");
  assert.equal(effectiveRestMethod("GET", "/wp/v2/posts/1", { _method: "DELETE" }), "DELETE");
  assert.equal(effectiveRestMethod("GET", "/wp/v2/posts/1?_method=delete"), "DELETE");
  assert.equal(effectiveRestMethod("POST", "/wp/v2/posts"), "POST");
});

/* ---------------------------- route ids ---------------------------- */

test("ids interpolated into REST paths cannot traverse to other routes", () => {
  assert.equal(pluginId("akismet/akismet.php"), "akismet/akismet");
  assert.equal(pluginId("hello"), "hello");
  assert.throws(() => pluginId("../../wp/v2/users"));
  assert.throws(() => pluginId("a/b/c"));
  assert.throws(() => pluginId("a/b?x=1"));
  assert.throws(() => pluginId("wp.pro/wp"), /run_wp_cli/);

  assert.equal(themeStylesheet("twentytwentyfive"), "twentytwentyfive");
  assert.throws(() => themeStylesheet("../plugins"));
  assert.throws(() => themeStylesheet("a?b"));

  assert.equal(routeId("twentytwentyfour//single", "template id"), "twentytwentyfour//single");
  assert.equal(routeId("block-3", "widget id"), "block-3");
  assert.throws(() => routeId("theme//../../users", "template id"));
  assert.throws(() => routeId("x%2e%2e", "template id"));
});

test("deepMerge merges objects and replaces arrays", () => {
  assert.deepEqual(
    deepMerge({ color: { palette: [1, 2], text: true }, spacing: { units: ["px"] } }, { color: { palette: [3] } }),
    { color: { palette: [3], text: true }, spacing: { units: ["px"] } },
  );
});
