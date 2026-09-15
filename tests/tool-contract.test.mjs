import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolset } from "../dist/toolset.js";
import { SiteRegistry } from "../dist/lib/registry.js";
import { installNodePlatform } from "../dist/platform-node.js";
import { schemaDescription } from "../dist/lib/tooling.js";
import { createWpxServer } from "../dist/lib/server.js";

installNodePlatform();
const ctx = { registry: new SiteRegistry({ sites: [], source: "test" }) };
const tools = buildToolset(ctx);

/*
 * A model picks a tool and fills its arguments by reading these strings, so a
 * missing description is a functional bug rather than a documentation gap.
 */
test("every tool has a real description and every parameter is described", () => {
  const problems = [];
  for (const t of tools) {
    if (!t.description || t.description.length < 40) problems.push(`${t.name}: description too short`);
    if (!/^[a-z][a-z0-9_]*$/.test(t.name)) problems.push(`${t.name}: not snake_case`);
    for (const [key, schema] of Object.entries(t.schema)) {
      if (key === "site_id") continue;
      if (!schemaDescription(schema)) problems.push(`${t.name}.${key}: no .describe()`);
    }
  }
  assert.deepEqual(problems, []);
});

test("a destructive tool is never also marked read-only", () => {
  assert.deepEqual(tools.filter((t) => t.readOnly && t.destructive).map((t) => t.name), []);
});

test("every tool's schema converts to JSON Schema and is served by tools/list", async () => {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const { handleMcpRequest } = await import("../dist/lib/http-transport.js");
  const client = new Client({ name: "contract", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://t.test/mcp"), {
    fetch: (url, init) => handleMcpRequest(new Request(url, init), { createServer: () => createWpxServer(ctx, tools) }),
  }));
  const listed = (await client.listTools()).tools;
  assert.equal(listed.length, tools.length);
  const problems = [];
  for (const t of listed) {
    if (t.inputSchema?.type !== "object") problems.push(`${t.name}: inputSchema is not an object schema`);
    for (const [key, prop] of Object.entries(t.inputSchema?.properties ?? {})) {
      if (key !== "site_id" && !prop.description) problems.push(`${t.name}.${key}: description lost in JSON Schema`);
    }
  }
  assert.deepEqual(problems, []);
  await client.close();
});
