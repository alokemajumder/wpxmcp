/**
 * Configuration comes from the environment so no credential is ever committed.
 *
 *   WPX_AUDIT_URL    the running worker            (default http://127.0.0.1:8802)
 *   WPX_AUTH_TOKEN   the worker's bearer token     (required)
 *   WPX_AUDIT_APPPW  the WordPress application password the worker is configured
 *                    with, used only to assert it never appears in any output
 */
const BASE = process.env.WPX_AUDIT_URL ?? "http://127.0.0.1:8802";
const TOKEN = process.env.WPX_AUTH_TOKEN;
const APP_PASSWORD = process.env.WPX_AUDIT_APPPW;

if (!TOKEN) {
  console.error("Set WPX_AUTH_TOKEN to the token this worker was started with. See audit/README.md.");
  process.exit(2);
}
const AUTH = `Bearer ${TOKEN}`;
const problems = [], notes = [];

async function rpc(method, params, { auth = AUTH } = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method, params }),
  });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text };
}
async function tool(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.body?.result?.content?.[0]?.text ?? r.text;
  let json = null;
  for (const c of [text, text.split("\n\n").slice(1).join("\n\n"), text.split("\n\n")[0]]) {
    if (!c) continue; try { json = JSON.parse(c.trim()); break; } catch {}
  }
  return { status: r.status, isError: !!r.body?.result?.isError, text, json };
}

console.log("━━ reachability");
const health = await fetch(`${BASE}/health`).then(r => r.json());
console.log("  health:", health.service, health.version, "| auth configured:", health.auth_configured);
if (!health.auth_configured) problems.push("health reports auth_configured false");

console.log("\n━━ the worker reaches the real WordPress");
const ts = await tool("test_site");
console.log("  test_site overall:", ts.json?.overall, "| checks:", ts.json?.checks?.length);
if (ts.json?.checks?.some(c => c.status === "fail")) problems.push("test_site has failing checks through the worker");

console.log("\n━━ confirm token across separate HTTP requests");
const args = { type: "post", changes: { comment_status: "closed" }, limit: 3 };
const dry = await tool("bulk_update_content", args);
const token = dry.json?.confirm_token;
if (!token) problems.push("no confirm_token from the worker dry run");
else {
  console.log("  request A issued:", token.slice(0, 30) + "…");
  const applied = await tool("bulk_update_content", { ...args, confirm_token: token });
  if (!applied.json?.applied) problems.push(`request B rejected the token → ${(applied.json?.reason ?? applied.text).slice(0, 140)}`);
  else console.log("  request B applied:", applied.json.succeeded, "succeeded — token survived across requests");
  const replay = await tool("bulk_update_content", { ...args, confirm_token: token });
  if (replay.json?.applied) problems.push("worker accepted a spent token");
  else console.log("  replay refused:", (replay.json?.reason ?? "").slice(0, 55));
}

console.log("\n━━ auth enforcement");
const noAuth = await rpc("tools/list", {}, { auth: null });
if (noAuth.status !== 401) problems.push(`missing auth returned ${noAuth.status}, expected 401`);
else console.log("  no token   → 401");
const badAuth = await rpc("tools/list", {}, { auth: "Bearer wrong-token" });
if (badAuth.status !== 401) problems.push(`wrong auth returned ${badAuth.status}, expected 401`);
else console.log("  bad token  → 401");
const nearMiss = await rpc("tools/list", {}, { auth: `Bearer ${TOKEN.slice(0, -1)}${TOKEN.endsWith("z") ? "y" : "z"}` });
if (nearMiss.status !== 401) problems.push("a near-miss token was accepted");
else console.log("  near miss  → 401");

console.log("\n━━ protocol conformance");
for (const [label, init, expect] of [
  ["GET /mcp", { method: "GET", headers: { Authorization: AUTH } }, 405],
  ["DELETE /mcp", { method: "DELETE", headers: { Authorization: AUTH } }, 204],
  ["OPTIONS /mcp", { method: "OPTIONS" }, 204],
  ["wrong content-type", { method: "POST", headers: { Authorization: AUTH, "Content-Type": "text/plain" }, body: "x" }, 415],
  ["bad json", { method: "POST", headers: { Authorization: AUTH, "Content-Type": "application/json" }, body: "{oops" }, 400],
  ["unknown path", { method: "POST", headers: { Authorization: AUTH, "Content-Type": "application/json" }, body: "{}" }, 404],
]) {
  const url = label === "unknown path" ? `${BASE}/nope` : `${BASE}/mcp`;
  const r = await fetch(url, init);
  if (r.status !== expect) problems.push(`${label}: got ${r.status}, expected ${expect}`);
  else console.log(`  ${label.padEnd(20)} → ${r.status}`);
}
const notif = await fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: AUTH, "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
if (notif.status !== 202) problems.push(`notification returned ${notif.status}, expected 202`);
else console.log("  notification         → 202");

console.log("\n━━ workers-only degradation is graceful");
const fp = await tool("create_media", { file_path: "/tmp/wpx-audit.png" });
if (!/running remotely|no shared filesystem/i.test(fp.text)) problems.push(`create_media(file_path) message unclear on workers → ${fp.text.slice(0, 140)}`);
else console.log("  create_media(file_path) explains there is no shared filesystem");
const sk = await tool("save_skill", { name: "x", title: "X", description: "d", content: "c" });
if (!/cannot save skills|no writable filesystem/i.test(sk.text)) problems.push("save_skill message unclear on workers");
else console.log("  save_skill explains the runtime cannot persist");

console.log("\n━━ credentials never leave the worker");
for (const t of ["list_sites", "get_site", "test_site", "site_info", "get_audit_log"]) {
  const r = await tool(t, {});
  if (APP_PASSWORD && r.text.includes(APP_PASSWORD)) problems.push(`${t} leaked the WordPress application password`);
  if (r.text.includes(TOKEN)) problems.push(`${t} leaked the worker auth token`);
}
console.log(APP_PASSWORD
  ? "  no application password or auth token in any output"
  : "  no auth token in any output (set WPX_AUDIT_APPPW to also check the WordPress password)");

console.log("\n━━ concurrency: 12 simultaneous tool calls");
const conc = await Promise.all(Array.from({ length: 12 }, (_, i) =>
  tool(i % 2 ? "list_content" : "list_terms", i % 2 ? { type: "post", per_page: 2 } : { taxonomy: "category" })));
const bad = conc.filter(r => r.isError || r.status !== 200);
if (bad.length) problems.push(`${bad.length}/12 concurrent calls failed`);
else console.log("  12/12 succeeded");

console.log("\n━━ tool parity with stdio");
const list = await rpc("tools/list", {});
const workerTools = (list.body?.result?.tools ?? []).map(t => t.name).sort();
const stdioTools = JSON.parse((await import("node:fs")).readFileSync("audit/all-tools.json", "utf8")).sort();
const missing = stdioTools.filter(t => !workerTools.includes(t));
const extra = workerTools.filter(t => !stdioTools.includes(t));
if (missing.length || extra.length) problems.push(`transport drift — missing: ${missing}, extra: ${extra}`);
else console.log(`  ${workerTools.length} tools, identical to stdio`);

console.log(`\n${"═".repeat(60)}\nProblems : ${problems.length}`);
problems.forEach(p => console.log("  ✗ " + p));
if (notes.length) { console.log(`Notes    : ${notes.length}`); notes.forEach(n => console.log("  · " + n)); }
process.exit(problems.length ? 1 : 0);
