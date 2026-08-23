import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * A stateless Streamable HTTP transport.
 *
 * The MCP Streamable HTTP transport allows a server to answer a POST with a
 * single `application/json` body instead of holding an SSE stream open. That is
 * exactly what a Cloudflare Worker wants: no Durable Object, no persistent
 * connection, no session affinity — one request in, one response out, and the
 * isolate can be evicted between calls.
 *
 * A fresh McpServer and transport are built per request, so nothing leaks
 * between callers. The trade-off is that server-initiated messages (sampling,
 * elicitation, long-lived progress notifications) are not available; every tool
 * here is a plain request/response, so nothing needs them.
 */
export class StatelessHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  private outbound: JSONRPCMessage[] = [];
  private settle?: () => void;
  private awaitingResponseTo: Set<string | number> = new Set();

  async start(): Promise<void> {
    /* Nothing to open — the HTTP request is already in flight. */
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.outbound.push(message);
    const id = (message as { id?: string | number }).id;
    if (id !== undefined && this.awaitingResponseTo.has(id)) {
      this.awaitingResponseTo.delete(id);
      if (this.awaitingResponseTo.size === 0) this.settle?.();
    }
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  setProtocolVersion(_version: string): void {
    /* Negotiation is handled by the SDK; nothing to persist in stateless mode. */
  }

  /**
   * Feeds one inbound JSON-RPC message to the server and resolves with whatever
   * the server sends back — or with nothing, for a notification.
   */
  async exchange(message: JSONRPCMessage, timeoutMs: number): Promise<JSONRPCMessage[]> {
    const id = (message as { id?: string | number }).id;
    const isRequest = id !== undefined && "method" in message;

    if (!isRequest) {
      // A notification or response gets no reply; hand it over and return.
      this.onmessage?.(message);
      return [];
    }

    this.awaitingResponseTo.add(id);

    const settled = new Promise<void>((resolve) => {
      this.settle = resolve;
    });

    // The timer is always cleared: an un-cleared setTimeout keeps the Node event
    // loop alive and holds a Workers isolate open after the response is sent.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`The server did not answer within ${timeoutMs}ms.`)), timeoutMs);
    });

    try {
      this.onmessage?.(message);
      await Promise.race([settled, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    return this.outbound;
  }
}

export interface HandleOptions {
  /** Builds a server instance for this request. */
  createServer: () => Promise<McpServer> | McpServer;
  /** How long a single tool call may take. */
  timeoutMs?: number;
  /** Extra response headers, typically CORS. */
  headers?: Record<string, string>;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function rpcError(id: string | number | null, code: number, message: string, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/**
 * Serves one MCP request over Streamable HTTP.
 *
 * POST   — a JSON-RPC message; answers with the result, or 202 for a notification.
 * GET    — 405: there is no server-initiated stream in stateless mode.
 * DELETE — 204: there is no session to terminate.
 */
export async function handleMcpRequest(request: Request, options: HandleOptions): Promise<Response> {
  const headers = options.headers ?? {};

  if (request.method === "GET") {
    return new Response(
      JSON.stringify({
        error: "This endpoint is stateless and does not open an SSE stream. Send MCP messages as HTTP POST to this same URL.",
      }),
      { status: 405, headers: { ...JSON_HEADERS, Allow: "POST, DELETE, OPTIONS", ...headers } }
    );
  }

  if (request.method === "DELETE") {
    // Clients terminate sessions here; stateless mode has none, so this always succeeds.
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST, DELETE, OPTIONS", ...headers } });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return rpcError(null, -32700, `Expected Content-Type: application/json, received "${contentType || "(none)"}".`, 415, headers);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    return rpcError(null, -32700, `Request body was not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 400, headers);
  }

  if (Array.isArray(payload)) {
    return rpcError(
      null,
      -32600,
      "JSON-RPC batching was removed in MCP protocol revision 2025-06-18. Send one message per request.",
      400,
      headers
    );
  }
  if (!payload || typeof payload !== "object" || (payload as any).jsonrpc !== "2.0") {
    return rpcError(null, -32600, 'Not a JSON-RPC 2.0 message — every message needs `"jsonrpc": "2.0"`.', 400, headers);
  }

  const message = payload as JSONRPCMessage;
  const id = (message as { id?: string | number }).id ?? null;

  const server = await options.createServer();
  const transport = new StatelessHttpTransport();

  try {
    await server.connect(transport);
    const replies = await transport.exchange(message, options.timeoutMs ?? 120000);

    if (replies.length === 0) {
      // Notifications get no body, per the JSON-RPC and MCP specs.
      return new Response(null, { status: 202, headers });
    }

    const body = replies.length === 1 ? replies[0] : replies;
    return new Response(JSON.stringify(body), { status: 200, headers: { ...JSON_HEADERS, ...headers } });
  } catch (error) {
    return rpcError(id, -32603, error instanceof Error ? error.message : String(error), 500, headers);
  } finally {
    await server.close().catch(() => undefined);
  }
}
