import { schemaDescription } from "../dist/lib/tooling.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { installNodePlatform } from "../dist/platform-node.js";
import {
  parseColor, contrastRatio, resolveColorRef, isPlausibleCssColor,
} from "../dist/lib/themedev-color.js";
import {
  jsonDiff, lintThemeJson, paletteMap, paletteFromCss, variationKind, summarizeVariation, contrastIssues, parseJsonText,
} from "../dist/lib/themedev-json.js";
import { parseHtml, checkAccessibility, textContent } from "../dist/lib/themedev-html.js";
import { themeDevTools, pickVariation, proposeVariationStyles } from "../dist/tools/themedev.js";

installNodePlatform();

/* ------------------------------ colour ------------------------------ */

test("colour: parses hex, rgb, hsl and names; rejects the rest", () => {
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("#11223380"), { r: 17, g: 34, b: 51, a: 128 / 255 });
  assert.deepEqual(parseColor("rgb(10 20 30 / 50%)"), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor("rgba(10, 20, 30, 0.25)"), { r: 10, g: 20, b: 30, a: 0.25 });
  const red = parseColor("hsl(0, 100%, 50%)");
  assert.equal(Math.round(red.r), 255);
  assert.equal(Math.round(red.g), 0);
  assert.deepEqual(parseColor("Black"), { r: 0, g: 0, b: 0, a: 1 });
  for (const bad of ["#12345", "blu", "var(--x)", "color-mix(in srgb, red, blue)", "", null]) assert.equal(parseColor(bad), null, String(bad));
});

test("colour: WCAG contrast matches known values", () => {
  assert.equal(contrastRatio(parseColor("#000"), parseColor("#fff")), 21);
  assert.equal(contrastRatio(parseColor("#fff"), parseColor("#fff")), 1);
  assert.equal(contrastRatio(parseColor("#767676"), parseColor("#fff")), 4.54);
  // A translucent foreground is composited over the background first.
  assert.ok(contrastRatio(parseColor("#00000080"), parseColor("#fff")) < 21);
});

test("colour: preset references resolve through the palette, with var() fallbacks", () => {
  const palette = { base: "#ffffff", contrast: "#111111", alias: "var(--wp--preset--color--contrast)" };
  assert.deepEqual(resolveColorRef("var(--wp--preset--color--base)", palette), parseColor("#fff"));
  assert.deepEqual(resolveColorRef("var:preset|color|contrast", palette), parseColor("#111"));
  assert.deepEqual(resolveColorRef("var(--wp--preset--color--alias)", palette), parseColor("#111"));
  assert.deepEqual(resolveColorRef("var(--wp--preset--color--missing, #000)", palette), parseColor("#000"));
  assert.equal(resolveColorRef("currentColor", palette), null);
  assert.equal(isPlausibleCssColor("color-mix(in srgb, currentColor 20%, transparent)"), true);
  assert.equal(isPlausibleCssColor("#ggg"), false);
});

/* ------------------------------ diff ------------------------------ */

test("diff: preset arrays are matched by slug and block names are bracket-quoted", () => {
  const base = { color: { palette: { theme: [{ slug: "base", color: "#fff" }, { slug: "contrast", color: "#111" }] } }, blocks: { "core/button": { color: { text: "#000" } } } };
  const user = { color: { palette: { theme: [{ slug: "base", color: "#000" }, { slug: "contrast", color: "#111" }] } }, blocks: { "core/button": { color: { text: "#fff", background: "red" } } } };
  const diff = jsonDiff(base, user, { path: "settings" });
  assert.deepEqual(diff.map((d) => [d.path, d.change]), [
    ["settings.color.palette.theme[slug=base].color", "changed"],
    ['settings.blocks["core/button"].color.text', "changed"],
    ['settings.blocks["core/button"].color.background', "added"],
  ]);
  assert.equal(jsonDiff(base, user, { includeUnchanged: true }).filter((d) => d.change === "unchanged").length, 3);
  assert.deepEqual(jsonDiff({ a: 1, b: 2 }, { a: 1 }, { reportRemoved: true }), [{ path: "b", change: "removed", base: 2 }]);
});

test("palettes: raw arrays, origin-keyed REST data and page CSS all flatten to slug maps", () => {
  assert.deepEqual(paletteMap([{ slug: "A", color: "#fff" }]), { a: "#fff" });
  assert.deepEqual(paletteMap({ default: [{ slug: "a", color: "#000" }], theme: [{ slug: "a", color: "#fff" }] }), { a: "#fff" });
  assert.deepEqual(paletteFromCss(":root{--wp--preset--color--base: #FFFFFF;--wp--preset--color--accent-1: #FFEE58;}"), { base: "#FFFFFF", "accent-1": "#FFEE58" });
});

/* ------------------------------ lint ------------------------------ */

test("lint: catches duplicate slugs, bad colours, missing font src, deprecated keys and missing templates", () => {
  const doc = {
    version: 1,
    settings: {
      color: { palette: [{ slug: "a", name: "A", color: "#fff" }, { slug: "a", name: "B", color: "#12345" }] },
      typography: {
        customLineHeight: true,
        fontSizes: [{ slug: "s", name: "S", size: "1rem" }, { slug: "s", name: "S2", size: "2rem" }],
        fontFamilies: [{ name: "X", slug: "x", fontFamily: "X", fontFace: [{ fontFamily: "X" }] }],
      },
      spacing: { spacingSizes: [{ slug: "10", size: "1px" }, { slug: "10", size: "2px" }] },
      blocks: { "core/post-comments": {} },
    },
    customTemplates: [{ name: "landing", title: "Landing" }],
    templateParts: [{ name: "header", area: "header" }, { name: "ghost", area: "header" }],
    bogus: true,
  };
  const r = lintThemeJson(doc, { expectVersion: true, templateSlugs: ["index"], templatePartSlugs: ["header"] });
  const rules = (list) => list.map((i) => `${i.rule}@${i.path}`);
  assert.ok(rules(r.errors).includes("duplicate-slug@settings.color.palette[1].slug"));
  assert.ok(rules(r.errors).includes("duplicate-slug@settings.typography.fontSizes[1].slug"));
  assert.ok(rules(r.errors).includes("duplicate-slug@settings.spacing.spacingSizes[1].slug"));
  assert.ok(rules(r.errors).includes("invalid-color@settings.color.palette[1].color"));
  assert.ok(rules(r.errors).includes("font-face-missing-src@settings.typography.fontFamilies[0].fontFace[0].src"));
  assert.ok(rules(r.errors).includes("custom-template-missing@customTemplates[0].name"));
  assert.ok(rules(r.errors).includes("template-part-missing@templateParts[1].name"));
  assert.ok(rules(r.warnings).includes("version-outdated@version"));
  assert.ok(rules(r.warnings).includes("deprecated-key@settings.typography.customLineHeight"));
  assert.ok(rules(r.warnings).includes('deprecated-block@settings.blocks["core/post-comments"]'));
  assert.ok(rules(r.warnings).includes("unknown-top-level-key@bogus"));
});

test("lint: REST origin-keyed presets only flag duplicates within one origin", () => {
  const r = lintThemeJson({ settings: { color: { palette: { default: [{ slug: "black", name: "Black", color: "#000" }], theme: [{ slug: "black", name: "Black", color: "#111" }] } } } });
  assert.equal(r.errors.length, 0);
});

test("lint: a clean v3 file passes", () => {
  const r = lintThemeJson({
    version: 3,
    settings: { color: { palette: [{ slug: "base", name: "Base", color: "#ffffff" }, { slug: "contrast", name: "Contrast", color: "#111111" }] } },
    styles: { color: { background: "var:preset|color|base", text: "var:preset|color|contrast" }, elements: { link: { color: { text: "currentColor" } } } },
  }, { expectVersion: true });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test("contrast: checks root, elements, hover states, blocks and section variations; skips separators", () => {
  const palette = { base: "#ffffff", contrast: "#111111", yellow: "#ffee58", dark: "#222222" };
  const styles = {
    color: { background: "var(--wp--preset--color--base)", text: "var(--wp--preset--color--contrast)" },
    elements: {
      link: { color: { text: "var(--wp--preset--color--yellow)" } },
      button: { color: { text: "#fff", background: "var(--wp--preset--color--contrast)" }, ":hover": { color: { background: "#eeeeee" } } },
      h1: { color: { text: "#949494" } },
    },
    blocks: {
      "core/separator": { color: { text: "#eeeeee" } },
      "core/group": { variations: { dark: { color: { background: "var(--wp--preset--color--dark)", text: "#333333" } } } },
    },
  };
  const issues = contrastIssues(styles, palette);
  const paths = issues.map((i) => i.path);
  assert.ok(paths.includes("styles.elements.link.color"), "yellow link on white");
  assert.ok(paths.includes('styles.elements.button[":hover"].color'), "white text on light hover background");
  assert.ok(paths.includes('styles.blocks["core/group"].variations.dark.color'), "dark section with dark text");
  assert.ok(!paths.includes("styles.elements.h1.color"), "#949494 on white is 3.03:1, fine for a large heading");
  assert.ok(!paths.some((p) => p.includes("separator")));
  assert.ok(!paths.includes("styles.color"));
});

test("variations: kinds are inferred, titles disambiguated and partials merged", () => {
  const full = { title: "Evening", settings: { color: { palette: { theme: [{ slug: "base", color: "#000" }] } } }, styles: { color: { text: "#fff" }, spacing: { padding: { top: "1rem" } } } };
  const color = { title: "Evening", settings: { color: { palette: { theme: [{ slug: "base", color: "#000" }] } } }, styles: { color: { text: "#fff" } } };
  const type = { title: "Serif", slug: "typography-preset-1", settings: { typography: { fontFamilies: { theme: [{ name: "Lora", slug: "lora" }] } } }, styles: { typography: { fontFamily: "var:preset|font-family|lora" } } };
  assert.deepEqual([full, color, type].map(variationKind), ["full", "color", "typography"]);
  assert.equal(summarizeVariation(type, 2).font_families[0], "Lora");

  const list = [full, color, type];
  assert.throws(() => pickVariation(list, { title: "evening" }), /matches 2 variations/);
  assert.equal(pickVariation(list, { title: "Evening", kind: "color" }).index, 1);
  assert.equal(pickVariation(list, { title: "typography-preset-1" }).index, 2);
  assert.throws(() => pickVariation(list, { index: 9 }), /no variation at index 9/);
  assert.throws(() => pickVariation(list, { title: "Nope" }), /Available: Evening \(full\)/);

  const current = { settings: { typography: { fontSizes: [1] } }, styles: { color: { background: "#abc" } } };
  assert.deepEqual(proposeVariationStyles(current, color, "merge"), {
    settings: { typography: { fontSizes: [1] }, color: color.settings.color },
    styles: { color: { background: "#abc", text: "#fff" } },
  });
  assert.deepEqual(proposeVariationStyles(current, full, "replace"), { settings: full.settings, styles: full.styles });
});

test("parseJsonText reports a location instead of throwing", () => {
  assert.ok(parseJsonText("{\n  \"a\": ,\n}").error);
  assert.equal(parseJsonText("{\n  \"a\": ,\n}").value, undefined);
  assert.deepEqual(parseJsonText("{\"a\":1}").value, { a: 1 });
});

/* ------------------------------ HTML ------------------------------ */

test("html: tokenizer survives quotes with >, raw text, comments and unclosed tags", () => {
  const doc = parseHtml(`<!doctype html><html lang="en"><head><title>T &amp; U</title><style>p>a{color:red}</style>
    <script>if (a < b && "</p>") {}</script></head><body><!-- <img> -->
    <p data-x="a>b">one<p>two<ul><li>x<li>y</ul><div/><span>inside div</span></body></html>`);
  assert.equal(doc.title, "T & U");
  assert.ok(doc.css.includes("p>a"));
  assert.equal(doc.elements.filter((e) => e.tag === "img").length, 0, "comment content is not parsed");
  const ps = doc.elements.filter((e) => e.tag === "p");
  assert.equal(ps.length, 2);
  assert.equal(ps[0].attrs["data-x"], "a>b");
  assert.equal(textContent(ps[0]), "one", "an open <p> is closed by the next <p>");
  assert.equal(doc.elements.filter((e) => e.tag === "li").length, 2);
  const span = doc.elements.find((e) => e.tag === "span");
  assert.equal(span.parent.tag, "div", "<div/> is not self-closing in HTML");
});

const page = (body, head = "") => `<!doctype html><html lang="en"><head><title>x</title><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body><h1>Title</h1>${body}</body></html>`;
const rulesOf = (report) => report.issues.map((i) => i.rule).sort();

test("a11y: a clean page has no issues", () => {
  const r = checkAccessibility(page(`<h2>Sub</h2><img src="a.png" alt="A cat"><img src="b.png" alt="">
    <a href="/pricing">See pricing</a><a href="/x"><span class="screen-reader-text">Read more about pricing</span></a>
    <label for="q">Search</label><input id="q" type="search"><button aria-label="Close"><svg></svg></button>
    <iframe title="Map" src="/m"></iframe><video autoplay muted controls></video>`));
  assert.deepEqual(r.issues, []);
  assert.equal(r.stats.decorative_images, 1);
});

test("a11y: each rule fires on its failure", () => {
  const r = checkAccessibility(`<html><head><meta name="viewport" content="width=device-width, user-scalable=no"></head><body>
    <h1>A</h1><h1>B</h1><h4>skip</h4>
    <img src="/x.png"><a href="/a"><img src="/i.png" alt=""></a><a href="/b">Click here</a>
    <button></button><input type="text" placeholder="Name"><select></select>
    <span id="d"></span><span id="d"></span><iframe src="/e"></iframe><audio autoplay></audio></body></html>`);
  assert.deepEqual([...new Set(rulesOf(r))], [
    "button-name", "document-title", "duplicate-id", "form-label", "frame-title", "heading-order", "html-lang",
    "image-alt", "link-name", "link-text-generic", "media-autoplay", "meta-viewport", "single-h1",
  ]);
  for (const issue of r.issues) {
    assert.ok(issue.wcag && issue.fix && issue.severity, `${issue.rule} is fully described`);
    assert.ok(issue.snippet.length <= 161);
  }
  assert.equal(r.issues.filter((i) => i.rule === "form-label").length, 2);
});

test("a11y: labels via wrapping, aria-labelledby and title all count", () => {
  const r = checkAccessibility(page(`<label>Email <input type="email"></label><span id="l">Phone</span><input aria-labelledby="l"><input title="Zip"><input type="hidden"><input type="submit">`));
  assert.deepEqual(r.issues, []);
});

test("a11y: palette-class contrast uses the page's CSS variables and the nearest coloured ancestor", () => {
  const head = `<style>:root{--wp--preset--color--base:#ffffff;--wp--preset--color--contrast:#111111;--wp--preset--color--accent-1:#ffee58;--wp--preset--color--accent-4:#686868;}body{background-color: var(--wp--preset--color--base);color: var(--wp--preset--color--contrast);}</style>`;
  const r = checkAccessibility(page(`
    <p class="has-accent-1-color has-text-color">yellow on white</p>
    <div class="has-contrast-background-color has-background"><p class="has-accent-4-color has-text-color">grey on black</p></div>
    <div class="has-contrast-background-color has-background"><p class="has-base-color has-text-color">white on black</p></div>
    <h2 class="has-accent-4-color has-text-color">large grey heading</h2>
    <p class="has-accent-1-color has-text-color">yellow again</p>
    <div class="has-accent-1-gradient-background"><p class="has-base-color">on a gradient</p></div>`, head), { rules: ["color-contrast"] });
  const messages = r.issues.map((i) => i.message);
  assert.equal(r.issues.length, 2, messages.join("\n"));
  assert.match(messages[0], /#ffee58 \(accent-1\) on #ffffff has contrast 1\.19:1/);
  assert.match(messages[1], /#686868 \(accent-4\) on #111111/);
});

test("a11y: the options palette is the fallback when the page defines no variables", () => {
  const r = checkAccessibility(page(`<p class="has-pale-color has-text-color">x</p>`), { palette: { pale: "#eeeeee" }, rootBackground: "#ffffff", rules: ["color-contrast"] });
  assert.equal(r.issues.length, 1);
});

/* ------------------------------ tools ------------------------------ */

function fakeClient(routes) {
  const calls = [];
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
    assertWritable: () => {},
    hasHelperPlugin: async () => false,
    get: handle("GET"),
    post: handle("POST"),
    del: handle("DELETE"),
  };
}
const tool = (client, name) => themeDevTools({ registry: { resolve: () => client } }).find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text.split("\n\n").slice(res.content[0].text.startsWith("{") ? 0 : 1).join("\n\n"));

test("tools: every parameter is described and annotations are set", () => {
  const tools = themeDevTools({ registry: { resolve: () => null } });
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "apply_style_variation", "check_accessibility", "diff_global_styles", "list_block_patterns",
    "list_style_variations", "reset_template_customization", "validate_theme_json",
  ]);
  for (const t of tools) {
    assert.ok(t.description.length >= 40, t.name);
    assert.equal(Boolean(t.readOnly) !== Boolean(t.destructive), true, `${t.name} is either read-only or destructive`);
    for (const [k, v] of Object.entries(t.schema)) {
      if (k === "site_id") continue;
      const d = schemaDescription(v);
      assert.ok(d, `${t.name}.${k} has a description`);
    }
  }
});

test("reset_template_customization: refuses theme-sourced templates and needs a matching token", async () => {
  let template = { id: "tt//single", slug: "single", source: "custom", has_theme_file: true, wp_id: 5, modified: "2026-01-01T00:00:00", content: { raw: "<!-- wp:post-content /-->" }, title: { raw: "Single" } };
  const client = fakeClient({
    "GET /wp/v2/templates/tt//single": () => template,
    "GET /wp/v2/templates/tt//page": { id: "tt//page", source: "theme" },
    "DELETE /wp/v2/templates/tt//single": () => { template = { ...template, source: "theme", wp_id: 0 }; return { deleted: true }; },
  });
  const t = tool(client, "reset_template_customization");

  const refused = parse(await t.handler({ id: "tt//page", kind: "template" }));
  assert.equal(refused.refused, true);

  const dry = parse(await t.handler({ id: "tt//single", kind: "template" }));
  assert.equal(dry.dry_run, true);
  assert.match(dry.outcome, /REVERT/);
  assert.ok(!client.calls.some((c) => c.method === "DELETE"), "the preview deletes nothing");

  const wrong = parse(await t.handler({ id: "tt//single", kind: "template", confirm_token: "confirm.bad.sig" }));
  assert.equal(wrong.refused, true);

  const done = parse(await t.handler({ id: "tt//single", kind: "template", confirm_token: dry.confirm_token }));
  assert.equal(done.reset, true);
  const del = client.calls.find((c) => c.method === "DELETE");
  assert.deepEqual(del.query, { force: true });
  assert.equal(done.now.source, "theme");
});

test("apply_style_variation: previews a diff, then writes exactly the proposed styles", async () => {
  let user = { id: 10, settings: {}, styles: { color: { background: "#abcdef" } } };
  const variations = [{ title: "Dark", settings: { color: { palette: { theme: [{ slug: "base", color: "#000000" }] } } }, styles: { color: { text: "#ffffff" } } }];
  const client = fakeClient({
    "GET /wp/v2/themes": [{ stylesheet: "tt", template: "tt", is_block_theme: true, _links: { "wp:user-global-styles": [{ href: "https://example.com/wp-json/wp/v2/global-styles/10" }] } }],
    "GET /wp/v2/global-styles/themes/tt/variations": variations,
    "GET /wp/v2/global-styles/10": () => user,
    "POST /wp/v2/global-styles/10": (call) => { user = { id: 10, ...call.body }; return user; },
    "GET /wp/v2/global-styles/10/revisions": [],
  });
  const t = tool(client, "apply_style_variation");
  const dry = parse(await t.handler({ title: "Dark", mode: "auto" }));
  assert.equal(dry.mode, "merge", "a colour-only variation merges");
  assert.deepEqual(dry.diff.map((d) => d.path).sort(), ["settings.color.palette.theme", "styles.color.text"]);
  assert.ok(!client.calls.some((c) => c.method === "POST"));

  const applied = parse(await t.handler({ title: "Dark", mode: "auto", confirm_token: dry.confirm_token }));
  assert.equal(applied.applied, true);
  assert.deepEqual(user.styles, { color: { background: "#abcdef", text: "#ffffff" } });
  assert.equal(applied.not_stored_by_wordpress, undefined);
});
