import fs from "node:fs";
import { connect, makeRunner } from "./harness.mjs";

const client = await connect();
const R = makeRunner(client);
const { call, expectOk, expectRefused, problems, notes } = R;
const J = (r) => r.json ?? {};
const section = (s) => console.log(`\n━━ ${s}`);

/* ────────────────────────── SITES ────────────────────────── */
section("sites");
await expectOk("list_sites", {}, (d) => d.count === 1 ? null : `expected 1 site, got ${d.count}`);
await expectOk("get_site", {}, (d) => d.config?.id === "local" ? null : "missing config.id");
await expectOk("test_site", {}, (d) => {
  if (!Array.isArray(d.checks)) return "no checks array";
  const fails = d.checks.filter((c) => c.status === "fail");
  return fails.length ? `checks failing: ${fails.map((f) => f.check).join(", ")}` : null;
});
await expectOk("get_audit_log", { limit: 5 });

/* ────────────────────────── CONTENT ────────────────────────── */
section("content");
await expectOk("discover_content_types", { include_counts: true }, (d) =>
  d.types?.some((t) => t.type === "post") ? null : "post type missing");
await expectOk("list_content", { type: "post" }, (d) => Array.isArray(d.items) ? null : "no items array");
await expectOk("list_content", { type: "page", status: "any" });
await expectOk("list_content", { type: "post", full_content: true, per_page: 2 });
await expectOk("list_content", { type: "post", fields: ["id", "title"] });

const made = await expectOk("create_content", {
  type: "post", title: "Audit subject",
  content: "<!-- wp:paragraph --><p>Alpha <strong>ONE</strong> beta.</p><!-- /wp:paragraph -->",
});
const ID = J(made).id;
if (!ID) problems.push("create_content: no id returned");
if (J(made).status !== "draft") problems.push(`create_content: expected draft default, got ${J(made).status}`);

await expectOk("get_content", { id: ID }, (d) => d.content_is_blocks ? null : "block markup not detected");
await expectOk("get_content_summary", { id: ID }, (d) => d.content ? "summary leaked a body" : null);
await expectOk("update_content", { id: ID, edits: [{ find: "<strong>ONE</strong>", replace: "<strong>TWO</strong>" }] },
  (d) => d.edit_report?.applied?.[0]?.occurrences === 1 ? null : "edit not applied once");
await expectRefused("update_content", { id: ID, edits: [{ find: "ABSENT", replace: "x" }] }, /does not appear/, "update_content(miss)");
await expectRefused("update_content", { id: ID, content: "x", edits: [{ find: "a", replace: "b" }] }, /not both/, "update_content(both)");
await expectRefused("update_content", { id: ID }, /No changes/, "update_content(empty)");
await expectOk("get_content_by_slug", { slug: "pricing" }, (d) => d.match_count >= 1 ? null : "pricing page not found by slug");
await expectOk("find_content_by_url", { url: "http://127.0.0.1:8090/?page_id=5" }, (d) => d.found ? null : "did not resolve ?page_id=");
await expectOk("find_content_by_url", { url: "http://127.0.0.1:8090/?p=1" }, (d) => d.found ? null : "did not resolve ?p=");
await expectOk("find_content_by_url", { url: "http://127.0.0.1:8090/nope-does-not-exist/" }, (d) => d.found === false ? null : "claimed to find a missing URL");
await expectOk("find_content_by_url", { url: "http://127.0.0.1:8090/?p=" + ID, update: true, title: "Audit subject renamed" },
  (d) => d.updated ? null : "inline update did not apply");

/* ────────────────────────── TAXONOMY ────────────────────────── */
section("taxonomy");
await expectOk("discover_taxonomies", {}, (d) => d.taxonomies?.some((t) => t.taxonomy === "category") ? null : "category missing");
await expectOk("discover_taxonomies", { for_type: "post" });
await expectOk("list_terms", { taxonomy: "category" });
await expectOk("list_terms", { taxonomy: "post_tag" });
const term = await expectOk("create_term", { taxonomy: "post_tag", name: "audit-tag", description: "made by the audit" });
const TERM = J(term).id;
await expectOk("get_term", { taxonomy: "post_tag", id: TERM });
await expectOk("update_term", { taxonomy: "post_tag", id: TERM, description: "updated" },
  (d) => d.description === "updated" ? null : "description not updated");
await expectOk("assign_terms_to_content", { content_id: ID, taxonomy: "post_tag", terms: [TERM] },
  (d) => d.after?.includes(TERM) ? null : "term not assigned");
// Unique per run: a name reused from an earlier run is found, not created,
// which is correct behaviour but would fail a "was created" assertion.
const freshName = `audit-term-${Date.now()}`;
await expectOk("assign_terms_to_content", { content_id: ID, taxonomy: "post_tag", terms: [freshName] },
  (d) => d.created_terms?.length ? null : "a term given by an unused name should have been created");
await expectOk("assign_terms_to_content", { content_id: ID, taxonomy: "post_tag", terms: [TERM], mode: "remove" });
await expectOk("get_content_terms", { content_id: ID }, (d) => d.terms ? null : "no terms map");
await expectRefused("delete_term", { taxonomy: "post_tag", id: TERM }, /confirm/, "delete_term(no confirm)");
await expectOk("delete_term", { taxonomy: "post_tag", id: TERM, confirm: true }, (d) => d.deleted ? null : "term not deleted");
await expectRefused("list_terms", { taxonomy: "no_such_tax" }, /Unknown taxonomy/, "list_terms(bad tax)");

/* ────────────────────────── MEDIA ────────────────────────── */
section("media");
fs.writeFileSync("/tmp/wpx-audit.png", Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
const up = await expectOk("create_media", { file_path: "/tmp/wpx-audit.png", title: "Audit image", alt_text: "A single pixel" });
const MEDIA = J(up).id;
if (J(up).alt_text !== "A single pixel") problems.push("create_media: alt_text not stored");
await expectOk("get_media", { id: MEDIA });
await expectOk("list_media", {});
await expectOk("list_media", { missing_alt_text: true });
await expectOk("update_media", { id: MEDIA, caption: "Audited" }, (d) => d.caption === "Audited" ? null : "caption not saved");
await expectOk("edit_media", { id: MEDIA, description: "legacy alias" });
await expectOk("create_media", { base64_data: fs.readFileSync("/tmp/wpx-audit.png").toString("base64"), filename: "b64.png", alt_text: "from base64" });
await expectRefused("create_media", {}, /exactly one source/, "create_media(no source)");
await expectRefused("create_media", { file_path: "/nope/missing.png" }, /No file at/, "create_media(missing file)");
await expectRefused("create_media", { base64_data: "AAAA" }, /filename.*required/i, "create_media(no filename)");
await expectOk("audit_media", { limit: 50 }, (d) => typeof d.images_missing_alt === "number" ? null : "no alt-text count");
await expectRefused("delete_media", { id: MEDIA }, /confirm/, "delete_media(no confirm)");
await expectOk("delete_media", { id: MEDIA, confirm: true });
await expectRefused("search_stock_photos", { query: "x" }, /No stock photo provider/, "search_stock_photos(no key)");

/* ────────────────────────── USERS / COMMENTS ────────────────────────── */
section("users + comments");
await expectOk("list_users", {}, (d) => d.users?.length ? null : "no users");
await expectOk("get_user", { id: "me" }, (d) => d.roles?.includes("administrator") ? null : "not admin");
await expectOk("list_roles", {}, (d) => d.roles?.administrator ? null : "administrator role missing");
const user = await expectOk("create_user", { username: "audituser", email: "audit@example.com", password: "S3cure-pass-9182", roles: ["author"] });
const UID = J(user).id;
await expectOk("update_user", { id: UID, first_name: "Audit" });
await expectRefused("delete_user", { id: UID }, /confirm/, "delete_user(no confirm)");
await expectOk("delete_user", { id: UID, confirm: true, reassign_to: 1 });

// A dedicated, comments-open post: earlier audit phases close comments in bulk,
// and reusing post 1 made this section fail on a second run.
const host = await expectOk("create_content", { type: "post", title: "Comment host", content: "<p>Host.</p>", status: "publish", comment_status: "open" });
const HOST = J(host).id;
const cm = await expectOk("create_comment", { post: HOST, content: "Audit comment", author_name: "Auditor", author_email: "a@example.com", status: "approve" });
const CID = J(cm).id;
await expectOk("get_comment", { id: CID });
await expectOk("list_comments", { status: "approve" });
await expectOk("update_comment", { id: CID, content: "Audit comment edited" });
await expectOk("moderate_comments", { ids: [CID], action: "hold" }, (d) => d.succeeded === 1 ? null : "moderation failed");
await expectOk("delete_comment", { id: CID });
await call("delete_content", { id: HOST, force: true, confirm: true });

/* ────────────────────────── PLUGINS / THEMES ────────────────────────── */
section("plugins + themes");
await expectOk("list_plugins", {}, (d) => d.plugins?.length ? null : "no plugins");
await expectOk("list_plugins", { status: "active" });
await expectOk("get_plugin", { plugin: "akismet/akismet" }, (d) => d.plugin ? null : "no plugin field");
await expectOk("activate_plugin", { plugin: "hello.php" });
await expectOk("deactivate_plugin", { plugin: "hello.php" });
await expectRefused("delete_plugin", { plugin: "hello.php" }, /confirm/, "delete_plugin(no confirm)");
await expectOk("list_themes", {}, (d) => d.active_theme ? null : "no active theme");
await expectOk("get_theme", { stylesheet: "twentytwentyfive" });

/* ────────────────────────── APPEARANCE ────────────────────────── */
section("appearance");
const menu = await expectOk("create_menu", { name: "Audit Menu", description: "made by audit" });
const MENU = J(menu).id;
await expectOk("list_menus", {}, (d) => d.menus?.length ? null : "no menus");
const mi = await expectOk("add_menu_item", { menu_id: MENU, title: "Home", type: "custom", url: "http://127.0.0.1:8090/" });
const MI = J(mi).id;
const mi2 = await expectOk("add_menu_item", { menu_id: MENU, title: "Pricing", type: "post_type", object: "page", object_id: 5 });
await expectOk("get_menu", { id: MENU }, (d) => d.item_count === 2 ? null : `expected 2 items, got ${d.item_count}`);
await expectOk("update_menu_item", { id: MI, title: "Home renamed" });
await expectOk("reorder_menu_items", { items: [{ id: MI, menu_order: 2 }, { id: J(mi2).id, menu_order: 1 }] },
  (d) => d.failed === 0 ? null : "reorder had failures");
await expectOk("update_menu", { id: MENU, name: "Audit Menu 2" });
await expectRefused("add_menu_item", { menu_id: MENU, title: "Bad", type: "custom" }, /needs a `url`/, "add_menu_item(no url)");
await expectRefused("add_menu_item", { menu_id: MENU, title: "Bad", type: "post_type" }, /object_id/, "add_menu_item(no object_id)");
await expectOk("delete_menu_item", { id: MI });
await expectRefused("delete_menu", { id: MENU }, /confirm/, "delete_menu(no confirm)");
await expectOk("delete_menu", { id: MENU, confirm: true });

await expectOk("list_sidebars", {});
await expectOk("list_widgets", {});
await expectOk("list_block_types", { namespace: "core" }, (d) => d.count > 10 ? null : "suspiciously few block types");
await expectOk("list_reusable_blocks", {});
await expectOk("list_templates", { kind: "template" }, (d) => Array.isArray(d.items) ? null : "no items");
await expectOk("list_templates", { kind: "template_part" });
await expectOk("get_global_styles", {});
await expectOk("get_theme_mods", {});
await expectOk("set_theme_mod", { key: "wpx_audit", value: "yes" }, (d) => d.value === "yes" ? null : "theme mod not written");

/* ────────────────────────── SITE / INTELLIGENCE ────────────────────────── */
section("site + intelligence");
await expectOk("get_site_settings", {}, (d) => d.settings?.title ? null : "no site title");
await expectOk("update_site_settings", { description: "Audited tagline" }, (d) => d.changes?.length ? null : "no changes reported");
await expectOk("site_info", { include_health: true }, (d) => d.php?.version ? null : "no php version");
await expectOk("get_page_html", { url: "/?page_id=5", mode: "summary" }, (d) => d.status === 200 ? null : `status ${d.status}`);
await expectOk("get_page_html", { url: "/", mode: "head" });
await expectOk("get_page_html", { url: "/", mode: "text", max_chars: 500 });
await expectOk("search_site", { query: "pricing" });
await expectOk("list_revisions", { id: ID });
await expectOk("get_content_meta", { id: 5 });
await expectOk("set_content_meta", { id: ID, meta: { audit_key: "audit_value" } },
  (d) => d.written?.audit_key === "audit_value" ? null : "meta not written");
await expectOk("get_content_meta", { id: ID, include_protected: true },
  (d) => d.meta?.audit_key === "audit_value" ? null : "unregistered meta not read back");
await expectOk("rest_api", { route: "/wp/v2/posts", query: { per_page: 1 } });
await expectOk("discover_rest_routes", { search: "wpxmcp" }, (d) => d.route_count > 0 ? null : "companion routes not discoverable");

/* ────────────────────────── POWER ────────────────────────── */
section("power");
await expectOk("list_cli_commands", {}, (d) => d.count > 40 ? null : `only ${d.count} commands`);
await expectOk("run_wp_cli", { command: "core version" }, (d) => d.data?.version ? null : "no version");
await expectOk("run_wp_cli", { command: "option get blogname" });
await expectOk("run_wp_cli", { command: "post list --post_type=post" });
await expectOk("run_wp_cli", { command: "user list" });
await expectOk("run_wp_cli", { command: "theme mod list" });
await expectOk("run_wp_cli", { command: "cron event list" });
await expectOk("run_wp_cli", { command: "rewrite list" });
await expectOk("run_wp_cli", { command: "db tables" });
await expectOk("run_wp_cli", { command: "transient get doesnotexist" });
await expectOk("run_wp_cli", { command: "maintenance-mode status" });
await expectRefused("run_wp_cli", { command: "db drop --yes" }, /allowlist/, "cli(db drop)");
await expectRefused("run_wp_cli", { command: "eval phpinfo();" }, /WPX_ALLOW_EVAL|metacharacters/, "cli(eval)");
await expectRefused("run_wp_cli", { command: "option update siteurl http://evil" }, /protected/, "cli(protected option)");

await expectOk("execute_sql_query", { query: "SELECT ID FROM wp_posts LIMIT 3" }, (d) => Array.isArray(d.rows) ? null : "no rows");
await expectOk("execute_sql_query", { query: "SHOW TABLES" });
await expectRefused("execute_sql_query", { query: "DROP TABLE wp_posts" }, /allow_mutation/, "sql(drop)");
await expectRefused("execute_sql_query", { query: "SELECT 1; DELETE FROM wp_posts" }, /Multiple statements/, "sql(stacked)");
await expectRefused("execute_sql_query", { query: "UPDATE wp_posts SET post_title='x' WHERE ID=999999", allow_mutation: true },
  /confirm_token/, "sql(mutation preview)");

await expectOk("discover_abilities", {}, (d) => d.count === 3 ? null : `expected 3 core abilities, got ${d.count}`);
await expectOk("get_ability_info", { name: "core/get-site-info" }, (d) => d.input_schema ? null : "no input schema");
await expectOk("run_ability", { name: "core/get-site-info" }, (d) => d.method === "GET" ? null : `wrong method ${d.method}`);
await expectOk("run_ability", { name: "core/get-user-info" });
await expectRefused("run_ability", { name: "core/does-not-exist" }, /404|not.*found/i, "run_ability(missing)");

await expectOk("get_options", { names: ["blogname"] });
await expectOk("get_options", { search: "wpxmcp" });
await expectOk("set_option", { name: "wpx_audit_option", value: "hello" }, (d) => d.new_value === "hello" ? null : "option not written");
await expectRefused("set_option", { name: "siteurl", value: "http://evil" }, /protected/, "set_option(protected)");

await expectOk("register_fields", { group_key: "audit_group", title: "Audit", context: "post_meta", post_types: ["post"],
  fields: [{ key: "audit_text", label: "Text", type: "text" }, { key: "audit_color", label: "Color", type: "color" }] },
  (d) => d.field_count === 2 ? null : "wrong field count");
await expectOk("list_field_groups", {}, (d) => d.count >= 1 ? null : "group not listed");
await expectRefused("register_fields", { group_key: "bad", title: "Bad", context: "post_meta", fields: [{ key: "a", label: "A", type: "text" }] },
  /post_types.*required/i, "register_fields(no post_types)");
await expectRefused("delete_field_group", { group_key: "audit_group" }, /confirm/, "delete_field_group(no confirm)");
await expectOk("delete_field_group", { group_key: "audit_group", confirm: true });

await expectOk("code_snippet", { action: "create", title: "Audit snippet", language: "css", code: "body{}" },
  (d) => d.active === false ? null : "snippet was not created disabled");
await expectOk("code_snippet", { action: "list" });

/* ────────────────────────── THEMES: DRAFT WORKFLOW ────────────────────────── */
section("theme drafts");
const draft = await expectOk("create_draft_theme", {});
const DRAFT = J(draft).draft_stylesheet;
await expectOk("list_draft_themes", {}, (d) => d.count >= 1 ? null : "draft not listed");
await expectOk("list_theme_files", { theme: DRAFT }, (d) => d.file_count > 10 ? null : "too few files copied");
await expectOk("read_theme_file", { theme: DRAFT, path: "style.css" });
await expectOk("write_theme_file", { theme: DRAFT, path: "inc/audit.php", content: "<?php\n// audit\n" });
await expectOk("edit_theme_file", { theme: DRAFT, path: "inc/audit.php", edits: [{ find: "// audit", replace: "// audited" }] });
await expectRefused("write_theme_file", { theme: DRAFT, path: "bad.php", content: "<?php function ( {" }, /syntax error/, "write(bad php)");
await expectRefused("write_theme_file", { theme: DRAFT, path: "../../evil.php", content: "x" }, /traversal/, "write(traversal)");
await expectRefused("write_theme_file", { theme: DRAFT, path: "x.sh", content: "x" }, /not permitted/, "write(bad ext)");
await expectRefused("write_theme_file", { theme: "twentytwentyfive", path: "style.css", content: "x" }, /live theme/, "write(live theme)");
await expectOk("get_preview_url", { theme: DRAFT }, (d) => d.preview_url?.includes("wpxmcp_preview") ? null : "no token in URL");
await expectRefused("delete_theme_file", { theme: DRAFT, path: "inc/audit.php" }, /confirm/, "delete_theme_file(no confirm)");
await expectOk("delete_theme_file", { theme: DRAFT, path: "inc/audit.php", confirm: true });
await expectRefused("delete_draft_theme", { theme: DRAFT }, /confirm/, "delete_draft(no confirm)");
await expectOk("delete_draft_theme", { theme: DRAFT, confirm: true });
await expectRefused("publish_draft_theme", {}, /no theme drafts|confirm/i, "publish(no drafts)");

/* ────────────────────────── BULK + AUDIT ────────────────────────── */
section("bulk + audit");
await expectRefused("bulk_update_content", { type: "post", changes: { comment_status: "closed" }, limit: 5 },
  /confirm_token/, "bulk(dry run)");
await expectOk("audit_content", { type: "post", limit: 30 }, (d) => typeof d.examined === "number" ? null : "no examined count");
await expectRefused("bulk_update_content", { type: "post", limit: 5 }, /Nothing to do/, "bulk(no changes)");

/* ────────────────────────── SKILLS ────────────────────────── */
section("skills");
await expectOk("list_skills", {}, (d) => d.count >= 9 ? null : `expected at least 9 playbooks, got ${d.count}`);
await expectOk("load_skill", { query: "elementor page builder" }, (_, t) => /page builder/i.test(t) ? null : "wrong skill matched");
await expectOk("load_skill", { name: "gutenberg" });
await expectOk("load_skill", { query: "zzz nothing matches this at all" });
await expectOk("save_skill", { name: "audit-skill", title: "Audit", description: "test", content: "# body" });
await expectOk("load_skill", { name: "audit-skill" });
await expectOk("delete_skill", { name: "audit-skill" }, (d) => d.deleted ? null : "not deleted");

/* ────────────────────────── CLEANUP ────────────────────────── */
await call("delete_content", { id: ID, force: true, confirm: true });

/* ────────────────────────── REPORT ────────────────────────── */
const all = JSON.parse(fs.readFileSync("audit/all-tools.json", "utf8"));
const uncovered = all.filter((t) => !R.covered.has(t));
console.log(`\n${"═".repeat(60)}`);
console.log(`Tools covered : ${R.covered.size}/${all.length}`);
if (uncovered.length) console.log(`NOT COVERED   : ${uncovered.join(", ")}`);
console.log(`Problems      : ${problems.length}`);
problems.forEach((p) => console.log("  ✗ " + p));
if (notes.length) { console.log(`Notes         : ${notes.length}`); notes.forEach((n) => console.log("  · " + n)); }
await client.close();
process.exit(problems.length ? 1 : 0);
