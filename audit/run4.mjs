/**
 * The 2.0 surface: diagnostics, profiling, introspection, theme development,
 * SEO and fleet, and operating plugins as an administrator. Like the other
 * suites it checks meaning, not just success, and that every guard refuses.
 */
import { connect, makeRunner } from "./harness.mjs";

const client = await connect();
const R = makeRunner(client);
const { call, expectOk, expectRefused, problems, notes } = R;
const section = (s) => console.log(`\n━━ ${s}`);
const OFFSITE = "https://example.org/";

/* ────────────────────────── OPERATIONS ────────────────────────── */
section("operations and security");
await expectOk("tail_error_log", { lines: 50 }, (d) => (d.log && Array.isArray(d.groups) && "last_fatal" in d) ? null : "missing log, groups or last_fatal");
await expectOk("backup_status", {}, (d) => Array.isArray(d.detected) && "latest_gmt" in d ? null : "backup contract shape changed");
await expectOk("security_audit", {}, (d) => {
  if (typeof d.score !== "number") return "no numeric score";
  if (!Array.isArray(d.findings)) return "no findings array";
  const order = ["critical", "high", "medium", "low", "info"];
  for (let i = 1; i < d.findings.length; i++) {
    if (order.indexOf(d.findings[i].severity) < order.indexOf(d.findings[i - 1].severity)) return "findings are not sorted by severity";
  }
  return null;
});
await expectOk("purge_cache", { scope: "url", url: "/" }, (d) => Array.isArray(d.purged) || Array.isArray(d.result?.purged) ? null : "no purged list");
await expectRefused("purge_cache", { scope: "url", url: OFFSITE }, /site|refus|only/i, "purge_cache(off-site)");

/* ────────────────────────── PROFILING ────────────────────────── */
section("profiling");
await expectOk("profile_url", { url: "/" }, (d) => (d.queries?.count > 0 && d.template) ? null : "no queries or template in the profile");
await expectOk("get_template_for_url", { url: "/" }, (d) => (d.template || d.block_template || d.file) ? null : "no template reported");
await expectRefused("profile_url", { url: OFFSITE }, /site|elsewhere|only/i, "profile_url(off-site)");

/* ────────────────────────── INTROSPECTION ────────────────────────── */
section("developer introspection");
await expectOk("inspect_registry", { kind: "rest_routes", filter: "wpxmcp/v1" }, (d) => JSON.stringify(d).includes("wpxmcp/v1") ? null : "own namespace missing from rest_routes");
await expectOk("inspect_registry", { kind: "hooks", filter: "init" }, (d) => /\.php:\d+/.test(JSON.stringify(d)) ? null : "hook callbacks carry no file:line");
await expectOk("inspect_registry", { kind: "post_types" }, (d) => JSON.stringify(d).includes('"post"') ? null : "post type missing");
await expectOk("inspect_options", {});
await expectOk("inspect_database", {});
const cleanup = await expectOk("cleanup_options", { action: "delete_expired_transients" }, (d) => d.confirm_token ? null : "cleanup did not preview first");
await expectRefused("cleanup_options", { action: "delete_options", names: ["siteurl"] }, /protect|core|refus/i, "cleanup_options(siteurl)");
if (cleanup.json?.confirm_token) {
  await expectRefused("cleanup_options", { action: "delete_options", names: ["blogname"], confirm_token: cleanup.json.confirm_token }, /match|changed|refus|protect|core/i, "cleanup_options(token for other args)");
}

/* ────────────────────────── THEME DEVELOPMENT ────────────────────────── */
section("theme development");
await expectOk("diff_global_styles", {});
await expectOk("list_style_variations", {}, (d) => Array.isArray(d.variations) ? null : "no variations array");
await expectOk("list_block_patterns", { per_page: 3 });
await expectOk("validate_theme_json", {}, (d) => typeof d.valid === "boolean" ? null : "no valid flag");
await expectOk("check_accessibility", { url: "/" }, (d) => Array.isArray(d.issues) ? null : "no issues array");
await expectRefused("check_accessibility", { url: OFFSITE }, /site|elsewhere|only/i, "check_accessibility(off-site)");
await expectRefused("reset_template_customization", { id: "twentytwentyfive//index" }, /custom|theme|not/i, "reset_template_customization(theme-sourced)");

/* ────────────────────────── SEO, CONTENT, FLEET ────────────────────────── */
section("seo, content and fleet");
await expectOk("get_seo_meta", { url: "/" });
await expectOk("seo_site_check", {}, (d) => Array.isArray(d.checks) ? null : "no checks array");
await expectOk("check_links", { url: "/" });
await expectOk("internal_link_report", {});
await expectOk("content_inventory", { format: "csv" }, (_d, text) => /(^|\n)id,/.test(text) ? null : "CSV header missing");
await expectOk("content_calendar", {});
await expectOk("fleet_report", {}, (d) => Array.isArray(d.sites) && d.sites.length >= 1 ? null : "no sites in the fleet report");

/* ────────────────────────── OPERATING PLUGINS ────────────────────────── */
section("operating plugins as an administrator");
await expectOk("inspect_plugin", { plugin: "wpxmcp-helper" }, (d) => JSON.stringify(d).includes("wpxmcp/v1") ? null : "own routes not found");
await expectOk("list_admin_pages", {}, (d) => JSON.stringify(d).includes("options-general.php") ? null : "core Settings pages missing");
await expectOk("admin_page", { url_or_page: "options-general.php" }, (d) => (d.forms?.length ?? 0) >= 1 ? null : "no forms parsed on Settings → General");
await expectRefused("submit_admin_form", { page: "plugins.php", form_index: 0, changes: { x: "1" } }, /refus|plugin|dedicated/i, "submit_admin_form(plugins.php)");
await expectRefused("submit_admin_form", { page: "options-general.php", form_index: 0, changes: { siteurl: "https://evil.example" } }, /siteurl|protect|lock/i, "submit_admin_form(siteurl)");
await expectRefused("update_plugin_settings", { plugin: "wpxmcp-helper", option: "wpxmcp_snippets", value: [] }, /protect|own state|refus/i, "update_plugin_settings(wpxmcp_snippets)");

// A real round trip through options.php: preview, confirm, read back, restore.
const before = (await call("get_site_settings", {})).json?.settings?.description;
const marker = `Audit run4 ${Date.now()}`;
const preview = await expectOk("submit_admin_form", { page: "options-general.php", form_index: 0, changes: { blogdescription: marker } },
  (d) => d.confirm_token ? null : `no confirm_token — ${JSON.stringify(d).slice(0, 160)}`);
if (preview.json?.confirm_token) {
  await expectOk("submit_admin_form", { page: "options-general.php", form_index: 0, changes: { blogdescription: marker }, confirm_token: preview.json.confirm_token },
    (d) => (d.collateral_changes?.length ?? 0) === 0 ? null : `collateral changes: ${JSON.stringify(d.collateral_changes)}`);
  const after = (await call("get_site_settings", {})).json?.settings?.description;
  if (after !== marker) problems.push(`submit_admin_form: tagline reads "${after}", expected "${marker}"`);
  const replay = await call("submit_admin_form", { page: "options-general.php", form_index: 0, changes: { blogdescription: marker }, confirm_token: preview.json.confirm_token });
  if (/"submitted":\s*true/.test(replay.text)) problems.push("submit_admin_form accepted a spent confirm_token");
  if (before !== undefined) await call("update_site_settings", { description: before });
} else {
  notes.push("submit_admin_form round trip skipped: no preview token");
}

console.log(`\n${"═".repeat(60)}`);
console.log(`Covered here : ${R.covered.size}`);
console.log(`Problems     : ${problems.length}`);
problems.forEach((p) => console.log("  ✗ " + p));
if (notes.length) { console.log(`Notes        : ${notes.length}`); notes.forEach((n) => console.log("  · " + n)); }
await client.close();
process.exit(problems.length ? 1 : 0);
