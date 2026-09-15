import { McpServer } from "@modelcontextprotocol/server";
import { registerTools, type ToolContext, type ToolSpec } from "./tooling.js";
import { buildToolset, VERSION, INSTRUCTIONS } from "../toolset.js";

/**
 * One server definition for both entry points. The tool list never varies per
 * caller, so clients on the 2026-07-28 revision may cache it for an hour; it is
 * kept private because a deployment's tool surface is nobody else's business.
 */
export function createWpxServer(ctx: ToolContext, tools: Array<ToolSpec<any>> = buildToolset(ctx)): McpServer {
  const server = new McpServer(
    { name: "wpxmcp", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
      cacheHints: { "tools/list": { ttlMs: 60 * 60 * 1000, cacheScope: "private" } },
    }
  );
  registerTools(server, tools);
  return server;
}
