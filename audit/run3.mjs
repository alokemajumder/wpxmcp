import { connect, makeRunner } from "./harness.mjs";
const client = await connect();
const R = makeRunner(client);
const { call, expectOk, problems, notes } = R;
const J = (r) => r.json ?? {};
const section = (s) => console.log(`\n━━ ${s}`);

/* ── the whole dry-run → confirm → apply cycle, which was never tested ── */
section("bulk: dry-run → confirm → apply");
const ids = [];
for (let i = 0; i < 3; i++) {
  const r = await call("create_content", { type: "post", title: `Bulk subject ${i}`, content: `<p>Body ${i} with TOKEN here.</p>` });
  ids.push(J(r).id);
}
const args = { type: "post", filter: { ids }, changes: { status: "publish" } };

const dry = await call("bulk_update_content", args);
const token = J(dry).confirm_token;
if (!token) problems.push("bulk dry-run returned no confirm_token");
if (J(dry).applied !== false) problems.push("bulk dry-run reported applied:true");
console.log("  dry-run:", J(dry).would_update, "would change; token:", token?.slice(0, 24) + "…");

const applied = await call("bulk_update_content", { ...args, confirm_token: token });
if (!J(applied).applied) problems.push(`bulk confirm did not apply → ${applied.text.slice(0, 200)}`);
else console.log("  applied:", J(applied).succeeded, "succeeded,", J(applied).failed, "failed");

// The status must actually be publish on the site now.
for (const id of ids) {
  const got = await call("get_content_summary", { id });
  if (J(got).status !== "publish") problems.push(`post ${id} status is ${J(got).status}, expected publish after the confirmed bulk update`);
}

// Replay must be refused.
const replay = await call("bulk_update_content", { ...args, confirm_token: token });
if (J(replay).applied) problems.push("a spent confirm_token was accepted a second time");
else console.log("  replay refused:", (J(replay).reason ?? "").slice(0, 60));

// A token must not carry over to different arguments.
const dry2 = await call("bulk_update_content", { ...args, changes: { status: "draft" } });
const t2 = J(dry2).confirm_token;
const wrong = await call("bulk_update_content", { ...args, changes: { comment_status: "closed" }, confirm_token: t2 });
if (J(wrong).applied) problems.push("a confirm_token was accepted for different arguments");
else console.log("  argument drift refused:", (J(wrong).reason ?? "").slice(0, 60));

/* ── content_edits across a batch ── */
section("bulk: content edits");
const dry3 = await call("bulk_update_content", { type: "post", filter: { ids }, content_edits: [{ find: "TOKEN", replace: "REPLACED" }] });
const applied3 = await call("bulk_update_content", {
  type: "post", filter: { ids }, content_edits: [{ find: "TOKEN", replace: "REPLACED" }], confirm_token: J(dry3).confirm_token,
});
if (!J(applied3).applied) problems.push("bulk content_edits did not apply");
const check = await call("get_content", { id: ids[0] });
if (!/REPLACED/.test(check.text)) problems.push("bulk content edit did not reach the stored content");
else console.log("  content edits applied to all three");

/* ── SQL mutation: preview → confirm → execute ── */
section("sql: preview → confirm → execute");
const sql = { query: `UPDATE wp_posts SET post_title='SQL renamed' WHERE ID=${ids[0]}`, allow_mutation: true };
const prev = await call("execute_sql_query", sql);
const sqlToken = J(prev).confirm_token;
if (!sqlToken) problems.push("mutating SQL preview returned no confirm_token");
const ran = await call("execute_sql_query", { ...sql, confirm_token: sqlToken });
if (!J(ran).ran) problems.push(`confirmed SQL did not execute → ${ran.text.slice(0, 200)}`);
else console.log("  rows affected:", J(ran).rows_affected);
const renamed = await call("get_content_summary", { id: ids[0] });
if (J(renamed).title !== "SQL renamed") notes.push(`SQL title now "${J(renamed).title}" (object cache may be serving a stale row, which the tool warns about)`);
else console.log("  title changed on the site");

/* ── search-replace: forced dry run, then confirm ── */
section("wp-cli search-replace");
const sr = await call("run_wp_cli", { command: "search-replace REPLACED SWAPPED" });
if (J(sr).ran !== false) problems.push("search-replace ran without a dry run first");
const srToken = J(sr).confirm_token;
console.log("  dry-run rows:", J(sr).preview?.data?.rows_affected ?? J(sr).preview?.rows_affected);
const srRun = await call("run_wp_cli", { command: "search-replace REPLACED SWAPPED", confirm_token: srToken });
if (!J(srRun).ran) problems.push(`confirmed search-replace did not run → ${srRun.text.slice(0, 200)}`);
else console.log("  applied:", (J(srRun).stdout ?? "").slice(0, 80).replace(/\s+/g, " "));

/* ── delete: trash then permanent ── */
section("delete lifecycle");
const del1 = await call("delete_content", { id: ids[1] });
if (!J(del1).deleted || J(del1).permanent) problems.push("plain delete should trash, not destroy");
const restored = await call("update_content", { id: ids[1], status: "draft" });
if (J(restored).updated !== true) problems.push("could not restore from trash by setting status");
else console.log("  trashed then restored from trash");
const del2 = await call("delete_content", { id: ids[1], force: true, confirm: true });
if (!J(del2).permanent) problems.push("force+confirm did not delete permanently");
const gone = await call("get_content", { id: ids[1] });
if (!gone.error) problems.push("permanently deleted content is still readable");
else console.log("  permanent delete confirmed");

for (const id of [ids[0], ids[2]]) await call("delete_content", { id, force: true, confirm: true });

console.log(`\n${"═".repeat(60)}`);
console.log(`Problems : ${problems.length}`);
problems.forEach((p) => console.log("  ✗ " + p));
if (notes.length) { console.log(`Notes    : ${notes.length}`); notes.forEach((n) => console.log("  · " + n)); }
await client.close();
process.exit(problems.length ? 1 : 0);
