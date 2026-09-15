import { z } from "zod";
import { defineTool, ok, siteIdSchema, type ToolContext } from "../lib/tooling.js";
import { readAudit } from "../lib/safety.js";
import { platform } from "../lib/platform.js";

export function siteTools(ctx: ToolContext) {
  const { registry } = ctx;

  return [
    defineTool({
      name: "list_sites",
      title: "List WordPress sites",
      readOnly: true,
      description:
        "List every WordPress site configured on this MCP server, with its id, URL, auth method and whether it is writable. Start here when you do not know which site_id to use. Credentials are never returned.",
      schema: {},
      handler: async () => {
        if (registry.sites.length === 0) {
          return ok(
            "No sites are configured yet.\n\n" +
              "Configure one of:\n" +
              "  • WORDPRESS_URL + WORDPRESS_USERNAME + WORDPRESS_APP_PASSWORD  (single site)\n" +
              "  • WPX_SITES_FILE=/path/to/sites.json                            (many sites)\n" +
              "  • WPX_SITES='[{\"id\":\"blog\",\"url\":\"...\",\"username\":\"...\",\"appPassword\":\"...\"}]'\n\n" +
              "The Application Password comes from wp-admin → Users → Profile → Application Passwords."
          );
        }
        return ok({
          config_source: registry.config.source,
          default_site: registry.defaultSiteId,
          count: registry.sites.length,
          sites: registry.sites.map((s) => registry.redacted(s)),
        });
      },
    }),

    defineTool({
      name: "get_site",
      title: "Get site configuration",
      readOnly: true,
      description:
        "Get the full configuration for one site (secrets redacted), plus what the WordPress install reports about itself: name, description, timezone, WordPress version, permalink shape, and which optional wpxmcp capabilities are available.",
      schema: {
        site_id: siteIdSchema,
        include_remote: z.boolean().optional().default(true).describe("Also query the site itself. Set false for a purely local, offline answer."),
      },
      handler: async ({ site_id, include_remote }) => {
        const client = registry.resolve(site_id);
        const local = registry.redacted(client.site);
        if (!include_remote) return ok({ config: local });

        const payload: Record<string, unknown> = { config: local };
        try {
          const root = await client.get<any>("/");
          payload.site = {
            name: root.data?.name,
            description: root.data?.description,
            home: root.data?.home,
            url: root.data?.url,
            gmt_offset: root.data?.gmt_offset,
            timezone_string: root.data?.timezone_string,
            site_icon_url: root.data?.site_icon_url,
            namespaces: root.data?.namespaces,
          };
          payload.capabilities = {
            helper_plugin: (root.data?.namespaces ?? []).includes(client.site.helperNamespace ?? "wpxmcp/v1"),
            abilities_api: (root.data?.namespaces ?? []).some((n: string) => n.startsWith("wp-abilities") || n.startsWith("abilities")),
            woocommerce: (root.data?.namespaces ?? []).some((n: string) => n.startsWith("wc/")),
            yoast: (root.data?.namespaces ?? []).some((n: string) => n.startsWith("yoast")),
          };
        } catch (e: any) {
          payload.site_error = e.message;
        }
        return ok(payload);
      },
    }),

    defineTool({
      name: "test_site",
      title: "Test site connection",
      readOnly: true,
      description:
        "Test connectivity and authentication against a site, and report exactly what works: REST reachability, whether credentials authenticate, which user they map to, that user's roles and capabilities, and whether the optional companion plugin is installed. Run this first when anything is behaving strangely — it names the specific misconfiguration rather than a generic failure.",
      schema: { site_id: siteIdSchema },
      handler: async ({ site_id }) => {
        const client = registry.resolve(site_id);
        const checks: Array<{ check: string; status: "pass" | "fail" | "warn" | "skip"; detail: string }> = [];
        let root: any = null;

        try {
          const res = await client.get<any>("/");
          root = res.data;
          checks.push({ check: "REST API reachable", status: "pass", detail: `${client.buildUrl("/")} answered with "${root?.name ?? "(no name)"}".` });
        } catch (e: any) {
          checks.push({ check: "REST API reachable", status: "fail", detail: e.message ?? String(e) });
          return ok({ site: client.site.id, url: client.site.url, overall: "fail", checks },
            "Could not reach the REST API, so no further checks ran.");
        }

        if (!client.hasCredentials()) {
          checks.push({ check: "Credentials configured", status: "warn", detail: "No username/appPassword or bearerToken is set. Public reads will work; every write will fail." });
        } else {
          checks.push({ check: "Credentials configured", status: "pass", detail: client.site.bearerToken ? "Bearer token." : `Application Password for "${client.site.username}".` });
          try {
            const me = await client.get<any>("/wp/v2/users/me", { context: "edit" });
            const caps = me.data?.capabilities ?? {};
            const notable = ["manage_options", "edit_posts", "publish_posts", "upload_files", "edit_theme_options", "activate_plugins", "edit_themes", "list_users"]
              .filter((c) => caps[c]);
            checks.push({
              check: "Authentication",
              status: "pass",
              detail: `Authenticated as "${me.data?.name}" (id ${me.data?.id}), roles: ${(me.data?.roles ?? []).join(", ") || "unknown"}.`,
            });
            checks.push({
              check: "Capabilities",
              status: notable.includes("edit_posts") ? "pass" : "warn",
              detail: notable.length
                ? `Granted: ${notable.join(", ")}.`
                : "This user has none of the notable editing capabilities — it is probably a Subscriber, which cannot manage content.",
            });
            if (!caps.manage_options) {
              checks.push({ check: "Administrator", status: "warn", detail: "Not an administrator. Settings, plugins, themes, WP-CLI and SQL tools will be refused by WordPress." });
            }
          } catch (e: any) {
            checks.push({
              check: "Authentication",
              status: "fail",
              detail: `${e.message} — the credentials were rejected. Confirm the Application Password, and if the host strips the Authorization header add the passthrough rule from the README.`,
            });
          }
        }

        // WordPress ships a Site Health test for exactly the failure that causes
        // most 401s: a host stripping the Authorization header before PHP sees it.
        if (client.hasCredentials()) {
          try {
            const header = await client.get<any>("/wp-site-health/v1/tests/authorization-header");
            const status = header.data?.status;
            checks.push({
              check: "Authorization header passthrough",
              status: status === "good" ? "pass" : "warn",
              detail: status === "good"
                ? "The server passes the Authorization header through to PHP."
                : `WordPress reports: ${String(header.data?.label ?? status)}. If writes fail with 401 despite correct credentials, this is the usual cause — add the passthrough rule from docs/WORDPRESS_AUTH.md. Note that this test makes a loopback request, so it reports a false warning on single-threaded dev servers such as \`php -S\`; if authentication above passed, the header is in fact arriving.`,
            });
          } catch {
            // Older WordPress, or the route is unavailable; not worth failing over.
          }
        }

        const namespaces: string[] = root?.namespaces ?? [];
        const helperNs = client.site.helperNamespace ?? "wpxmcp/v1";
        checks.push({
          check: "Companion plugin",
          status: namespaces.includes(helperNs) ? "pass" : "warn",
          detail: namespaces.includes(helperNs)
            ? `The wpxmcp helper plugin is active (${helperNs}), so SQL, WP-CLI emulation, theme drafts, page HTML and field registration are available.`
            : `The wpxmcp helper plugin is not installed. Core REST tools all work; execute_sql_query, run_wp_cli, the draft theme tools, get_page_html and field registration need it. Install wp-plugin/wpxmcp-helper from this repo.`,
        });

        const abilityNs = namespaces.find((n) => n.startsWith("wp-abilities"));
        checks.push({
          check: "Abilities API",
          status: abilityNs ? "pass" : "warn",
          detail: abilityNs
            ? `Available at ${abilityNs}. discover_abilities and run_ability can call any ability a plugin registers — the safest way to write plugin-owned data.`
            : "Not present. It is built into WordPress 7.0+; on older versions plugin data must go through the plugin's own REST namespace or WP-CLI.",
        });

        try {
          const types = await client.postTypes(true);
          checks.push({ check: "Content types", status: "pass", detail: `${Object.keys(types).length} registered: ${Object.keys(types).slice(0, 12).join(", ")}${Object.keys(types).length > 12 ? "…" : ""}` });
        } catch (e: any) {
          checks.push({ check: "Content types", status: "fail", detail: e.message });
        }

        const failed = checks.filter((c) => c.status === "fail").length;
        const warned = checks.filter((c) => c.status === "warn").length;
        return ok({
          site: client.site.id,
          url: client.site.url,
          overall: failed ? "fail" : warned ? "pass with warnings" : "pass",
          checks,
        });
      },
    }),

    defineTool({
      name: "get_audit_log",
      title: "Read the audit log",
      readOnly: true,
      description:
        "Read the append-only local audit log of every sensitive action this server has taken — writes, deletes, SQL, WP-CLI, theme publishes — with timestamp, site, tool, target and outcome. Useful for answering \"what did the AI actually change?\".",
      schema: {
        site_id: siteIdSchema,
        limit: z.number().int().min(1).max(1000).optional().default(50).describe("How many of the most recent entries to return."),
        all_sites: z.boolean().optional().default(false).describe("Include entries for every site rather than just one."),
      },
      handler: async ({ site_id, limit, all_sites }) => {
        const filter = all_sites ? undefined : registry.sites.length ? registry.resolve(site_id).site.id : undefined;
        const entries = readAudit(limit, filter);
        return ok({
          log_file: platform().kind === "node" ? "~/.wpxmcp/audit.log.jsonl" : "in-memory ring on this server instance (not persisted; the companion plugin keeps a site-side log)",
          filtered_to_site: filter ?? "(all)",
          count: entries.length,
          entries,
        }, entries.length === 0 ? "No audited actions recorded yet." : undefined);
      },
    }),
  ];
}
