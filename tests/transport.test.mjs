import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleMcpRequest } from "../dist/lib/http-transport.js";

function createServer() {
  const server = new McpServer({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.registerTool(
    "echo",
    { title: "Echo", description: "Echoes its input back.", inputSchema: { value: z.string() } },
    async ({ value }) => ({ content: [{ type: "text", text: value }] })
  );
  return server;
}

function post(body) {
  return new Request("https://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("initialize negotiates the current protocol revision", async () => {
  const res = await handleMcpRequest(
    post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    { createServer }
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.protocolVersion, "2025-11-25");
  assert.equal(body.result.serverInfo.name, "test");
});

test("a tool call round-trips", async () => {
  const res = await handleMcpRequest(
    post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { value: "hi" } } }),
    { createServer }
  );
  const body = await res.json();
  assert.equal(body.result.content[0].text, "hi");
});

test("a notification is answered with 202 and no body", async () => {
  const res = await handleMcpRequest(post({ jsonrpc: "2.0", method: "notifications/initialized" }), { createServer });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

test("GET is rejected because stateless mode opens no stream", async () => {
  const res = await handleMcpRequest(new Request("https://worker.test/mcp"), { createServer });
  assert.equal(res.status, 405);
});

test("DELETE succeeds because there is no session to end", async () => {
  const res = await handleMcpRequest(new Request("https://worker.test/mcp", { method: "DELETE" }), { createServer });
  assert.equal(res.status, 204);
});

test("a non-JSON content type is refused", async () => {
  const req = new Request("https://worker.test/mcp", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
  const res = await handleMcpRequest(req, { createServer });
  assert.equal(res.status, 415);
});

test("malformed JSON produces a parse error, not a crash", async () => {
  const res = await handleMcpRequest(post("{broken"), { createServer });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32700);
});

test("batched requests are refused, as the spec removed them", async () => {
  const res = await handleMcpRequest(post([{ jsonrpc: "2.0", id: 1, method: "ping" }]), { createServer });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /batching was removed/);
});

test("a message missing the jsonrpc marker is refused", async () => {
  const res = await handleMcpRequest(post({ id: 1, method: "ping" }), { createServer });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32600);
});

test("supplied headers reach the response, so CORS works", async () => {
  const res = await handleMcpRequest(
    post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    { createServer, headers: { "Access-Control-Allow-Origin": "https://claude.ai" } }
  );
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://claude.ai");
});
