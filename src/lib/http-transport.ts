import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";

/**
 * Streamable HTTP for a stateless host such as a Cloudflare Worker.
 *
 * The SDK's `createMcpHandler` serves both protocol eras from one endpoint:
 * 2026-07-28 requests (no handshake, no session, per-request `_meta`
 * envelope, `server/discover`) and 2025-era clients through the stateless
 * `initialize` idiom. A fresh server is built per request, so nothing leaks
 * between callers and the isolate can be evicted between calls.
 *
 * What this wrapper adds is the part the protocol does not cover: a body size
 * cap, CORS headers on every response, and a JSON-RPC error instead of an
 * unhandled exception when building the server fails.
 */

/** Tool arguments are small; a base64 media upload is the largest legitimate body. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface HandleOptions {
  /** Builds a server instance. Called per request. */
  createServer: () => McpServer;
  /** Extra response headers, typically CORS. */
  headers?: Record<string, string>;
  /** Reported, never sent to the client. */
  onerror?: (error: Error) => void;
}

function rpcError(code: number, message: string, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function withHeaders(res: Response, extra: Record<string, string>): Response {
  if (!Object.keys(extra).length) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) if (!headers.has(k)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export async function handleMcpRequest(request: Request, options: HandleOptions): Promise<Response> {
  const headers = options.headers ?? {};

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return rpcError(-32600, `Request body is ${declared} bytes; the limit is ${MAX_BODY_BYTES}. Upload large media by URL instead of base64.`, 413, headers);
  }

  // Configuration errors surface when the server is built; build one up front so
  // they become a readable JSON-RPC error rather than an opaque 500.
  let prebuilt: McpServer | undefined;
  try {
    prebuilt = options.createServer();
  } catch (error) {
    return rpcError(-32603, `Server configuration error: ${error instanceof Error ? error.message : String(error)}`, 500, headers);
  }

  // The first build is reused, so a request builds the toolset once.
  const factory = () => {
    const server = prebuilt ?? options.createServer();
    prebuilt = undefined;
    return server;
  };
  const handler = createMcpHandler(factory, { onerror: options.onerror });
  try {
    return withHeaders(await handler.fetch(request), headers);
  } catch (error) {
    options.onerror?.(error instanceof Error ? error : new Error(String(error)));
    return rpcError(-32603, "Internal error while handling the request.", 500, headers);
  }
}
