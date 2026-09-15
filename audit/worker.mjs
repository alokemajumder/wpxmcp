/**
 * Configuration comes from the environment so no credential is ever committed.
 *
 *   WPX_AUDIT_URL    the running worker            (default http://127.0.0.1:8802)
 *   WPX_AUTH_TOKEN   the worker's bearer token     (required)
 *   WPX_AUDIT_APPPW  the WordPress application password the worker is configured
 *                    with, used only to assert it never appears in any output
 *   SP               the scratch directory holding sites.json, for the stdio parity check
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { connect as connectStdio } from "./harness.mjs";

const BASE = process.env.WPX_AUDIT_URL ?? "http://127.0.0.1:8802";
const TOKEN = process.env.WPX_AUTH_TOKEN;
const APP_PASSWORD = process.env.WPX_AUDIT_APPPW;

if (!TOKEN) {
  console.error("Set WPX_AUTH_TOKEN to the token this worker was started with. See audit/README.md.");
  process.exit(2);
}
const AUTH = `Bearer ${TOKEN}`;
const problems = [], notes = [];

async function connectHttp(mode) {
  const client = new Client({ name: "worker-audit", version: "1" }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: AUTH } },
  }));
  return client;
}

function parseToolText(text) {
  for (const c of [text, text.split("\n\n").slice(1).join("\n\n"), text.split("\n\n")[0]]) {
    if (!c) continue; try { return JSON.parse(c.trim()); } catch {}
  }
  return null;
}

async function tool(client, name, args = {}) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    return { isError: !!r.isError, text, json: parseToolText(text) };
  } catch (e) {
    return { isError: true, text: String(e?.message ?? e), json: null };
  }
}

async function raw(init, path = "/mcp") {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, text: await res.text() };
}

console.log("━━ reachability");
const health = await fetch(`${BASE}/health`).then((r) => r.json());
console.log("  health:", health.service, health.version, "| auth configured:", health.auth_configured);
if (!health.auth_configured) problems.push("health reports auth_configured false");

const modern = await connectHttp({ pin: "2026-07-28" });
const legacy = await connectHttp("legacy");
console.log("  2026-07-28 client era:", modern.getProtocolEra(), "| legacy client era:", legacy.getProtocolEra());
if (modern.getProtocolEra() !== "modern") problems.push("the worker did not serve the 2026-07-28 revision");

console.log("\n━━ the worker reaches the real WordPress, on both protocol eras");
for (const [label, client] of [["2026-07-28", modern], ["2025-era", legacy]]) {
  const ts = await tool(client, "test_site");
  console.log(`  ${label}: test_site overall ${ts.json?.overall} | checks ${ts.json?.checks?.length}`);
  if (!ts.json?.checks) problems.push(`${label}: test_site returned no checks → ${ts.text.slice(0, 140)}`);
  if (ts.json?.checks?.some((c) => c.status === "fail")) problems.push(`${label}: test_site has failing checks through the worker`);
}

console.log("\n━━ confirm token across separate HTTP requests and eras");
const args = { type: "post", changes: { comment_status: "closed" }, limit: 3 };
const dry = await tool(modern, "bulk_update_content", args);
const token = dry.json?.confirm_token;
if (!token) problems.push("no confirm_token from the worker dry run");
else {
  console.log("  issued on a 2026-07-28 request:", token.slice(0, 30) + "…");
  const applied = await tool(legacy, "bulk_update_content", { ...args, confirm_token: token });
  if (!applied.json?.applied) problems.push(`the 2025-era request rejected the token → ${(applied.json?.reason ?? applied.text).slice(0, 140)}`);
  else console.log("  applied on a 2025-era request:", applied.json.succeeded, "succeeded");
  const replay = await tool(modern, "bulk_update_content", { ...args, confirm_token: token });
  if (replay.json?.applied) notes.push("a spent token was accepted again — expected only when requests land on different isolates");
  else console.log("  replay refused:", (replay.json?.reason ?? "").slice(0, 55));
}

console.log("\n━━ auth enforcement");
const listBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const jsonPost = (auth) => ({ method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(auth ? { Authorization: auth } : {}) }, body: listBody });
for (const [label, auth] of [["no token", null], ["bad token", "Bearer wrong-token"], ["near miss", `Bearer ${TOKEN.slice(0, -1)}${TOKEN.endsWith("z") ? "y" : "z"}`]]) {
  const r = await raw(jsonPost(auth));
  if (r.status !== 401) problems.push(`${label} returned ${r.status}, expected 401`);
  else console.log(`  ${label.padEnd(10)} → 401`);
}

console.log("\n━━ protocol conformance");
for (const [label, init, expect, path] of [
  ["GET /mcp", { method: "GET", headers: { Authorization: AUTH, Accept: "text/event-stream" } }, 405],
  ["OPTIONS /mcp", { method: "OPTIONS" }, 204],
  ["wrong content-type", { method: "POST", headers: { Authorization: AUTH, "Content-Type": "text/plain" }, body: "x" }, 415],
  ["unknown path", { method: "POST", headers: { Authorization: AUTH, "Content-Type": "application/json" }, body: "{}" }, 404, "/nope"],
]) {
  const r = await raw(init, path);
  if (r.status !== expect) problems.push(`${label}: got ${r.status}, expected ${expect}`);
  else console.log(`  ${label.padEnd(20)} → ${r.status}`);
}
const bad = await raw({ method: "POST", headers: { Authorization: AUTH, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{oops" });
if (bad.status < 400 || bad.status >= 500) problems.push(`bad json: got ${bad.status}, expected a 4xx`);
else console.log(`  ${"bad json".padEnd(20)} → ${bad.status}`);

console.log("\n━━ workers-only degradation is graceful");
const fp = await tool(modern, "create_media", { file_path: "/tmp/wpx-audit.png" });
if (!/running remotely|no shared filesystem/i.test(fp.text)) problems.push(`create_media(file_path) message unclear on workers → ${fp.text.slice(0, 140)}`);
else console.log("  create_media(file_path) explains there is no shared filesystem");
const sk = await tool(modern, "save_skill", { name: "x", title: "X", description: "d", content: "c" });
if (!/cannot save skills|no writable filesystem/i.test(sk.text)) problems.push("save_skill message unclear on workers");
else console.log("  save_skill explains the runtime cannot persist");

console.log("\n━━ credentials never leave the worker");
for (const t of ["list_sites", "get_site", "test_site", "site_info", "get_audit_log", "security_audit"]) {
  const r = await tool(modern, t, {});
  if (APP_PASSWORD && r.text.includes(APP_PASSWORD)) problems.push(`${t} leaked the WordPress application password`);
  if (r.text.includes(TOKEN)) problems.push(`${t} leaked the worker auth token`);
}
console.log(APP_PASSWORD
  ? "  no application password or auth token in any output"
  : "  no auth token in any output (set WPX_AUDIT_APPPW to also check the WordPress password)");

console.log("\n━━ concurrency: 12 simultaneous tool calls");
const conc = await Promise.all(Array.from({ length: 12 }, (_, i) =>
  tool(i % 2 ? modern : legacy, i % 2 ? "list_content" : "list_terms", i % 2 ? { type: "post", per_page: 2 } : { taxonomy: "category" })));
const failed = conc.filter((r) => r.isError);
if (failed.length) problems.push(`${failed.length}/12 concurrent calls failed → ${failed[0].text.slice(0, 120)}`);
else console.log("  12/12 succeeded");

console.log("\n━━ tool parity with stdio");
const workerTools = (await modern.listTools()).tools.map((t) => t.name).sort();
if (process.env.SP) {
  const stdio = await connectStdio();
  const stdioTools = (await stdio.listTools()).tools.map((t) => t.name).sort();
  await stdio.close();
  // Two tools are deliberately local-only in behaviour but registered on both, so the lists must match exactly.
  const missing = stdioTools.filter((t) => !workerTools.includes(t));
  const extra = workerTools.filter((t) => !stdioTools.includes(t));
  if (missing.length || extra.length) problems.push(`transport drift — missing: ${missing}, extra: ${extra}`);
  else console.log(`  ${workerTools.length} tools, identical to stdio`);
} else {
  notes.push("SP not set, so the stdio parity check was skipped");
}

await modern.close();
await legacy.close();

console.log(`\n${"═".repeat(60)}\nProblems : ${problems.length}`);
problems.forEach((p) => console.log("  ✗ " + p));
if (notes.length) { console.log(`Notes    : ${notes.length}`); notes.forEach((n) => console.log("  · " + n)); }
process.exit(problems.length ? 1 : 0);
