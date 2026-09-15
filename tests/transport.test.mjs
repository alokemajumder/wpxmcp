import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { handleMcpRequest, MAX_BODY_BYTES } from "../dist/lib/http-transport.js";

function createServer() {
  const server = new McpServer({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.registerTool(
    "echo",
    { title: "Echo", description: "Echoes its input back.", inputSchema: z.object({ value: z.string().describe("Text to echo.") }) },
    async ({ value }) => ({ content: [{ type: "text", text: value }] })
  );
  return server;
}

const CORS = { "Access-Control-Allow-Origin": "https://claude.ai" };
const serve = (request) => handleMcpRequest(request, { createServer, headers: CORS });

function post(body, headers = {}) {
  return new Request("https://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 2025-era responses may arrive as a single SSE event; both forms carry one JSON-RPC message. */
async function message(res) {
  const text = await res.text();
  const data = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
  return JSON.parse(data);
}

function connectClient(mode) {
  const client = new Client({ name: "test-client", version: "1.0.0" }, mode ? { versionNegotiation: { mode } } : {});
  const transport = new StreamableHTTPClientTransport(new URL("https://worker.test/mcp"), {
    fetch: (url, init) => serve(new Request(url, init)),
  });
  return client.connect(transport).then(() => client);
}

test("a 2026-07-28 client connects without a handshake and calls a tool", async () => {
  const client = await connectClient({ pin: "2026-07-28" });
  assert.equal(client.getProtocolEra(), "modern");
  const result = await client.callTool({ name: "echo", arguments: { value: "hello" } });
  assert.equal(result.content[0].text, "hello");
  await client.close();
});

test("a 2025-era client still negotiates through initialize", async () => {
  const client = await connectClient();
  const tools = await client.listTools();
  assert.equal(tools.tools[0].name, "echo");
  assert.equal(tools.tools[0].inputSchema.properties.value.description, "Text to echo.");
  const result = await client.callTool({ name: "echo", arguments: { value: "legacy" } });
  assert.equal(result.content[0].text, "legacy");
  await client.close();
});

test("a raw 2025-11-25 initialize is answered with the negotiated revision", async () => {
  const res = await serve(post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } } }));
  assert.equal(res.status, 200);
  assert.equal((await message(res)).result.protocolVersion, "2025-11-25");
});

test("CORS headers ride on every response, so browser clients can read them", async () => {
  const res = await serve(post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } } }));
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://claude.ai");
});

test("an oversized body is refused before any work is done", async () => {
  let built = 0;
  const res = await handleMcpRequest(post("{}", { "Content-Length": String(MAX_BODY_BYTES + 1) }), {
    createServer: () => (built++, createServer()),
    headers: CORS,
  });
  assert.equal(res.status, 413);
  assert.equal(built, 0);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://claude.ai");
});

test("a server that fails to build yields a JSON-RPC error, not an exception", async () => {
  const res = await handleMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {
    createServer: () => { throw new Error("WPX_SITES is not valid JSON"); },
  });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error.message, /WPX_SITES is not valid JSON/);
});

test("the toolset is built once per request, not once per protocol step", async () => {
  let built = 0;
  await handleMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } } }), {
    createServer: () => (built++, createServer()),
  });
  assert.equal(built, 1);
});

test("malformed JSON produces an error response, not a crash", async () => {
  const res = await serve(post("{broken"));
  assert.ok(res.status >= 400 && res.status < 500);
});

test("a non-JSON content type is refused", async () => {
  const res = await serve(new Request("https://worker.test/mcp", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" }));
  assert.equal(res.status, 415);
});
