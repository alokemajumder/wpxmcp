#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { installNodePlatform } from "./platform-node.js";
import { SiteRegistry } from "./lib/registry.js";
import type { ToolContext } from "./lib/tooling.js";
import { createWpxServer } from "./lib/server.js";
import { loadConfig } from "./lib/config.js";
import { listSkills } from "./lib/skills.js";

import { buildToolset, VERSION } from "./toolset.js";

async function main() {
  installNodePlatform();

  if (process.argv.includes("--version")) {
    console.log(VERSION);
    return;
  }
  if (process.argv.includes("--doctor")) {
    await doctor();
    return;
  }

  const registry = new SiteRegistry();
  const ctx: ToolContext = { registry };

  const tools = buildToolset(ctx);

  // stdout is the MCP transport — everything diagnostic must go to stderr.
  console.error(
    `wpxmcp ${VERSION} — ${tools.length} tools, ${registry.sites.length} site(s) from ${registry.config.source}` +
      (registry.sites.length ? `: ${registry.sites.map((s) => s.id).join(", ")}` : " (none configured — run list_sites for setup help)")
  );

  // Serves both protocol eras: the opening message pins the connection to
  // 2026-07-28 (server/discover) or to a 2025-era initialize handshake.
  serveStdio(() => createWpxServer(ctx, tools), {
    onerror: (error) => console.error(`wpxmcp: ${error.message}`),
  });
}

/** `wpxmcp --doctor` — verifies configuration and connectivity outside an MCP client. */
async function doctor() {
  console.log(`wpxmcp ${VERSION} — configuration check\n`);
  let config;
  try {
    config = loadConfig();
  } catch (e: any) {
    console.log(`✗ Configuration error: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Config source : ${config.source}`);
  console.log(`Sites         : ${config.sites.length}`);
  console.log(`Default site  : ${config.defaultSiteId ?? "(none)"}`);
  console.log(`Skills        : ${listSkills().length} playbooks available\n`);

  if (config.sites.length === 0) {
    console.log("No sites configured. Set WORDPRESS_URL / WORDPRESS_USERNAME / WORDPRESS_APP_PASSWORD,");
    console.log("or point WPX_SITES_FILE at a sites.json. See the README.");
    process.exitCode = 1;
    return;
  }

  const registry = new SiteRegistry(config);
  for (const site of config.sites) {
    console.log(`── ${site.id} (${site.url})`);
    if (site.url.startsWith("http://") && site.username && site.appPassword) {
      console.log("   ○ plain http — WordPress only accepts Application Passwords over HTTPS (or on a local environment)");
    }
    const client = registry.resolve(site.id);
    try {
      const root = await client.get<any>("/");
      console.log(`   ✓ REST API reachable — "${root.data?.name ?? "unnamed"}"`);
      const ns: string[] = root.data?.namespaces ?? [];
      console.log(`   ${ns.includes(site.helperNamespace ?? "wpxmcp/v1") ? "✓" : "○"} companion plugin ${ns.includes(site.helperNamespace ?? "wpxmcp/v1") ? "active" : "not installed (optional)"}`);
    } catch (e: any) {
      console.log(`   ✗ ${e.message}`);
      process.exitCode = 1;
      continue;
    }
    if (!client.hasCredentials()) {
      console.log("   ○ no credentials — public reads only");
      continue;
    }
    try {
      const me = await client.get<any>("/wp/v2/users/me", { context: "edit" });
      console.log(`   ✓ authenticated as "${me.data?.name}" (${(me.data?.roles ?? []).join(", ") || "unknown role"})`);
      if (!me.data?.capabilities?.manage_options) {
        console.log("   ○ not an administrator — settings, plugins, themes, SQL and WP-CLI will be refused");
      }
    } catch (e: any) {
      console.log(`   ✗ authentication failed: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error("wpxmcp failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
