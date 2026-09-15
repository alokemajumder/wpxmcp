import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { buildToolset } from "../dist/toolset.js";
import { SiteRegistry } from "../dist/lib/registry.js";
import { installNodePlatform } from "../dist/platform-node.js";
import { listSkills } from "../dist/lib/skills.js";
import { inspectCliCommand } from "../dist/lib/safety.js";

installNodePlatform();
const tools = new Map(buildToolset({ registry: new SiteRegistry({ sites: [], source: "test" }) }).map((t) => [t.name, t]));
const skillFiles = readdirSync(new URL("../skills/", import.meta.url)).filter((f) => f.endsWith(".md"));
const read = (f) => readFileSync(new URL(`../skills/${f}`, import.meta.url), "utf8");
const skillNames = new Set(skillFiles.map((f) => f.replace(/\.md$/, "")));

/**
 * Backticked names shaped like one of our tools. A playbook that tells the model
 * to call a tool that does not exist wastes a turn at best and invents an
 * operation at worst, so any such name must be a real tool — or a WordPress
 * identifier listed here.
 */
const TOOL_SHAPED = /^(get|list|create|update|delete|find|run|execute|search|test|load|save|audit|check|inspect|profile|purge|tail|diff|validate|apply|reset|set|add|remove|install|activate|deactivate|publish|upload|moderate|bulk|discover|assign|restore|edit|write|read|register|reorder|scaffold|fleet|security|backup|cleanup|seo|internal|content|code)_[a-z0-9_]+$/;
const WORDPRESS_IDENTIFIERS = new Set([
  "get_option", "update_option", "delete_option", "get_post_meta", "update_post_meta", "delete_post_meta",
  "get_theme_mod", "set_theme_mod", "get_field", "update_field", "register_post_type", "register_taxonomy",
  "register_meta", "register_post_meta", "register_block_type", "register_rest_route", "register_setting",
  "get_template_part", "get_header", "get_footer", "get_sidebar", "add_action", "add_filter", "remove_action",
  "remove_filter", "add_theme_support", "register_nav_menus", "register_sidebar", "get_block_templates",
  "get_the_title", "get_permalink", "get_stylesheet_directory_uri", "get_template_directory_uri",
  "delete_transient", "get_transient", "set_transient", "add_image_size", "content_width", "edit_posts",
  "edit_theme_options", "edit_themes", "install_plugins", "activate_plugins", "update_plugins", "delete_plugins",
  "install_themes", "update_themes", "list_users", "create_users", "delete_users", "edit_users", "read_private_posts",
  "search_replace", "update_core", "get_site_transient", "set_site_transient",
]);

/** Strips optional/default/nullable wrappers from a zod 4 schema. */
function unwrap(schema) {
  let current = schema;
  for (let depth = 0; current?._zod?.def && depth < 8; depth++) {
    const def = current._zod.def;
    if (["optional", "default", "nullable", "prefault", "readonly"].includes(def.type)) current = def.innerType;
    else break;
  }
  return current;
}

function paramsOf(tool) {
  return new Set(Object.keys(tool.schema ?? {}));
}

/** Every parameter name and enum value any tool accepts: legitimate words to backtick on their own. */
const TOOL_VOCABULARY = new Set();
for (const tool of tools.values()) {
  for (const [name, schema] of Object.entries(tool.schema ?? {})) {
    TOOL_VOCABULARY.add(name);
    const def = unwrap(schema)?._zod?.def;
    if (def?.type === "enum") for (const v of Object.keys(def.entries)) TOOL_VOCABULARY.add(v);
  }
}

/**
 * "`tool` with `param: value`, `other: value` and `flag`" — the house style every
 * procedure uses. Yields [tool, [[param, rawValue|undefined], …]]. The list ends
 * at the first backticked token that is not a parameter (e.g. the next tool).
 */
function* toolCalls(text) {
  for (const m of text.matchAll(/`([a-z_][a-z0-9_]*)`\s+with\s+((?:`[^`]+`(?!\s+with\b)(?:,\s*|\s+and\s+|\s+or\s+)?)+)/g)) {
    const tool = tools.get(m[1]);
    if (!tool) continue;
    const params = [];
    for (const p of m[2].matchAll(/`([^`]+)`/g)) {
      const pm = /^([a-z_][a-z0-9_]*)\s*(?::\s*([\s\S]*))?$/.exec(p[1]);
      if (!pm) break;
      if (pm[2] === undefined && tools.has(pm[1])) break;
      params.push([pm[1], pm[2]]);
    }
    yield [m[1], params];
  }
}

/** Parses a literal value written in a skill, or undefined when it is a placeholder or expression. */
function literal(raw) {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (/\{[a-z][^}"]*\}/i.test(v) && !/^[[{]/.test(v)) return undefined; // "{slug}" placeholders
  if (v.includes("…")) return undefined;
  try { return JSON.parse(v); } catch { return undefined; }
}

test("every skill has complete front matter", () => {
  for (const f of skillFiles) {
    const text = read(f);
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(fm, `${f} has no front matter`);
    for (const key of ["name", "title", "description", "keywords"]) {
      assert.match(fm[1], new RegExp(`^${key}:\\s*\\S`, "m"), `${f} is missing "${key}"`);
    }
    assert.match(fm[1], new RegExp(`^name:\\s*${f.replace(/\.md$/, "")}\\s*$`, "m"), `${f}: name must match the file name`);
  }
});

test("every tool a skill names exists", () => {
  const problems = [];
  for (const f of skillFiles) {
    for (const m of read(f).matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
      const name = m[1];
      if (tools.has(name) || WORDPRESS_IDENTIFIERS.has(name) || TOOL_VOCABULARY.has(name) || !TOOL_SHAPED.test(name)) continue;
      problems.push(`${f}: \`${name}\` is not a tool`);
    }
  }
  assert.deepEqual([...new Set(problems)], []);
});

test("every parameter a skill passes to a tool exists on that tool", () => {
  const problems = [];
  for (const f of skillFiles) {
    const text = read(f);
    for (const [name, params] of toolCalls(text)) {
      const known = paramsOf(tools.get(name));
      for (const [p] of params) if (!known.has(p)) problems.push(`${f}: ${name} has no parameter "${p}"`);
    }
    // tool({ param: … }) in code
    for (const m of text.matchAll(/\b([a-z]+(?:_[a-z0-9]+)+)\(\s*\{([^}]*)\}/g)) {
      const tool = tools.get(m[1]);
      if (!tool) continue;
      const known = paramsOf(tool);
      for (const p of m[2].matchAll(/(?:^|[,{\s])([a-z_][a-z0-9_]*)\s*:/g)) {
        if (!known.has(p[1])) problems.push(`${f}: ${m[1]} has no parameter "${p[1]}"`);
      }
    }
  }
  assert.deepEqual([...new Set(problems)], []);
});

test("every literal value a skill passes fits the tool's schema", () => {
  // Catches e.g. `list_comments` with `status: "pending"` when the enum says "hold",
  // or `list_users` with `roles: "administrator"` when roles is an array.
  const problems = [];
  for (const f of skillFiles) {
    for (const [name, params] of toolCalls(read(f))) {
      const schema = tools.get(name).schema ?? {};
      for (const [p, raw] of params) {
        const value = literal(raw);
        if (value === undefined || !schema[p]) continue;
        const def = unwrap(schema[p])?._zod?.def;
        if (!def) continue;
        const where = `${f}: ${name} ${p}: ${raw}`;
        if (def.type === "enum" && !Object.keys(def.entries).includes(value)) problems.push(`${where} — allowed: ${Object.keys(def.entries).join(", ")}`);
        else if (def.type === "boolean" && typeof value !== "boolean") problems.push(`${where} — expects a boolean`);
        else if (def.type === "number" && typeof value !== "number") problems.push(`${where} — expects a number`);
        else if (def.type === "string" && typeof value !== "string") problems.push(`${where} — expects a string`);
        else if (def.type === "array") {
          if (!Array.isArray(value)) { problems.push(`${where} — expects an array`); continue; }
          const el = unwrap(def.element)?._zod?.def;
          if (el?.type === "enum") for (const v of value) if (!Object.keys(el.entries).includes(v)) problems.push(`${where} — "${v}" not in ${Object.keys(el.entries).join(", ")}`);
        } else if (def.type === "record" || def.type === "object") {
          if (typeof value !== "object" || Array.isArray(value)) problems.push(`${where} — expects an object`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(problems)], []);
});

test("every WP-CLI command a skill suggests is on the allowlist", () => {
  const problems = [];
  for (const f of skillFiles) {
    for (const [name, params] of toolCalls(read(f))) {
      if (name !== "run_wp_cli") continue;
      for (const [p, raw] of params) {
        if (p !== "command") continue;
        const command = /^"([\s\S]*)"$/.exec(raw?.trim() ?? "")?.[1];
        if (!command) continue;
        const verdict = inspectCliCommand(command);
        if (!verdict.allowed) problems.push(`${f}: "${command}" — ${verdict.reason}`);
      }
    }
    // The old shorthand `run_wp_cli "…"` bypasses the check above; keep one form.
    if (/`run_wp_cli`\s+"/.test(read(f))) problems.push(`${f}: write run_wp_cli calls as \`run_wp_cli\` with \`command: "…"\``);
  }
  assert.deepEqual(problems, []);
});

test("skills that point at another skill name a real one", () => {
  const problems = [];
  for (const f of skillFiles) {
    const text = read(f);
    for (const m of text.matchAll(/(?:load|see|follow|use)\s+`([a-z][a-z0-9-]*)`(?!\s+with)/gi)) {
      if (!skillNames.has(m[1]) && !tools.has(m[1])) problems.push(`${f}: \`${m[1]}\` is not a skill`);
    }
    for (const m of text.matchAll(/`([a-z][a-z0-9-]*)`\s+(?:skill|playbook)\b/g)) {
      if (!skillNames.has(m[1])) problems.push(`${f}: \`${m[1]}\` is not a skill`);
    }
  }
  assert.deepEqual([...new Set(problems)], []);
});

test("every bundled skill follows the house structure", () => {
  const order = ["When this applies", "Rules", "Procedure", "Verify", "Report back"];
  const problems = [];
  for (const f of skillFiles) {
    const text = read(f);
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    const description = /^description:\s*(.*)$/m.exec(fm)?.[1] ?? "";
    if (!/^Use (when|for|before)\b/.test(description)) problems.push(`${f}: description should say when to use it ("Use when …")`);
    const keywords = (/^keywords:\s*(.*)$/m.exec(fm)?.[1] ?? "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
    const dupes = keywords.filter((k, i) => keywords.indexOf(k) !== i);
    if (dupes.length) problems.push(`${f}: duplicate keywords ${dupes.join(", ")}`);
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    const positions = order.map((h) => headings.indexOf(h));
    if (positions.some((p) => p === -1)) problems.push(`${f}: missing sections ${order.filter((_, i) => positions[i] === -1).join(", ")}`);
    else if (positions.some((p, i) => i > 0 && p < positions[i - 1])) problems.push(`${f}: sections out of order`);
    const lines = text.split("\n").length;
    if (lines > 140) problems.push(`${f}: ${lines} lines — keep playbooks under ~120`);
  }
  assert.deepEqual(problems, []);
});

test("every bundled skill is committed to the generated bundle", () => {
  const bundled = new Set(listSkills().map((s) => s.name));
  for (const f of skillFiles) assert.ok(bundled.has(f.replace(/\.md$/, "")), `${f} is not in src/generated/skills.ts — run npm run bundle:skills`);
});
