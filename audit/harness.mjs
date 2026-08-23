import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SP = process.env.SP;
export async function connect() {
  const transport = new StdioClientTransport({
    command: "node", args: ["dist/index.js"],
    env: { ...process.env, WPX_SITES_FILE: `${SP}/sites.json`, WPX_HOME: `${SP}/wpxhome` },
    stderr: "ignore",
  });
  const client = new Client({ name: "audit", version: "1" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

export function makeRunner(client) {
  const covered = new Set();
  const problems = [];
  const notes = [];

  async function call(name, args = {}) {
    covered.add(name);
    try {
      const r = await client.callTool({ name, arguments: args });
      const text = r.content?.[0]?.text ?? "";
      let json = null;
      // Tool text is either JSON, or a note followed by a blank line then JSON.
      for (const candidate of [text, text.split("\n\n").slice(1).join("\n\n"), text.split("\n\n")[0]]) {
        if (!candidate) continue;
        try { json = JSON.parse(candidate.trim()); break; } catch {}
      }
      return { name, error: !!r.isError, text, json };
    } catch (e) {
      return { name, error: true, text: String(e?.message ?? e), json: null };
    }
  }

  /** Asserts a condition about a tool result and records failures. */
  function check(label, condition, detail = "") {
    if (!condition) problems.push(`${label}${detail ? " — " + detail : ""}`);
    return condition;
  }

  /** Runs a tool expecting success, then applies an optional validator. */
  async function expectOk(name, args = {}, validate) {
    const r = await call(name, args);
    if (r.error) {
      problems.push(`${name}: expected success, got error → ${r.text.slice(0, 220).replace(/\s+/g, " ")}`);
      return r;
    }
    if (validate) {
      const msg = validate(r.json, r.text);
      if (msg) problems.push(`${name}: ${msg}`);
    }
    return r;
  }

  /** Runs a tool expecting refusal, matching the reason against a pattern. */
  async function expectRefused(name, args, pattern, label) {
    const r = await call(name, args);
    const refused = r.error || /refused|requires_confirmation|dry_run|"applied": false|not carried out|blocked/i.test(r.text);
    if (!refused) {
      problems.push(`${label ?? name}: expected refusal but it SUCCEEDED → ${r.text.slice(0, 200).replace(/\s+/g, " ")}`);
    } else if (pattern && !pattern.test(r.text)) {
      notes.push(`${label ?? name}: refused, but message did not match ${pattern} → ${r.text.slice(0, 160).replace(/\s+/g, " ")}`);
    }
    return r;
  }

  return { call, check, expectOk, expectRefused, covered, problems, notes };
}
