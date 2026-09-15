import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devTools } from "../dist/tools/devtools.js";
import {
  normalizeOptionNames, cleanupFingerprint, previewHasChanges, explainMissingRoute,
  REGISTRY_KINDS, REGISTRY_HINTS, MAX_CLEANUP_NAMES,
} from "../dist/lib/devtools-core.js";

// Audit entries and the confirm secret go to a throwaway home, not ~/.wpxmcp.
process.env.WPX_HOME = mkdtempSync(join(tmpdir(), "wpxmcp-devtools-"));
const { installNodePlatform } = await import("../dist/platform-node.js");
installNodePlatform();

/* ----------------------------- helpers ----------------------------- */

test("option names are trimmed, de-duplicated, sorted and capped", () => {
  assert.deepEqual(normalizeOptionNames([" b ", "a", "b", "", "  "]), ["a", "b"]);
  assert.deepEqual(normalizeOptionNames(undefined), []);
  const many = Array.from({ length: MAX_CLEANUP_NAMES + 1 }, (_, i) => `opt_${i}`);
  assert.throws(() => normalizeOptionNames(many), /At most 200/);
});

test("cleanup fingerprint ignores name order but binds to the preview", () => {
  const preview = { changes: [{ name: "a", bytes: 10, autoload: "on" }, { name: "b", bytes: 5, autoload: "auto" }] };
  const reordered = { changes: [...preview.changes].reverse() };
  const fp = cleanupFingerprint("s", "set_autoload_off", ["a", "b"], preview);
  assert.equal(fp, cleanupFingerprint("s", "set_autoload_off", ["a", "b"], reordered));
  // The option grew, was re-autoloaded, or the action/site/names differ.
  assert.notEqual(fp, cleanupFingerprint("s", "set_autoload_off", ["a", "b"], { changes: [{ name: "a", bytes: 11, autoload: "on" }, preview.changes[1]] }));
  assert.notEqual(fp, cleanupFingerprint("s", "set_autoload_off", ["a", "b"], { changes: [{ name: "a", bytes: 10, autoload: "off" }, preview.changes[1]] }));
  assert.notEqual(fp, cleanupFingerprint("s", "delete_options", ["a", "b"], preview));
  assert.notEqual(fp, cleanupFingerprint("other", "set_autoload_off", ["a", "b"], preview));
  assert.notEqual(fp, cleanupFingerprint("s", "set_autoload_off", ["a"], preview));
});

test("expired-transient tokens bind to the rule, not the moving set of rows", () => {
  const a = cleanupFingerprint("s", "delete_expired_transients", [], { expired_count: 3, changes: [{ transient: "x" }] });
  const b = cleanupFingerprint("s", "delete_expired_transients", [], { expired_count: 9, changes: [{ transient: "y" }] });
  assert.equal(a, b);
});

test("previewHasChanges reads both preview shapes", () => {
  assert.equal(previewHasChanges("delete_expired_transients", { expired_count: 0, orphan_timeouts: 0 }), false);
  assert.equal(previewHasChanges("delete_expired_transients", { expired_count: 0, orphan_timeouts: 2 }), true);
  assert.equal(previewHasChanges("delete_options", { changes: [] }), false);
  assert.equal(previewHasChanges("delete_options", { changes: [{ name: "x" }] }), true);
  assert.equal(previewHasChanges("set_autoload_off", null), false);
});

test("a missing plugin route becomes an update-the-plugin message", () => {
  assert.throws(() => explainMissingRoute({ status: 404, code: "rest_no_route" }, "inspect_database"), /newer wpxmcp companion plugin/);
  const other = new Error("boom");
  assert.throws(() => explainMissingRoute(other, "x"), /boom/);
});

/* ----------------------------- tool specs ----------------------------- */

function fakeSite({ writable = true, helper = true } = {}) {
  const calls = [];
  const options = {
    big_option: { bytes: 900000, autoload: "on" },
    small_option: { bytes: 10, autoload: "auto" },
  };
  const client = {
    site: { id: "fake", writable },
    assertWritable(action) {
      if (!writable) throw new Error(`Site "fake" is configured read-only (writable: false), so "${action}" was refused.`);
    },
    async hasHelperPlugin() { return helper; },
    async get(route, query) {
      calls.push({ method: "GET", route, query });
      return { data: { route } };
    },
    async post(route, body) {
      calls.push({ method: "POST", route, body: structuredClone(body) });
      if (body.action === "delete_expired_transients") {
        return { data: { action: body.action, dry_run: body.dry_run, expired_count: 2, orphan_timeouts: 0, bytes_saved: 42, changes: [] } };
      }
      const changes = body.names.filter((n) => options[n]).map((n) => ({ name: n, ...options[n] }));
      const skipped = body.names.filter((n) => !options[n]).map((n) => ({ name: n, reason: "no such option" }));
      if (!body.dry_run && body.action === "set_autoload_off") for (const c of changes) options[c.name].autoload = "off";
      return { data: { action: body.action, dry_run: body.dry_run, changes, skipped, refused: [], bytes_saved: changes.reduce((s, c) => s + c.bytes, 0) } };
    },
  };
  const tools = devTools({ registry: { resolve: () => client } });
  const tool = (name) => tools.find((t) => t.name === name);
  return { client, calls, options, tool };
}

function payload(result) {
  const text = result.content[0].text;
  const at = text.indexOf("{");
  return JSON.parse(text.slice(at));
}

test("devtools registers four tools with described params and honest annotations", () => {
  const { tool } = fakeSite();
  const expected = {
    inspect_registry: { readOnly: true },
    inspect_options: { readOnly: true },
    inspect_database: { readOnly: true },
    cleanup_options: { destructive: true },
  };
  for (const [name, flags] of Object.entries(expected)) {
    const t = tool(name);
    assert.ok(t, `${name} missing`);
    assert.ok(t.description.length > 40, `${name} description too short`);
    assert.equal(Boolean(t.readOnly), Boolean(flags.readOnly), `${name} readOnly`);
    assert.equal(Boolean(t.destructive), Boolean(flags.destructive), `${name} destructive`);
    for (const [key, schema] of Object.entries(t.schema)) {
      assert.ok(schema.description, `${name}.${key} has no .describe()`);
    }
  }
  for (const kind of REGISTRY_KINDS) assert.ok(REGISTRY_HINTS[kind], `no hint for ${kind}`);
});

test("inspect_registry passes kind, filter and limit to the plugin route", async () => {
  const { tool, calls } = fakeSite();
  await tool("inspect_registry").handler({ kind: "hooks", filter: "the_content", limit: 10 });
  assert.equal(calls[0].route, "/wpxmcp/v1/registry");
  assert.deepEqual(calls[0].query, { kind: "hooks", filter: "the_content", limit: 10 });
});

test("inspect tools explain a missing companion plugin", async () => {
  const { tool } = fakeSite({ helper: false });
  await assert.rejects(tool("inspect_database").handler({}), /companion plugin/);
});

test("cleanup_options previews first, then applies only with the matching token", async () => {
  const { tool, calls, options } = fakeSite();
  const cleanup = tool("cleanup_options").handler;

  const preview = payload(await cleanup({ action: "set_autoload_off", names: ["big_option", "missing_one"] }));
  assert.equal(preview.dry_run, true);
  assert.equal(preview.applied, false);
  assert.match(preview.confirm_token, /^confirm\./);
  assert.equal(options.big_option.autoload, "on", "a preview must not change anything");
  assert.ok(calls.every((c) => c.body?.dry_run !== false), "only dry runs so far");

  // A token cannot be spent on different names.
  const wrong = payload(await cleanup({ action: "set_autoload_off", names: ["small_option"], confirm_token: preview.confirm_token }));
  assert.equal(wrong.applied, false);
  assert.equal(wrong.refused, true);
  assert.equal(options.small_option.autoload, "auto");

  // Same names in a different order are the same operation.
  const applied = payload(await cleanup({ action: "set_autoload_off", names: ["missing_one", "big_option"], confirm_token: preview.confirm_token }));
  assert.equal(applied.applied, true);
  assert.equal(options.big_option.autoload, "off");
  const applyCall = calls.find((c) => c.body?.dry_run === false);
  assert.deepEqual(applyCall.body.names, ["big_option"], "apply sends only what the preview listed");
});

test("cleanup_options rejects a token once the preview has changed", async () => {
  const { tool, options } = fakeSite();
  const cleanup = tool("cleanup_options").handler;
  const preview = payload(await cleanup({ action: "delete_options", names: ["big_option"] }));
  options.big_option.bytes = 1200000; // grew between preview and confirm
  const res = payload(await cleanup({ action: "delete_options", names: ["big_option"], confirm_token: preview.confirm_token }));
  assert.equal(res.applied, false);
  assert.match(res.reason, /arguments changed/);
});

test("cleanup_options refuses protected options without calling the site", async () => {
  const { tool, calls } = fakeSite();
  const res = payload(await tool("cleanup_options").handler({ action: "delete_options", names: ["siteurl", "wpxmcp_snippets", "wp_user_roles"] }));
  assert.equal(res.applied, false);
  assert.equal(res.refused.length, 3);
  assert.equal(calls.length, 0);
});

test("cleanup_options respects read-only sites and requires names", async () => {
  await assert.rejects(fakeSite({ writable: false }).tool("cleanup_options").handler({ action: "delete_expired_transients" }), /read-only/);
  await assert.rejects(fakeSite().tool("cleanup_options").handler({ action: "delete_options", names: [] }), /names/);
});

test("delete_expired_transients runs the same preview → token → apply flow", async () => {
  const { tool, calls } = fakeSite();
  const cleanup = tool("cleanup_options").handler;
  const preview = payload(await cleanup({ action: "delete_expired_transients" }));
  assert.ok(preview.confirm_token);
  const applied = payload(await cleanup({ action: "delete_expired_transients", confirm_token: preview.confirm_token }));
  assert.equal(applied.applied, true);
  assert.equal(calls.filter((c) => c.body?.dry_run === false).length, 1);
  // A spent token cannot be replayed.
  const replay = payload(await cleanup({ action: "delete_expired_transients", confirm_token: preview.confirm_token }));
  assert.equal(replay.applied, false);
  assert.match(replay.reason, /already been used/);
});
