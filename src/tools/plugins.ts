import { z } from "zod";
import { defineTool, ok, siteIdSchema, stripHtml, type ToolContext } from "../lib/tooling.js";
import { audit } from "../lib/safety.js";

function shapePlugin(p: any) {
  return {
    plugin: p.plugin,
    name: stripHtml(String(p.name ?? "")),
    status: p.status,
    version: p.version,
    author: stripHtml(String(p.author ?? "")),
    description: stripHtml(String(p.description?.raw ?? p.description?.rendered ?? p.description ?? "")).slice(0, 400),
    plugin_uri: p.plugin_uri || undefined,
    requires_wp: p.requires_wp || undefined,
    requires_php: p.requires_php || undefined,
    network_only: p.network_only ?? undefined,
    textdomain: p.textdomain || undefined,
  };
}

export function pluginTools(ctx: ToolContext) {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    defineTool({
      name: "list_plugins",
      title: "List plugins",
      readOnly: true,
      description:
        "List every plugin installed on the site with its activation status and version. Requires an Administrator account — WordPress exposes no plugin data to lower roles.",
      schema: {
        site_id: siteIdSchema,
        status: z.enum(["active", "inactive", "all"]).optional().default("all").describe("Filter by activation status."),
        search: z.string().optional().describe("Match against plugin name and description."),
      },
      handler: async ({ site_id, status, search }) => {
        const client = site(site_id);
        const res = await client.get<any[]>("/wp/v2/plugins", { search, context: "edit" });
        let plugins = res.data.map(shapePlugin);
        if (status !== "all") plugins = plugins.filter((p) => (status === "active" ? p.status === "active" || p.status === "network-active" : p.status === "inactive"));
        return ok({
          site: client.site.id,
          total_installed: res.data.length,
          active: res.data.filter((p: any) => p.status !== "inactive").length,
          returned: plugins.length,
          plugins,
        });
      },
    }),

    defineTool({
      name: "get_plugin",
      title: "Get a plugin",
      readOnly: true,
      description: "Get full details about one installed plugin by its plugin file path, e.g. \"woocommerce/woocommerce\" or \"hello-dolly/hello\".",
      schema: {
        site_id: siteIdSchema,
        plugin: z.string().describe("Plugin identifier as returned by list_plugins, e.g. \"akismet/akismet\" (no .php extension)."),
      },
      handler: async ({ site_id, plugin }) => {
        const client = site(site_id);
        const res = await client.get<any>(`/wp/v2/plugins/${plugin.replace(/\.php$/, "")}`, { context: "edit" });
        return ok(shapePlugin(res.data));
      },
    }),

    defineTool({
      name: "activate_plugin",
      title: "Activate a plugin",
      description:
        "Activate an installed plugin. Activation runs the plugin's code immediately — a plugin incompatible with this WordPress or PHP version can fatal the site, so prefer testing on staging first.",
      schema: {
        site_id: siteIdSchema,
        plugin: z.string().describe("Plugin identifier, e.g. \"akismet/akismet\"."),
        network_wide: z.boolean().optional().default(false).describe("Activate across a multisite network."),
      },
      handler: async ({ site_id, plugin, network_wide }) => {
        const client = site(site_id);
        client.assertWritable("activate_plugin");
        const id = plugin.replace(/\.php$/, "");
        const res = await client.post<any>(`/wp/v2/plugins/${id}`, { status: network_wide ? "network-active" : "active" });
        audit({ site: client.site.id, tool: "activate_plugin", action: "activate", target: plugin, outcome: "ok" });
        return ok({ activated: true, ...shapePlugin(res.data) });
      },
    }),

    defineTool({
      name: "deactivate_plugin",
      title: "Deactivate a plugin",
      description: "Deactivate an active plugin. Its features stop working immediately; settings and data are normally retained.",
      schema: {
        site_id: siteIdSchema,
        plugin: z.string().describe("Plugin identifier, e.g. \"akismet/akismet\"."),
      },
      handler: async ({ site_id, plugin }) => {
        const client = site(site_id);
        client.assertWritable("deactivate_plugin");
        const id = plugin.replace(/\.php$/, "");
        const res = await client.post<any>(`/wp/v2/plugins/${id}`, { status: "inactive" });
        audit({ site: client.site.id, tool: "deactivate_plugin", action: "deactivate", target: plugin, outcome: "ok" });
        return ok({ deactivated: true, ...shapePlugin(res.data) });
      },
    }),

    defineTool({
      name: "install_plugin",
      title: "Install a plugin",
      description:
        "Install a plugin from the WordPress.org repository by its slug, optionally activating it straight away. Search first with search_plugins to get the right slug. Installation writes files to the server and needs filesystem write access.",
      schema: {
        site_id: siteIdSchema,
        slug: z.string().describe("WordPress.org plugin slug, e.g. \"classic-editor\". Find it with search_plugins."),
        activate: z.boolean().optional().default(false).describe("Activate immediately after installing."),
      },
      handler: async ({ site_id, slug, activate }) => {
        const client = site(site_id);
        client.assertWritable("install_plugin");
        const res = await client.post<any>("/wp/v2/plugins", { slug, status: activate ? "active" : "inactive" });
        audit({ site: client.site.id, tool: "install_plugin", action: activate ? "install+activate" : "install", target: slug, outcome: "ok" });
        return ok({ installed: true, activated: Boolean(activate), ...shapePlugin(res.data) });
      },
    }),

    defineTool({
      name: "create_plugin",
      title: "Create a plugin (alias of install)",
      description: "Install a plugin from the WordPress.org repository. This is the REST API's own naming for the install operation — install_plugin is the clearer name for the same thing.",
      schema: {
        site_id: siteIdSchema,
        slug: z.string().describe("WordPress.org plugin slug."),
        status: z.enum(["active", "inactive"]).optional().default("inactive").describe("Filter by status."),
      },
      handler: async ({ site_id, slug, status }) => {
        const client = site(site_id);
        client.assertWritable("create_plugin");
        const res = await client.post<any>("/wp/v2/plugins", { slug, status });
        audit({ site: client.site.id, tool: "create_plugin", action: "install", target: slug, outcome: "ok" });
        return ok({ installed: true, ...shapePlugin(res.data) });
      },
    }),

    defineTool({
      name: "delete_plugin",
      title: "Delete a plugin",
      destructive: true,
      description:
        "Delete an installed plugin from the server. The plugin must be inactive first. Files are removed permanently; many plugins also drop their database tables on uninstall. Requires confirm: true.",
      schema: {
        site_id: siteIdSchema,
        plugin: z.string().describe("Plugin identifier, e.g. \"hello-dolly/hello\"."),
        confirm: z.boolean().optional().default(false).describe("Required — plugin files are permanently removed."),
      },
      handler: async ({ site_id, plugin, confirm }) => {
        const client = site(site_id);
        client.assertWritable("delete_plugin");
        const id = plugin.replace(/\.php$/, "");
        if (!confirm) {
          const current = await client.get<any>(`/wp/v2/plugins/${id}`, { context: "edit" });
          return ok({ deleted: false, requires_confirmation: true, plugin: shapePlugin(current.data) },
            "Deleting a plugin removes its files, and many plugins drop their database tables when uninstalled. Nothing was deleted — re-run with confirm: true if that is what you want.");
        }
        await client.del(`/wp/v2/plugins/${id}`);
        audit({ site: client.site.id, tool: "delete_plugin", action: "delete", target: plugin, outcome: "ok" });
        return ok({ deleted: true, plugin });
      },
    }),

    defineTool({
      name: "search_plugins",
      title: "Search the plugin repository",
      readOnly: true,
      description:
        "Search the public WordPress.org plugin repository. Returns slug, rating, install count, last-updated date and compatibility — enough to judge whether a plugin is maintained before installing it. This queries WordPress.org, not your site.",
      schema: {
        search: z.string().describe("What to search for, e.g. \"contact form\" or \"seo\"."),
        per_page: z.number().int().min(1).max(50).optional().default(10).describe("How many results per page."),
        page: z.number().int().min(1).optional().default(1).describe("Which page of results to return."),
      },
      handler: async ({ search, per_page, page }) => {
        const url = new URL("https://api.wordpress.org/plugins/info/1.2/");
        url.searchParams.set("action", "query_plugins");
        url.searchParams.set("request[search]", search);
        url.searchParams.set("request[per_page]", String(per_page));
        url.searchParams.set("request[page]", String(page));
        for (const f of ["short_description", "last_updated", "active_installs", "ratings", "tested", "requires", "requires_php", "downloaded"]) {
          url.searchParams.set(`request[fields][${f}]`, "1");
        }
        const res = await fetch(url, { headers: { "User-Agent": "wpxmcp/1.0" } });
        if (!res.ok) throw new Error(`WordPress.org returned HTTP ${res.status}.`);
        const json: any = await res.json();
        return ok({
          query: search,
          total: json.info?.results,
          page,
          plugins: (json.plugins ?? []).map((p: any) => ({
            slug: p.slug,
            name: stripHtml(String(p.name ?? "")),
            version: p.version,
            author: stripHtml(String(p.author ?? "")),
            rating_percent: p.rating,
            num_ratings: p.num_ratings,
            active_installs: p.active_installs,
            last_updated: p.last_updated,
            tested_up_to: p.tested,
            requires_wp: p.requires,
            requires_php: p.requires_php,
            short_description: stripHtml(String(p.short_description ?? "")),
            homepage: p.homepage,
          })),
        }, "Check last_updated and active_installs before installing — an abandoned plugin is a security liability. Install with install_plugin using the `slug`.");
      },
    }),

    defineTool({
      name: "get_plugin_info",
      title: "Get repository plugin info",
      readOnly: true,
      description:
        "Get detailed information about one plugin from the WordPress.org repository — full description, changelog, version history, ratings breakdown, and compatibility. Use before installing or updating to see what changed.",
      schema: {
        slug: z.string().describe("WordPress.org plugin slug, e.g. \"woocommerce\"."),
        include_sections: z.boolean().optional().default(false).describe("Include the long description and changelog text. Verbose — off by default."),
      },
      handler: async ({ slug, include_sections }) => {
        const url = new URL("https://api.wordpress.org/plugins/info/1.2/");
        url.searchParams.set("action", "plugin_information");
        url.searchParams.set("request[slug]", slug);
        const res = await fetch(url, { headers: { "User-Agent": "wpxmcp/1.0" } });
        if (!res.ok) throw new Error(`WordPress.org returned HTTP ${res.status} for "${slug}".`);
        const p: any = await res.json();
        if (p.error) throw new Error(`WordPress.org: ${p.error}. Check the slug — it is the last path segment of the plugin's wordpress.org URL.`);

        const payload: any = {
          slug: p.slug,
          name: stripHtml(String(p.name ?? "")),
          version: p.version,
          author: stripHtml(String(p.author ?? "")),
          homepage: p.homepage,
          download_link: p.download_link,
          requires_wp: p.requires,
          tested_up_to: p.tested,
          requires_php: p.requires_php,
          last_updated: p.last_updated,
          added: p.added,
          active_installs: p.active_installs,
          downloaded: p.downloaded,
          rating_percent: p.rating,
          num_ratings: p.num_ratings,
          ratings_breakdown: p.ratings,
          support_threads: p.support_threads,
          support_threads_resolved: p.support_threads_resolved,
          short_description: stripHtml(String(p.short_description ?? "")),
          tags: p.tags ? Object.values(p.tags) : undefined,
          available_versions: p.versions ? Object.keys(p.versions).slice(-15) : undefined,
        };
        if (include_sections && p.sections) {
          payload.description = stripHtml(String(p.sections.description ?? "")).slice(0, 5000);
          payload.changelog = stripHtml(String(p.sections.changelog ?? "")).slice(0, 5000);
          payload.installation = stripHtml(String(p.sections.installation ?? "")).slice(0, 2000);
        }
        return ok(payload);
      },
    }),
  ];
}
