import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  parseAdminStructure, buildFormBody, stableFieldValues, closeMatches, formRanges, missingGroupOptions, looksIncomplete, countRawControls,
} from "../dist/lib/plugin-control-html.js";
import { parseHtml } from "../dist/lib/themedev-html.js";
import {
  pluginControlTools, newFlowId, normalizeAdminPath, isActionLink, isLoginRedirect, actionAllowed, collateralChanges, FORBIDDEN_SUBMIT,
} from "../dist/tools/plugin-control.js";
import { schemaDescription } from "../dist/lib/tooling.js";
import { installNodePlatform } from "../dist/platform-node.js";

installNodePlatform();

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const SITE = "https://example.test";

/* ------------------------------ fixtures ------------------------------ */

/** A wp-admin settings screen shaped like options-general.php, including the traps that broke tree-based parsing. */
function settingsPage({ tagline = "Just another site", notify = true, nonce = "abc123", notice = "" } = {}) {
  return `<!doctype html><html><head><title>General Settings &lsaquo; Test &#8212; WordPress</title></head><body>
<div id="wpwrap"><div id="screen-meta"><div class="unclosed">
<div class="wrap"><h1>General Settings</h1>
${notice}
<div class="notice notice-warning"><p>Heads up</p></div>
<a href="options-reading.php">Reading</a> <a href="https://elsewhere.test/">Off</a>
<form method="post" action="options.php" novalidate="novalidate">
<input type="hidden" name="option_page" value="general" /><input type="hidden" name="action" value="update" />
<input type="hidden" id="_wpnonce" name="_wpnonce" value="${nonce}" /><input type="hidden" name="_wp_http_referer" value="/wp-admin/options-general.php" />
<table class="form-table" role="presentation">
<tr><th scope="row"><label for="blogname">Site Title</label></th><td><input name="blogname" type="text" id="blogname" value="Test" /></td></tr>
<tr><th scope="row"><label for="blogdescription">Tagline</label></th><td><input name="blogdescription" type="text" id="blogdescription" value="${tagline}" />
<p class="description">In a few words.</p></td></tr>
<tr><th scope="row">Site Icon</th><td>
<style>:root { --site-icon-url: url( '' ); }</style>
<div class="preview"><div class="wrap2"><svg role="img"><path d="M0 0" /></svg><div class="tab">
<script>var t = "</form>";</script>
</div></div></div></div>
<input type="hidden" name="site_icon" value="0" /></td></tr>
<tr><th scope="row">Membership</th><td><label><input name="comments_notify" type="checkbox" value="1" ${notify ? "checked='checked'" : ""} /> Notify me</label></td></tr>
<tr><th scope="row">Role</th><td><select name="default_role"><option value="subscriber" selected='selected'>Subscriber</option><option value="author">Author</option></select></td></tr>
<tr><th scope="row">Format</th><td><label><input type="radio" name="date_format" value="F j, Y" checked='checked' /> Long</label><label><input type="radio" name="date_format" value="Y-m-d" /> ISO</label></td></tr>
<tr><th>Notes</th><td><textarea name="notes">line one</textarea></td></tr>
<tr><th>Key</th><td><input type="password" name="api_key" value="secret" /></td></tr>
</table>
<p class="submit"><input type="submit" name="submit" id="submit" class="button button-primary" value="Save Changes" /></p></form>
<input form="other" name="outside_other" value="x" />
<form id="other" method="get" action=""><input name="s" value="" /></form>
</div></div></body></html>`;
}

/* ------------------------------ parsing ------------------------------ */

test("parse: every field is captured even with stray unclosed divs, svg, style and a </form> inside a script", () => {
  const s = parseAdminStructure(settingsPage());
  assert.equal(s.title, "General Settings ‹ Test — WordPress");
  const form = s.forms[0];
  const names = form.fields.map((f) => f.name);
  for (const n of ["option_page", "action", "_wpnonce", "_wp_http_referer", "blogname", "blogdescription", "site_icon", "comments_notify", "default_role", "date_format", "notes", "api_key"]) {
    assert.ok(names.includes(n), `missing ${n}: ${names.join(",")}`);
  }
  assert.equal(form.action, "options.php");
  assert.equal(form.method, "post");
  assert.equal(form.has_nonce, true);
  assert.deepEqual(form.submit_buttons, ["Save Changes"]);
  assert.ok(!names.includes("outside_other"), "a form=\"other\" control belongs to the other form");
  assert.ok(s.forms[1].fields.some((f) => f.name === "outside_other"));
  assert.equal(s.forms[1].method, "get");
});

test("parse: labels, values, options, descriptions and sensitive flags", () => {
  const f = Object.fromEntries(parseAdminStructure(settingsPage()).forms[0].fields.map((x) => [x.name, x]));
  assert.equal(f.blogdescription.label, "Tagline");
  assert.equal(f.blogdescription.description, "In a few words.");
  assert.equal(f.site_icon.value, "0");
  assert.equal(f.comments_notify.type, "checkbox");
  assert.equal(f.comments_notify.checked, true);
  assert.equal(f.comments_notify.label, "Notify me");
  assert.equal(f.default_role.value, "subscriber");
  assert.deepEqual(f.default_role.options.map((o) => o.value), ["subscriber", "author"]);
  assert.equal(f.date_format.value, "F j, Y");
  assert.equal(f.date_format.options.length, 2);
  assert.equal(f.notes.value, "line one");
  assert.equal(f.api_key.sensitive, true);
  assert.equal(f.blogname.label, "Site Title");
});

test("parse: notices are typed by their notice-* class, not by the settings-error wrapper", () => {
  const saved = `<div id="setting-error-settings_updated" class="notice notice-success settings-error is-dismissible"><p><strong>Settings saved.</strong></p></div>`;
  const s = parseAdminStructure(settingsPage({ notice: saved }));
  assert.deepEqual(s.notices.find((n) => /saved/.test(n.text)), { type: "success", text: "Settings saved." });
  assert.equal(s.notices.find((n) => /Heads up/.test(n.text)).type, "warning");
  assert.ok(s.links.some((l) => l.href === "options-reading.php"));
  assert.ok(!s.links.some((l) => l.href.includes("elsewhere")));
});

test("formRanges: an unclosed form ends where the next form starts", () => {
  const html = `<form id="a"><input name="x"><form id="b"><input name="y"></form>`;
  const doc = parseHtml(html);
  const forms = doc.elements.filter((e) => e.tag === "form");
  const ranges = formRanges(html, forms);
  assert.equal(ranges[0][1], forms[1].start);
  const s = parseAdminStructure(html);
  assert.deepEqual(s.forms.map((f) => f.fields.map((x) => x.name)), [["x"], ["y"]]);
});

/* ------------------------------ body building ------------------------------ */

test("buildFormBody: keeps hidden fields and nonce, applies changes, omits unchecked checkboxes", () => {
  const form = parseAdminStructure(settingsPage()).forms[0];
  const { body, changed, unknown } = buildFormBody(form, { blogdescription: "New tagline", comments_notify: false });
  const p = new URLSearchParams(body);
  assert.equal(p.get("_wpnonce"), "abc123");
  assert.equal(p.get("option_page"), "general");
  assert.equal(p.get("blogname"), "Test");
  assert.equal(p.get("blogdescription"), "New tagline");
  assert.equal(p.get("site_icon"), "0");
  assert.equal(p.has("comments_notify"), false, "an unchecked checkbox is not sent");
  assert.equal(p.get("date_format"), "F j, Y");
  assert.equal(p.get("default_role"), "subscriber");
  assert.deepEqual(unknown, []);
  assert.deepEqual(changed.map((c) => c.name).sort(), ["blogdescription", "comments_notify"]);

  const checked = new URLSearchParams(buildFormBody(parseAdminStructure(settingsPage({ notify: false })).forms[0], { comments_notify: true }).body);
  assert.equal(checked.get("comments_notify"), "1", "a checked checkbox sends its value attribute");

  assert.deepEqual(buildFormBody(form, { blogdescriptio: "x" }).unknown, ["blogdescriptio"]);
});

test("stableFieldValues ignores the nonce, referer and secrets; closeMatches suggests names", () => {
  const a = parseAdminStructure(settingsPage({ nonce: "one" })).forms[0];
  const b = parseAdminStructure(settingsPage({ nonce: "two" })).forms[0];
  assert.deepEqual(stableFieldValues(a), stableFieldValues(b));
  assert.ok(!stableFieldValues(a).some(([n]) => n === "api_key" || n === "_wpnonce"));
  const c = parseAdminStructure(settingsPage({ tagline: "changed" })).forms[0];
  assert.notDeepEqual(stableFieldValues(a), stableFieldValues(c));
  assert.deepEqual(closeMatches("blogdescriptio", ["blogname", "blogdescription"]), ["blogdescription"]);
  assert.deepEqual(collateralChanges(a, c, new Set()), [{ name: "blogdescription", before: "Just another site", after: "changed" }]);
  assert.deepEqual(collateralChanges(a, c, new Set(["blogdescription"])), []);
});

test("path helpers", () => {
  assert.equal(normalizeAdminPath("https://example.test/wp-admin/admin.php?page=wpseo_titles"), "admin.php?page=wpseo_titles");
  assert.equal(normalizeAdminPath("/wp-admin/"), "index.php");
  assert.equal(normalizeAdminPath("options-general.php"), "options-general.php");
  assert.equal(isActionLink("plugins.php?action=activate&plugin=x&_wpnonce=abc"), true);
  assert.equal(isActionLink("admin.php?page=wpseo_titles"), false);
  assert.equal(isLoginRedirect("https://example.test/wp-login.php?redirect_to=x&reauth=1"), true);
  assert.equal(isLoginRedirect("https://example.test/wp-admin/options-general.php?settings-updated=true"), false);
  assert.equal(actionAllowed("options.php"), true);
  for (const p of ["plugins.php", "plugin-editor.php?file=x", "theme-editor.php", "user-new.php", "users.php?action=delete&user=2", "tools.php?page=export", "update-core.php"]) {
    assert.ok(FORBIDDEN_SUBMIT.some((f) => f.re.test(p)), p);
  }
  assert.ok(!FORBIDDEN_SUBMIT.some((f) => f.re.test("options-general.php")));
});

/* ------------------------------ tools ------------------------------ */

test("tools: names, described parameters, annotations, zod-portable schemas", () => {
  const tools = pluginControlTools({ registry: { resolve: () => null } });
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "admin_page", "get_plugin_settings", "inspect_plugin", "list_admin_pages", "restore_plugin_settings", "submit_admin_form", "update_plugin_settings",
  ]);
  for (const t of tools) {
    assert.ok(t.description.length >= 80, t.name);
    assert.equal(Boolean(t.readOnly) !== Boolean(t.destructive), true, `${t.name} is either read-only or destructive`);
    for (const [k, v] of Object.entries(t.schema)) {
      if (k === "site_id") continue;
      assert.ok(schemaDescription(v), `${t.name}.${k} has a description`);
    }
    // The raw shape must build and parse under the installed zod (3 or 4).
    z.object(t.schema).safeParse({});
  }
  const submit = tools.find((t) => t.name === "submit_admin_form");
  assert.equal(z.object(submit.schema).safeParse({ page: "options-general.php", changes: { a: 1, b: true } }).success, true);
});

/** A WordPressClient stand-in: REST calls are answered by `routes`, everything is recorded. */
function fakeClient({ routes = {}, writable = true, helper = true } = {}) {
  const calls = [];
  const handle = (method) => async (route, arg) => {
    calls.push({ method, route, arg });
    const key = `${method} ${route.split("?")[0]}`;
    const h = routes[key];
    if (h === undefined) throw new Error(`unexpected ${key}`);
    return { data: typeof h === "function" ? h(arg) : h };
  };
  return {
    calls,
    site: { id: "t", url: SITE, headers: { "X-Gate": "1" }, username: "admin", appPassword: "secret pw", writable },
    async hasHelperPlugin() { return helper; },
    assertWritable(action) { if (!writable) throw new Error(`Site "t" is configured read-only (writable: false), so "${action}" was refused.`); },
    get: handle("GET"),
    post: handle("POST"),
  };
}
const tool = (client, name) => pluginControlTools({ registry: { resolve: () => client } }).find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text.startsWith("{") ? res.content[0].text : res.content[0].text.split("\n\n").slice(1).join("\n\n"));

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = original; });
}

test("update_plugin_settings: read-only sites and protected options are refused before any write", async () => {
  const ro = fakeClient({ writable: false });
  await assert.rejects(tool(ro, "update_plugin_settings").handler({ plugin: "wordpress-seo", option: "wpseo_titles", changes: { a: 1 } }), /read-only/);
  assert.equal(ro.calls.length, 0);

  const c = fakeClient();
  const res = parse(await tool(c, "update_plugin_settings").handler({ plugin: "wordpress-seo", option: "siteurl", value: "x" }));
  assert.equal(res.refused, true);
  assert.ok(!c.calls.some((x) => x.method === "POST"));
});

test("update_plugin_settings: dry run issues a bound token; confirm applies; a changed option invalidates the token", async () => {
  let value = { separator: "sc-dash" };
  const c = fakeClient({
    routes: {
      "GET /wpxmcp/v1/plugins/settings": () => ({ option: "wpseo_titles", owned: true, value }),
      "GET /wpxmcp/v1/plugins/inspect": { registered_settings: [{ option_name: "wpseo_titles", registered_in: "wp-admin only" }] },
      "POST /wpxmcp/v1/plugins/settings": (body) => { value = { ...value, ...body.changes }; return { updated: true, changed: true, sanitize_filter_ran: true, sanitizer_adjusted: [], value_after_sanitize: value, undo: "restore" }; },
    },
  });
  const t = tool(c, "update_plugin_settings");
  const args = { plugin: "wordpress-seo", option: "wpseo_titles", changes: { separator: "sc-pipe" }, force_option: false };
  const dry = parse(await t.handler(args));
  assert.equal(dry.dry_run, true);
  assert.match(dry.sanitizer_warning, /only inside wp-admin/);
  assert.ok(!c.calls.some((x) => x.method === "POST"));

  const applied = parse(await t.handler({ ...args, confirm_token: dry.confirm_token }));
  assert.equal(applied.updated, true);
  assert.equal(applied.value_after_sanitize.separator, "sc-pipe");
  assert.deepEqual(c.calls.find((x) => x.method === "POST").arg, { plugin: "wordpress-seo", option: "wpseo_titles", force_option: false, changes: { separator: "sc-pipe" } });

  // A token from a preview of an older option value no longer matches.
  const stale = parse(await t.handler({ ...args, confirm_token: dry.confirm_token }));
  assert.equal(stale.refused, true);
});

test("update_plugin_settings: options not attributable to the plugin are refused unless force_option", async () => {
  const c = fakeClient({
    routes: {
      "GET /wpxmcp/v1/plugins/settings": { option: "blogname", owned: false, value: "x" },
      "GET /wpxmcp/v1/plugins/inspect": { registered_settings: [] },
    },
  });
  const res = parse(await tool(c, "update_plugin_settings").handler({ plugin: "wordpress-seo", option: "blogname", value: "y", force_option: false }));
  assert.equal(res.refused, true);
  const forced = parse(await tool(c, "update_plugin_settings").handler({ plugin: "wordpress-seo", option: "blogname", value: "y", force_option: true }));
  assert.equal(forced.dry_run, true);
});

/** Serves a tokenised wp-admin for submit_admin_form and records what reached the "site". */
const GENERAL_GROUP = ["blogname", "blogdescription", "site_icon", "comments_notify", "default_role", "date_format", "notes", "api_key"];

function adminSite({ tagline = "Old", changeBetween = false, group = GENERAL_GROUP } = {}) {
  const requests = [];
  let current = tagline;
  let gets = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    requests.push({ url: u, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    assert.equal(u.searchParams.get("wpxmcp_admin"), TOKEN, "every wp-admin request carries the token");
    if ((init.method ?? "GET") === "POST") {
      const p = new URLSearchParams(init.body);
      if (p.get("_wpnonce") === "abc123") current = p.get("blogdescription");
      return new Response(null, { status: 302, headers: { location: `${SITE}/wp-admin/options-general.php?settings-updated=true` } });
    }
    gets++;
    if (changeBetween && gets === 3) current = "someone else";
    const notice = u.searchParams.get("settings-updated") ? `<div class="notice notice-success settings-error"><p>Settings saved.</p></div>` : "";
    return new Response(settingsPage({ tagline: current, notice }), { status: 200, headers: { "content-type": "text/html" } });
  };
  const client = fakeClient({
    routes: {
      "POST /wpxmcp/v1/admin/token": () => ({ token: TOKEN }),
      "GET /wpxmcp/v1/admin/allowed-options": (q) => ({ captured: true, option_page: q.option_page, group_known: true, options: group }),
    },
  });
  return { requests, fetchImpl, client, value: () => current };
}

test("submit_admin_form: previews, then submits same-site with a fresh nonce and reads back the result", async () => {
  const site = adminSite();
  const t = tool(site.client, "submit_admin_form");
  const args = { page: "options-general.php", form_index: 0, changes: { blogdescription: "New" }, allow_sensitive: false };
  await withFetch(site.fetchImpl, async () => {
    const dry = parse(await t.handler(args));
    assert.equal(dry.dry_run, true);
    assert.deepEqual(dry.changed_fields, [{ name: "blogdescription", from: "Old", to: "New" }]);
    assert.ok(!site.requests.some((r) => r.method === "POST"), "the dry run posts nothing");

    const done = parse(await t.handler({ ...args, confirm_token: dry.confirm_token }));
    assert.equal(done.submitted, true);
    assert.equal(done.posted_to, "options.php");
    assert.deepEqual(done.notices.find((n) => n.type === "success"), { type: "success", text: "Settings saved." });
    assert.deepEqual(done.values_after_save, { blogdescription: "New" });
    assert.equal(done.collateral_changes, undefined);
    assert.equal(site.value(), "New");
  });

  const post = site.requests.find((r) => r.method === "POST");
  assert.equal(post.url.pathname, "/wp-admin/options.php");
  assert.equal(post.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(post.headers.Authorization, undefined, "credentials never go to wp-admin");
  assert.equal(post.headers.Cookie, undefined);
  assert.equal(post.headers["X-Gate"], "1", "site gate headers are kept");
  const body = new URLSearchParams(post.body);
  assert.equal(body.get("blogname"), "Test");
  assert.equal(body.get("site_icon"), "0");
  assert.equal(body.get("comments_notify"), "1");
  const tokenRequests = site.client.calls.filter((c) => c.route.endsWith("/admin/token")).map((c) => c.arg);
  // The confirm call's GET, POST and read-back share one flow (so the form nonce validates); the dry run used another.
  const postFlow = tokenRequests.find((a) => a.method === "POST").flow;
  assert.match(postFlow, /^[A-Za-z0-9]{16,64}$/);
  const flows = new Set(tokenRequests.map((a) => a.flow));
  assert.equal(flows.size, 2, "one flow per tool call");
  assert.ok(tokenRequests.some((a) => a.method === "POST" && a.path === "options.php"));
  assert.ok(tokenRequests.every((a) => a.method === "GET" || a.path === "options.php"));
});

test("submit_admin_form: refuses when other values changed between preview and submit", async () => {
  const site = adminSite({ changeBetween: true });
  const t = tool(site.client, "submit_admin_form");
  const args = { page: "options-general.php", changes: { blogname: "Renamed" }, allow_sensitive: false };
  await withFetch(site.fetchImpl, async () => {
    const dry = parse(await t.handler(args));
    const res = parse(await t.handler({ ...args, confirm_token: dry.confirm_token }));
    assert.equal(res.refused, true);
    assert.ok(!site.requests.some((r) => r.method === "POST"));
  });
});

test("submit_admin_form: guards — unknown fields, sensitive fields, forbidden screens, GET forms, read-only", async () => {
  const site = adminSite();
  const t = tool(site.client, "submit_admin_form");
  await withFetch(site.fetchImpl, async () => {
    const unknown = parse(await t.handler({ page: "options-general.php", changes: { blogdescriptio: "x" } }));
    assert.equal(unknown.refused, true);
    assert.deepEqual(unknown.suggestions, { blogdescriptio: ["blogdescription"] });

    const secret = parse(await t.handler({ page: "options-general.php", changes: { api_key: "new" }, allow_sensitive: false }));
    assert.equal(secret.refused, true);
    assert.match(secret.reason, /allow_sensitive/);

    const getForm = parse(await t.handler({ page: "options-general.php", form_id: "other", changes: { s: "x" } }));
    assert.equal(getForm.refused, true);

    const plugins = parse(await t.handler({ page: "plugins.php", changes: { a: "b" } }));
    assert.equal(plugins.refused, true);
  });
  assert.ok(!site.requests.some((r) => r.method === "POST"));

  const ro = fakeClient({ writable: false });
  await assert.rejects(tool(ro, "submit_admin_form").handler({ page: "options-general.php", changes: { a: 1 } }), /read-only/);
});

test("submit_admin_form: refuses a form that posts off-site", async () => {
  const offsite = settingsPage().replace('action="options.php"', 'action="https://evil.test/collect"');
  const client = fakeClient({ routes: { "POST /wpxmcp/v1/admin/token": () => ({ token: TOKEN }) } });
  await withFetch(async () => new Response(offsite, { status: 200 }), async () => {
    const res = parse(await tool(client, "submit_admin_form").handler({ page: "options-general.php", changes: { blogname: "x" } }));
    assert.equal(res.refused, true);
    assert.match(res.reason, /not a wp-admin URL/);
  });
});

test("admin_page: a login redirect is an auth failure; nonce links are refused without fetching", async () => {
  const client = fakeClient({ routes: { "POST /wpxmcp/v1/admin/token": () => ({ token: TOKEN }) } });
  const t = tool(client, "admin_page");
  let fetched = 0;
  await withFetch(async () => { fetched++; return new Response(null, { status: 302, headers: { location: `${SITE}/wp-login.php?reauth=1` } }); }, async () => {
    await assert.rejects(t.handler({ url_or_page: "options-general.php" }), /login screen/);
    const res = parse(await t.handler({ url_or_page: "plugins.php?action=deactivate&plugin=x&_wpnonce=abc" }));
    assert.equal(res.refused, true);
  });
  assert.equal(fetched, 1);
});

test("admin_page: returns structure and hides sensitive values", async () => {
  const client = fakeClient({ routes: { "POST /wpxmcp/v1/admin/token": () => ({ token: TOKEN }) } });
  await withFetch(async () => new Response(settingsPage(), { status: 200 }), async () => {
    const res = parse(await tool(client, "admin_page").handler({ url_or_page: `${SITE}/wp-admin/options-general.php` }));
    assert.equal(res.page, "options-general.php");
    assert.equal(res.forms[0].fields.find((f) => f.name === "api_key").value, undefined);
    assert.equal(res.forms[0].fields.find((f) => f.name === "blogdescription").value, "Just another site");
  });
  assert.deepEqual(client.calls[0].arg, { path: "options-general.php", method: "GET" });
});

test("tools need the companion plugin", async () => {
  const client = fakeClient({ helper: false });
  await assert.rejects(tool(client, "inspect_plugin").handler({ plugin: "x" }), /companion plugin/);
});

/* ------------------------------ completeness guards ------------------------------ */

test("missingGroupOptions: names, array names, unchecked checkboxes, derived and unrendered core options", () => {
  const form = parseAdminStructure(settingsPage({ notify: false })).forms[0];
  assert.deepEqual(missingGroupOptions(form, ["blogname", "comments_notify", "default_role"], "general"), [], "an unchecked checkbox is still a field on the form");
  assert.deepEqual(missingGroupOptions(form, ["blogname", "start_of_week", "timezone_string"], "general"), ["start_of_week", "timezone_string"]);
  const arrayForm = parseAdminStructure(`<form method="post" action="options.php"><input name="option_page" value="my_group"><input name="my_opts[a]" value="1"><input name="my_opts[b][c]" value="2"></form>`).forms[0];
  assert.deepEqual(missingGroupOptions(arrayForm, ["my_opts", "my_other"], "my_group"), ["my_other"]);
  const tz = parseAdminStructure(`<form method="post" action="options.php"><select name="timezone_string"><option value="UTC+0" selected>UTC</option></select></form>`).forms[0];
  assert.deepEqual(missingGroupOptions(tz, ["timezone_string", "gmt_offset"], "general"), [], "gmt_offset is derived from timezone_string");
  assert.deepEqual(missingGroupOptions(tz, ["gmt_offset"], "reading"), ["gmt_offset"], "derivation is per group");
  assert.deepEqual(missingGroupOptions(tz, ["image_default_size", "thumbnail_size_w"], "media"), ["thumbnail_size_w"]);
  assert.deepEqual(missingGroupOptions(tz, ["anything"], "options"), [], "page_options forms name their own fields");
});

test("looksIncomplete / countRawControls: parsed controls well below the source count", () => {
  const html = `<form method="post"><input name="a"><input name="b"><script>var x = '<input name="fake">';</script><textarea name="t"><input name="inside"></textarea><button name="go">Go</button><input type="submit"></form>`;
  const form = parseAdminStructure(html).forms[0];
  assert.equal(form.raw_control_count, 4, "script contents and textarea bodies are not counted; unnamed controls are not counted");
  assert.equal(form.parsed_control_count, 4);
  assert.equal(looksIncomplete(form), false);
  assert.equal(looksIncomplete({ ...form, parsed_control_count: 3, raw_control_count: 10 }), true);
  assert.equal(countRawControls("<form><input name=a><select name='s'></select></form>", 0, 50), 2);
  assert.match(newFlowId(), /^[A-Za-z0-9]{18}$/);
  assert.notEqual(newFlowId(), newFlowId());
});

test("submit_admin_form: refuses (dry run) when options.php would blank options the form does not contain", async () => {
  const site = adminSite({ group: [...GENERAL_GROUP, "start_of_week", "date_format_custom_x"] });
  const t = tool(site.client, "submit_admin_form");
  await withFetch(site.fetchImpl, async () => {
    const res = parse(await t.handler({ page: "options-general.php", changes: { blogdescription: "New" }, allow_sensitive: false, force_incomplete_form: false }));
    assert.equal(res.refused, true);
    assert.deepEqual(res.would_wipe, ["start_of_week", "date_format_custom_x"]);
    assert.match(res.reason, /wipe those settings/);
    assert.equal(res.confirm_token, undefined, "no token is issued for an incomplete form");
  });
  assert.ok(!site.requests.some((r) => r.method === "POST"));
  assert.ok(site.requests.some((r) => r.url.pathname === "/wp-admin/options.php" && r.method === "GET"), "options.php is loaded to capture its allowlist");
});

test("submit_admin_form: the completeness check also runs on confirm, and force_incomplete_form overrides it", async () => {
  let group = GENERAL_GROUP;
  const site = adminSite();
  const routes = site.client;
  const t = tool(site.client, "submit_admin_form");
  const originalGet = routes.get;
  routes.get = async (route, q) => (route.endsWith("/admin/allowed-options") ? { data: { captured: true, options: group } } : originalGet(route, q));
  const args = { page: "options-general.php", changes: { blogdescription: "New" }, allow_sensitive: false, force_incomplete_form: false };
  await withFetch(site.fetchImpl, async () => {
    const dry = parse(await t.handler(args));
    assert.equal(dry.dry_run, true);
    group = [...GENERAL_GROUP, "start_of_week"];
    const refused = parse(await t.handler({ ...args, confirm_token: dry.confirm_token }));
    assert.equal(refused.refused, true);
    assert.deepEqual(refused.would_wipe, ["start_of_week"]);
    assert.ok(!site.requests.some((r) => r.method === "POST"));

    const forcedDry = parse(await t.handler({ ...args, force_incomplete_form: true }));
    assert.equal(forcedDry.dry_run, true);
    const forced = parse(await t.handler({ ...args, force_incomplete_form: true, confirm_token: forcedDry.confirm_token }));
    assert.equal(forced.submitted, true);
    // A token issued without the force flag does not authorise a forced submit.
    const mixed = parse(await t.handler({ ...args, force_incomplete_form: true, confirm_token: dry.confirm_token }));
    assert.equal(mixed.refused, true);
  });
});

test("submit_admin_form: refuses a non-options.php form whose parse is missing controls", async () => {
  // The parser attributes controls by source position; simulate a mis-parse by hiding controls behind a form="elsewhere" attribute.
  const html = `<form method="post" action="admin.php?page=my-plugin"><input name="_wpnonce" value="n"><input name="a" value="1" form="nowhere"><input name="b" value="2" form="nowhere"><input name="c" value="3" form="nowhere"><input name="d" value="4"></form>`;
  const client = fakeClient({ routes: { "POST /wpxmcp/v1/admin/token": () => ({ token: TOKEN }) } });
  const posts = [];
  await withFetch(async (url, init = {}) => { if (init.method === "POST") posts.push(url); return new Response(html, { status: 200 }); }, async () => {
    const res = parse(await tool(client, "submit_admin_form").handler({ page: "admin.php?page=my-plugin", changes: { d: "5" }, allow_sensitive: false, force_incomplete_form: false }));
    assert.equal(res.refused, true);
    assert.match(res.reason, /Only 2 of the 5 named controls/);
  });
  assert.equal(posts.length, 0);
});
