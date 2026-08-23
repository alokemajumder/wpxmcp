/**
 * Cloudflare Workers entry point — wpxmcp as a remote MCP server.
 *
 * Site credentials live in Worker Secrets, never in the repository or in a
 * client's configuration file. Set them with `wrangler secret put`, and see
 * docs/DEPLOY_CLOUDFLARE.md for the full walkthrough.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleMcpRequest } from "./lib/http-transport.js";
import { setPlatform, createMemoryAudit, type AuditEntry, type Platform } from "./lib/platform.js";
import { SiteRegistry } from "./lib/registry.js";
import { loadConfig } from "./lib/config.js";
import { registerTools, type ToolContext } from "./lib/tooling.js";
import { buildToolset, VERSION, INSTRUCTIONS } from "./toolset.js";

export interface Env {
  /** JSON array or object of site definitions. The usual way to configure several sites. */
  WPX_SITES?: string;
  /** Single-site shorthand. */
  WORDPRESS_URL?: string;
  WORDPRESS_USERNAME?: string;
  WORDPRESS_APP_PASSWORD?: string;
  WPX_DEFAULT_SITE?: string;
  /** Shared secret required in the Authorization header. Strongly recommended. */
  WPX_AUTH_TOKEN?: string;
  /** Comma-separated origins allowed to call this Worker from a browser. */
  WPX_ALLOWED_ORIGINS?: string;
  /** Optional stock-photo providers. */
  UNSPLASH_ACCESS_KEY?: string;
  PEXELS_API_KEY?: string;
  /** Optional KV namespace for a durable audit trail across isolates. */
  WPX_AUDIT?: KVNamespace;
  [key: string]: unknown;
}

/** Per-isolate audit ring. Workers may evict the isolate at any time, so this is best-effort. */
const memoryAudit = createMemoryAudit(500);

function installWorkerPlatform(env: Env): Platform {
  const runtime: Platform = {
    kind: "workers",
    env: env as unknown as Record<string, string | undefined>,

    audit(entry: AuditEntry) {
      memoryAudit.push(entry);
      // Fire-and-forget; a failed audit write must never fail the tool call.
      if (env.WPX_AUDIT) {
        const key = `audit:${entry.ts}:${Math.random().toString(36).slice(2, 8)}`;
        env.WPX_AUDIT.put(key, JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 90 }).catch(() => undefined);
      }
    },

    readAudit(limit: number, site?: string) {
      return memoryAudit.read(limit, site);
    },

    // No readLocalFile: a remote Worker has no access to the caller's disk.
    // create_media explains this and points at `url` / `base64_data` instead.

    skills: {
      canSave: false,
      listSaved: () => [],
    },
  };

  setPlatform(runtime);
  return runtime;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed = (env.WPX_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);

  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    headers["Access-Control-Allow-Origin"] = origin;
  } else if (allowed.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*";
  }
  return headers;
}

/**
 * Constant-time comparison, so a wrong token cannot be discovered by timing.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorize(request: Request, env: Env): Response | null {
  if (!env.WPX_AUTH_TOKEN) {
    // Deployed without a token, this Worker would let anyone drive the WordPress
    // sites whose credentials it holds. Refuse rather than run wide open.
    return new Response(
      JSON.stringify({
        error: "This deployment has no WPX_AUTH_TOKEN set, so it refuses every request.",
        fix: "Generate a long random token and set it as a Worker secret: `openssl rand -hex 32 | npx wrangler secret put WPX_AUTH_TOKEN`. Then send it as `Authorization: Bearer <token>`.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  const header = request.headers.get("Authorization") ?? "";
  const presented = header.replace(/^Bearer\s+/i, "").trim();

  if (!presented || !safeEqual(presented, env.WPX_AUTH_TOKEN)) {
    return new Response(
      JSON.stringify({
        error: "Unauthorized.",
        detail: "Send the deployment's shared secret as `Authorization: Bearer <token>`.",
      }),
      { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="wpxmcp"' } }
    );
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Unauthenticated liveness probe. Reveals nothing about the configured sites.
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          service: "wpxmcp",
          version: VERSION,
          runtime: "cloudflare-workers",
          transport: "streamable-http (stateless)",
          endpoint: "/mcp",
          auth_configured: Boolean(env.WPX_AUTH_TOKEN),
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...cors } }
      );
    }

    if (url.pathname !== "/mcp" && url.pathname !== "/") {
      return new Response(
        JSON.stringify({ error: `Unknown path "${url.pathname}". The MCP endpoint is /mcp.` }),
        { status: 404, headers: { "Content-Type": "application/json", ...cors } }
      );
    }

    const denied = authorize(request, env);
    if (denied) return denied;

    installWorkerPlatform(env);

    return handleMcpRequest(request, {
      headers: cors,
      timeoutMs: 120000,
      createServer: () => {
        const registry = new SiteRegistry(loadConfig(env as unknown as Record<string, string | undefined>));
        const ctx: ToolContext = { registry };

        const server = new McpServer(
          { name: "wpxmcp", version: VERSION },
          { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
        );
        registerTools(server, buildToolset(ctx));
        return server;
      },
    });
  },
};
