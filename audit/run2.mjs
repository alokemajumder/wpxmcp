import { connect, makeRunner } from "./harness.mjs";
const client = await connect();
const R = makeRunner(client);
const { call, expectOk, expectRefused, problems, notes } = R;
const J = (r) => r.json ?? {};
const section = (s) => console.log(`\n━━ ${s}`);

/* ── widgets: the block-widget path most people actually use ── */
section("widgets");
const sidebars = J(await expectOk("list_sidebars", {}));
const sid = sidebars.sidebars?.find((s) => s.id !== "wp_inactive_widgets")?.id;
if (!sid) {
  notes.push("no active sidebar on this block theme — widget CRUD exercised against wp_inactive_widgets");
}
const target = sid ?? "wp_inactive_widgets";
const w = await expectOk("create_widget", {
  sidebar: target, id_base: "block",
  instance: { content: "<!-- wp:paragraph --><p>Audit widget</p><!-- /wp:paragraph -->" },
}, (d) => d.id ? null : "no widget id returned");
const WID = J(w).id;
if (WID) {
  const placed = J(w).sidebar;                       // where WordPress actually put it
  if (placed !== target) notes.push(`widget relocated ${target} → ${placed}; create_widget reported it`);
  await expectOk("list_widgets", { sidebar: placed }, (d) => d.widgets?.some((x) => x.id === WID) ? null : "created widget not listed in the sidebar it actually landed in");
  await expectOk("update_widget", { id: WID, instance: { content: "<!-- wp:paragraph --><p>Audit widget v2</p><!-- /wp:paragraph -->" } },
    (d) => /v2/.test(JSON.stringify(d.instance_settings ?? {})) ? null : "widget instance not updated");
  await expectOk("delete_widget", { id: WID, force: true });
}

/* ── block templates ── */
section("templates");
const tpls = J(await expectOk("list_templates", { kind: "template" }));
const tid = tpls.items?.find((t) => t.slug === "index" || t.slug === "single")?.id ?? tpls.items?.[0]?.id;
if (!tid) problems.push("list_templates returned no templates on a block theme");
else {
  const got = await expectOk("get_template", { id: tid }, (d) => d.content !== undefined ? null : "no content");
  const original = J(got).content ?? "";
  await expectOk("update_template", { id: tid, content: original + "\n<!-- wp:html --><!-- audit --><!-- /wp:html -->" },
    (d) => d.updated ? null : "template not updated");
  // Put it back so the site is unchanged by the audit.
  await expectOk("update_template", { id: tid, content: original });
}

/* ── global styles (block theme) ── */
section("global styles");
const gs = J(await expectOk("get_global_styles", {}));
if (gs.is_block_theme) {
  await expectOk("update_global_styles", { styles: { ...(gs.styles ?? {}), color: { ...(gs.styles?.color ?? {}), background: "#fefefe" } } },
    (d) => d.updated ? null : "global styles not updated");
  await expectOk("update_global_styles", { styles: gs.styles ?? {} });   // restore
  await expectRefused("update_global_styles", {}, /Provide/, "update_global_styles(empty)");
} else notes.push("active theme is not a block theme — update_global_styles not exercised");

/* ── revisions ── */
section("revisions");
const post = await expectOk("create_content", { type: "post", title: "Revision subject", content: "<p>Version one.</p>" });
const RID = J(post).id;
await expectOk("update_content", { id: RID, content: "<p>Version two.</p>" });
const revs = J(await expectOk("list_revisions", { id: RID }));
if (!revs.revisions?.length) {
  notes.push("no revisions stored (WP only creates them past a threshold) — restore_revision not exercised");
  await call("restore_revision", { id: RID, revision_id: 0 });
} else {
  await expectOk("restore_revision", { id: RID, revision_id: revs.revisions.at(-1).id },
    (d) => d.restored ? null : "restore failed");
}
await call("delete_content", { id: RID, force: true, confirm: true });

/* ── classic theme scaffold, then publish + rollback ── */
section("classic theme scaffold");
const scaffold = await expectOk("create_classic_theme", {
  name: "Audit Theme", slug: "audit-theme",
  tokens: { primary: "#ff0000", font_sans: "Inter, sans-serif", radius: "1rem" },
}, (d) => d.files_written?.length >= 15 ? null : `only ${d.files_written?.length} files written`);
const SLUG = J(scaffold).slug;
await expectOk("read_theme_file", { theme: SLUG, path: "theme.css" }, (_, t) =>
  /#ff0000/.test(t) ? null : "design token not written into theme.css");
await expectOk("read_theme_file", { theme: SLUG, path: "functions.php" }, (_, t) =>
  /audit_theme_setup/.test(t) ? null : "functions.php not prefixed with the theme slug");
await expectOk("list_theme_files", { theme: SLUG }, (d) =>
  d.files?.some((f) => f.path === "template-parts/card.php") ? null : "template-parts missing");

section("theme activation + rollback");
const before = J(await expectOk("list_themes", {})).active_theme;
await expectRefused("activate_theme", { stylesheet: SLUG }, /confirm/, "activate_theme(no confirm)");
await expectOk("activate_theme", { stylesheet: SLUG, confirm: true }, (d) => d.activated ? null : "not activated");
const now = J(await expectOk("list_themes", {})).active_theme;
if (now !== SLUG) problems.push(`activate_theme: active theme is ${now}, expected ${SLUG}`);
// The scaffolded theme must actually render, not white-screen.
const html = await fetch("http://127.0.0.1:8090/").then((r) => r.text()).catch(() => "");
if (!/Audit Theme|<section|wp-block|<body/i.test(html) || /Fatal error/i.test(html)) {
  problems.push(`scaffolded theme did not render cleanly: ${html.slice(0, 200).replace(/\s+/g, " ")}`);
} else console.log("  scaffolded theme renders, bytes:", html.length);
await expectOk("activate_theme", { stylesheet: before, confirm: true });

/* ── network-dependent tools: must degrade cleanly ── */
section("network-dependent (api.wordpress.org blocked here)");
for (const [n, a] of [
  ["search_plugins", { search: "seo", per_page: 2 }],
  ["get_plugin_info", { slug: "classic-editor" }],
  ["install_plugin", { slug: "classic-editor" }],
  ["create_plugin", { slug: "classic-editor" }],
  ["install_theme", { slug: "twentytwentyfour" }],
]) {
  const r = await call(n, a);
  if (!r.error) { console.log(`  ${n}: unexpectedly succeeded (network available)`); continue; }
  if (/stack|undefined is not|cannot read/i.test(r.text)) problems.push(`${n}: leaked a raw JS error → ${r.text.slice(0, 140)}`);
  else console.log(`  ${n}: fails cleanly → ${r.text.slice(0, 90).replace(/\s+/g, " ")}`);
}

const all = JSON.parse((await import("node:fs")).readFileSync("audit/all-tools.json", "utf8"));
console.log(`\n${"═".repeat(60)}`);
console.log(`Covered here : ${R.covered.size}`);
console.log(`Problems     : ${problems.length}`);
problems.forEach((p) => console.log("  ✗ " + p));
if (notes.length) { console.log(`Notes        : ${notes.length}`); notes.forEach((n) => console.log("  · " + n)); }
await client.close();
process.exit(problems.length ? 1 : 0);
