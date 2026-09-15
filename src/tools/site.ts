import { z } from "zod";
import { defineTool, ok, siteIdSchema, stripHtml, unwrap, trimText, type ToolContext } from "../lib/tooling.js";
import { audit } from "../lib/safety.js";
import type { WordPressClient } from "../lib/client.js";
import { readCapped } from "../lib/http-utils.js";

/** Largest page body get_page_html will read, so a huge or endless response cannot exhaust memory. */
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Site Health tests core exposes over REST (the "async" ones Site Health runs in the browser). */
const CORE_HEALTH_TESTS = ["background-updates", "loopback-requests", "https-status", "dotorg-communication", "authorization-header", "page-cache"];

/** Whether `candidate` is on the same host as the site — the only place get_page_html may go. */
export function isSameSite(siteUrl: string | URL, candidate: URL): boolean {
  const base = new URL(String(siteUrl));
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return false;
  if (candidate.username || candidate.password) return false;
  const port = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");
  // http→https on the same host is the redirect nearly every site issues, so the scheme may differ;
  // the host must not, and neither may a non-default port.
  if (candidate.hostname.toLowerCase() !== base.hostname.toLowerCase()) return false;
  const explicit = (u: URL) => u.port !== "";
  if (explicit(candidate) || explicit(base)) return port(candidate) === port(base) && candidate.protocol === base.protocol;
  return true;
}

/**
 * Resolves a caller-supplied path or URL against the site and refuses anything
 * that would leave it. Relative inputs are always treated as paths under the
 * site — leading slashes and backslashes are collapsed first, so "//evil.com"
 * and "\\evil.com" cannot become protocol-relative URLs to another host.
 */
export function resolveSiteUrl(siteUrl: string, input: string): URL {
  const base = new URL(siteUrl.replace(/\/+$/, "") + "/");
  const raw = String(input ?? "").trim() || "/";
  const target = /^[a-z][a-z0-9+.-]*:/i.test(raw)
    ? new URL(raw)
    : new URL(raw.replace(/\\/g, "/").replace(/^\/+/, ""), base);
  if (!isSameSite(base, target)) {
    throw new Error(`Only pages on the configured site (${base.origin}) can be fetched; "${input}" points elsewhere. Pass a path such as "/about/".`);
  }
  return target;
}

/**
 * The method WordPress will actually dispatch. The REST server honours a
 * `_method` query parameter as a method override on any request, so a "GET"
 * carrying `_method=DELETE` is a delete — and must be treated as a write.
 */
export function effectiveRestMethod(method: string, route: string, query?: Record<string, unknown>): string {
  let override: string | undefined;
  const q = route.indexOf("?");
  if (q >= 0) {
    for (const [k, v] of new URLSearchParams(route.slice(q + 1))) if (k.toLowerCase() === "_method") override = v;
  }
  for (const [k, v] of Object.entries(query ?? {})) {
    if (k.toLowerCase() === "_method" && v !== undefined && v !== null && v !== "") override = String(v);
  }
  return (override ?? method).toUpperCase();
}


/** "/wp/v2/posts" for a post type, honouring a custom rest_namespace (WordPress 5.9+). */
async function contentRoute(client: WordPressClient, type: string): Promise<string> {
  const restBase = await client.restBaseForType(type);
  const types = await client.postTypes();
  const def = Object.values<any>(types).find((t) => t.rest_base === restBase);
  return `/${def?.rest_namespace || "wp/v2"}/${restBase}`;
}

export function siteConfigTools(ctx: ToolContext) {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    defineTool({
      name: "get_site_settings",
      title: "Get site settings",
      readOnly: true,
      description:
        "Read the site's core settings — title, tagline, timezone, date formats, posts-per-page, front page configuration, default category, comment and registration policy. Requires an Administrator account.",
      schema: { site_id: siteIdSchema },
      handler: async ({ site_id }) => {
        const client = site(site_id);
        const res = await client.get<any>("/wp/v2/settings");
        return ok({ site: client.site.id, settings: res.data });
      },
    }),

    defineTool({
      name: "update_site_settings",
      title: "Update site settings",
      description:
        "Update the site's core settings. These are global and take effect immediately for every visitor — changing `show_on_front` or `page_on_front` changes what the homepage is, and changing `start_of_week` or timezone shifts every displayed date. Requires an Administrator account.",
      schema: {
        site_id: siteIdSchema,
        title: z.string().optional().describe("Site title."),
        description: z.string().optional().describe("Tagline."),
        timezone: z.string().optional().describe("A PHP timezone string, e.g. \"Europe/London\"."),
        date_format: z.string().optional().describe("PHP date format, e.g. \"F j, Y\"."),
        time_format: z.string().optional().describe("PHP time format, e.g. \"g:i a\"."),
        start_of_week: z.number().int().min(0).max(6).optional().describe("0 = Sunday."),
        language: z.string().optional().describe("Site locale, e.g. \"en_GB\"."),
        posts_per_page: z.number().int().min(1).optional().describe("How many posts appear on a blog listing page."),
        default_category: z.number().int().optional().describe("Category ID assigned to posts with no category."),
        default_post_format: z.string().optional().describe("Post format applied to new posts, e.g. \"standard\"."),
        show_on_front: z.enum(["posts", "page"]).optional().describe("Whether the front page shows the blog or a static page."),
        page_on_front: z.number().int().optional().describe("Page ID to use as the front page. Only applies when show_on_front is \"page\"."),
        page_for_posts: z.number().int().optional().describe("Page ID that lists blog posts."),
        default_ping_status: z.enum(["open", "closed"]).optional().describe("Whether new content accepts pingbacks and trackbacks."),
        default_comment_status: z.enum(["open", "closed"]).optional().describe("Whether new content allows comments by default."),
        users_can_register: z.boolean().optional().describe("Allow public registration. Enabling this on a site without spam protection invites abuse."),
        site_icon: z.number().int().optional().describe("Attachment ID for the site icon / favicon."),
      },
      handler: async ({ site_id, ...fields }) => {
        const client = site(site_id);
        client.assertWritable("update_site_settings");
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
        if (Object.keys(body).length === 0) throw new Error("No settings to update were supplied.");

        const before = await client.get<any>("/wp/v2/settings");
        const res = await client.post<any>("/wp/v2/settings", body);
        const changes = Object.keys(body).map((k) => ({ setting: k, from: before.data[k], to: res.data[k] }));
        audit({ site: client.site.id, tool: "update_site_settings", action: "update", target: Object.keys(body).join(","), outcome: "ok" });

        const warnings: string[] = [];
        if (body.users_can_register === true) warnings.push("Public registration is now open. Without a spam plugin this attracts bot signups.");
        if (body.show_on_front || body.page_on_front) warnings.push("The front page configuration changed — check the homepage renders as expected.");
        return ok({ updated: true, changes, warnings: warnings.length ? warnings : undefined });
      },
    }),

    defineTool({
      name: "site_info",
      title: "Get site intelligence",
      readOnly: true,
      description:
        "A full diagnostic picture of the site in one call: WordPress and PHP versions, active theme, active plugins, database size, health checks, available updates, and server configuration. Start here when auditing a site or diagnosing a problem. Falls back to core REST data when the companion plugin is absent, and says which parts it could not see.",
      schema: {
        site_id: siteIdSchema,
        include_plugins: z.boolean().optional().default(true).describe("Include the plugin inventory."),
        include_health: z.boolean().optional().default(true).describe("Include Site Health checks: core's REST-exposed tests (loopback, HTTPS, updates, page cache, Authorization header) always, plus the direct tests when the companion plugin is active. Adds a few seconds."),
      },
      handler: async ({ site_id, include_plugins, include_health }) => {
        const client = site(site_id);
        const ns = client.site.helperNamespace ?? "wpxmcp/v1";
        const hasHelper = await client.hasHelperPlugin();
        const payload: any = { site: client.site.id, url: client.site.url, companion_plugin: hasHelper };
        const unavailable: string[] = [];

        const root = await client.get<any>("/");
        payload.identity = {
          name: root.data?.name, description: root.data?.description,
          home: root.data?.home, timezone: root.data?.timezone_string, gmt_offset: root.data?.gmt_offset,
        };

        try {
          const themes = await client.get<any[]>("/wp/v2/themes", { status: "active", context: "edit" });
          const active = themes.data[0];
          payload.active_theme = active ? {
            stylesheet: active.stylesheet, name: stripHtml(String(active.name?.rendered ?? active.name ?? "")),
            version: active.version, is_block_theme: active.is_block_theme, parent: active.template !== active.stylesheet ? active.template : null,
          } : null;
        } catch (e: any) { unavailable.push(`active theme (${e.message})`); }

        if (include_plugins) {
          try {
            const plugins = await client.get<any[]>("/wp/v2/plugins", { context: "edit" });
            payload.plugins = {
              total: plugins.data.length,
              active: plugins.data.filter((p: any) => p.status !== "inactive").length,
              active_list: plugins.data.filter((p: any) => p.status !== "inactive")
                .map((p: any) => ({ plugin: p.plugin, name: stripHtml(String(p.name ?? "")), version: p.version })),
              inactive_list: plugins.data.filter((p: any) => p.status === "inactive")
                .map((p: any) => ({ plugin: p.plugin, name: stripHtml(String(p.name ?? "")), version: p.version })),
            };
          } catch (e: any) { unavailable.push(`plugin inventory (${e.message} — needs an Administrator account)`); }
        }

        if (hasHelper) {
          try {
            const info = await client.get<any>(`/${ns}/site-info`, { include_health: include_health ? 1 : 0 });
            Object.assign(payload, info.data);
          } catch (e: any) { unavailable.push(`companion diagnostics (${e.message})`); }
        } else {
          unavailable.push("PHP version, database size, direct Site Health checks and update availability (install the wpxmcp companion plugin to see these)");
        }

        if (include_health) {
          try {
            const routes = (await client.discovery()).routes;
            const tests = CORE_HEALTH_TESTS.filter((name) => routes.includes(`/wp-site-health/v1/tests/${name}`));
            if (tests.length) {
              const settled = await Promise.allSettled(tests.map((name) => client.request<any>(`/wp-site-health/v1/tests/${name}`, { timeoutMs: 30_000 })));
              const issues: any[] = [];
              const passed: string[] = [];
              const failed: string[] = [];
              settled.forEach((r, i) => {
                if (r.status === "rejected") { failed.push(`${tests[i]} (${r.reason?.message ?? r.reason})`); return; }
                const t = r.value.data ?? {};
                if (t.status === "good") passed.push(tests[i]);
                else issues.push({ test: tests[i], status: t.status, label: stripHtml(String(t.label ?? "")), detail: trimText(stripHtml(String(t.description ?? "")), 500) });
              });
              payload.site_health_async = { issue_count: issues.length, issues, passed, could_not_run: failed.length ? failed : undefined };
            }
          } catch (e: any) { unavailable.push(`core Site Health tests (${e.message})`); }
        }

        try {
          const types = await client.postTypes();
          const counts: Record<string, number | null> = {};
          for (const [name, t] of Object.entries<any>(types)) {
            if (["attachment", "wp_block", "wp_template", "wp_template_part", "wp_navigation", "wp_global_styles", "wp_font_family", "wp_font_face"].includes(name)) continue;
            try {
              const res = await client.get(`/${t.rest_namespace || "wp/v2"}/${t.rest_base}`, { per_page: 1, status: "any", context: "edit" });
              counts[name] = res.total ?? null;
            } catch { counts[name] = null; }
          }
          payload.content_counts = counts;
        } catch { /* non-fatal */ }

        if (unavailable.length) payload.not_available = unavailable;
        return ok(payload);
      },
    }),

    defineTool({
      name: "get_page_html",
      title: "Get rendered page HTML",
      readOnly: true,
      description:
        "Fetch the fully rendered HTML that a visitor receives for any URL on the configured site (other hosts, and redirects to them, are refused), so you can verify that a change actually appears on the front end rather than trusting the API's word for it. Returns the server-rendered HTML — content injected later by JavaScript will not appear. Optionally extracts just the SEO-relevant head tags or the visible text.",
      schema: {
        site_id: siteIdSchema,
        url: z.string().optional().default("/").describe("Path or full URL to fetch, e.g. \"/about/\"."),
        mode: z.enum(["html", "text", "head", "summary"]).optional().default("summary")
          .describe("html: the raw markup. text: visible text only. head: title/meta/OG tags. summary: head tags plus headings, links and image alt coverage."),
        max_chars: z.number().int().min(1).optional().default(30000).describe("Truncate the response at this many characters."),
        preview_token: z.string().optional().describe("Token from get_preview_url, to render a draft theme instead of the live one."),
      },
      handler: async ({ site_id, url, mode, max_chars, preview_token }) => {
        const client = site(site_id);
        const start = resolveSiteUrl(client.site.url, url);
        if (preview_token) start.searchParams.set("wpxmcp_preview", preview_token);
        const target = start.toString();

        // Redirects are followed by hand so each hop can be checked: a page on the
        // site that redirects to another host (or an internal address) must not
        // turn this into a proxy for fetching it.
        const timeoutMs = client.site.timeoutMs ?? 60_000;
        let current = start;
        let res: Response;
        let blockedRedirect: string | undefined;
        let hops = 0;
        try {
          for (;;) {
            res = await fetch(current, {
              headers: { "User-Agent": "wpxmcp/2.0 (page inspector)", Accept: "text/html", ...(client.site.headers ?? {}) },
              redirect: "manual",
              signal: AbortSignal.timeout(timeoutMs),
            });
            const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
            if (!location) break;
            const next = new URL(location, current);
            if (!isSameSite(client.site.url, next) || hops >= MAX_REDIRECTS) {
              blockedRedirect = next.toString();
              break;
            }
            await res.body?.cancel().catch(() => undefined);
            current = next;
            hops++;
          }
        } catch (e: any) {
          if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new Error(`Fetching ${current} timed out after ${timeoutMs}ms.`);
          throw new Error(`Could not fetch ${current}: ${e?.cause?.code ?? e?.message ?? String(e)}.`);
        }

        if (blockedRedirect) {
          await res!.body?.cancel().catch(() => undefined);
          return ok({ url: target, final_url: current.toString(), status: res!.status, redirected: hops > 0, redirect_not_followed: blockedRedirect },
            hops >= MAX_REDIRECTS
              ? `Stopped after ${MAX_REDIRECTS} redirects — the site is probably in a redirect loop.`
              : "The site redirected to a different host, which get_page_html does not follow. Check the site URL in the config (www vs bare domain), or the redirect rules on the site.");
        }

        const body = await readCapped(res!, MAX_PAGE_BYTES);
        const html = body.text;

        const base = {
          url: target,
          final_url: current.toString(),
          status: res!.status,
          content_type: res!.headers.get("content-type"),
          bytes: body.bytes,
          body_truncated_at_bytes: body.truncated ? MAX_PAGE_BYTES : undefined,
          redirected: hops > 0,
        };

        if (mode === "html") return ok({ ...base, html: trimText(html, max_chars) });
        if (mode === "text") return ok({ ...base, text: trimText(stripHtml(html), max_chars) });

        const head = {
          title: /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim(),
          meta_description: /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1],
          canonical: /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i.exec(html)?.[1],
          robots: /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1],
          og_title: /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1],
          og_description: /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1],
          og_image: /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1],
          viewport: /<meta[^>]+name=["']viewport["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1],
          lang: /<html[^>]+lang=["']([^"']*)["']/i.exec(html)?.[1],
        };
        if (mode === "head") return ok({ ...base, head });

        const headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)]
          .map((m) => ({ level: Number(m[1]), text: stripHtml(m[2]).slice(0, 160) }))
          .filter((h) => h.text);
        const images = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
        const imagesMissingAlt = images.filter((tag) => !/\balt\s*=\s*["'][^"']+["']/i.test(tag)).length;

        return ok({
          ...base,
          head,
          h1_count: headings.filter((h) => h.level === 1).length,
          headings: headings.slice(0, 60),
          image_count: images.length,
          images_missing_alt: imagesMissingAlt,
          script_count: (html.match(/<script\b/gi) ?? []).length,
          stylesheet_count: (html.match(/<link[^>]+rel=["']stylesheet["']/gi) ?? []).length,
          generator: /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1],
          notes: [
            "This is the server-rendered HTML. Anything a JavaScript framework injects on the client will not appear here.",
            headings.filter((h) => h.level === 1).length !== 1
              ? `This page has ${headings.filter((h) => h.level === 1).length} h1 elements; exactly one is the usual convention.`
              : null,
            imagesMissingAlt > 0 ? `${imagesMissingAlt} of ${images.length} images have no alt text.` : null,
          ].filter(Boolean),
        });
      },
    }),

    defineTool({
      name: "search_site",
      title: "Search across the site",
      readOnly: true,
      description: "Search every searchable content type at once using WordPress's own search index, returning what type each hit belongs to. Broader than list_content's per-type search.",
      schema: {
        site_id: siteIdSchema,
        query: z.string().describe("What to search for."),
        type: z.enum(["post", "term", "post-format"]).optional().default("post").describe("Search content, taxonomy terms, or post formats."),
        subtype: z.string().optional().describe("Restrict to one post type or taxonomy."),
        per_page: z.number().int().min(1).max(100).optional().default(20).describe("Results per page."),
        page: z.number().int().min(1).optional().default(1).describe("Which page of results to return."),
      },
      handler: async ({ site_id, query, type, subtype, per_page, page }) => {
        const client = site(site_id);
        const res = await client.get<any[]>("/wp/v2/search", { search: query, type, subtype, per_page, page });
        return ok({
          site: client.site.id, query, total: res.total ?? res.data.length, page,
          results: res.data.map((r: any) => ({ id: r.id, title: stripHtml(String(r.title ?? "")), url: r.url, type: r.type, subtype: r.subtype })),
        });
      },
    }),

    defineTool({
      name: "list_revisions",
      title: "List content revisions",
      readOnly: true,
      description: "List the stored revisions of a piece of content, so you can see what changed and when — and recover a previous version if an edit went wrong.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("Content ID."),
        type: z.string().optional().default("post").describe("Content type of that ID."),
        per_page: z.number().int().min(1).max(100).optional().default(20).describe("How many revisions to return, newest first."),
      },
      handler: async ({ site_id, id, type, per_page }) => {
        const client = site(site_id);
        const route = await contentRoute(client, type);
        const res = await client.get<any[]>(`${route}/${id}/revisions`, { per_page, context: "edit" });
        return ok({
          content_id: id, type, count: res.data.length,
          revisions: res.data.map((r: any) => ({
            id: r.id, author: r.author, date: r.date, modified: r.modified,
            title: stripHtml(unwrap(r.title)), content_length: unwrap(r.content).length,
            excerpt_preview: stripHtml(unwrap(r.content)).slice(0, 200),
          })),
        });
      },
    }),

    defineTool({
      name: "restore_revision",
      title: "Restore a revision",
      description: "Restore a piece of content to an earlier revision. The current version is itself saved as a revision first, so this is reversible.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("Content ID."),
        revision_id: z.number().int().describe("Revision ID to restore, from list_revisions."),
        type: z.string().optional().default("post").describe("Content type of that ID."),
      },
      handler: async ({ site_id, id, revision_id, type }) => {
        const client = site(site_id);
        client.assertWritable("restore_revision");
        const route = await contentRoute(client, type);
        const revision = await client.get<any>(`${route}/${id}/revisions/${revision_id}`, { context: "edit" });
        const res = await client.post<any>(`${route}/${id}`, {
          title: unwrap(revision.data.title),
          content: unwrap(revision.data.content),
          excerpt: unwrap(revision.data.excerpt),
        });
        audit({ site: client.site.id, tool: "restore_revision", action: "restore", target: id, outcome: "ok", detail: `revision ${revision_id}` });
        return ok({ restored: true, content_id: id, from_revision: revision_id, modified: res.data.modified },
          "The version that was live before this restore was saved as a new revision, so you can undo it the same way.");
      },
    }),

    defineTool({
      name: "get_content_meta",
      title: "Read custom fields",
      readOnly: true,
      description:
        "Read the custom fields (post meta) on a content item, including keys that are not registered with show_in_rest and therefore invisible to get_content. Needs the companion plugin to see unregistered keys. Values over 20,000 characters are truncated unless the key is requested by name in `keys`.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("Content ID."),
        keys: z.array(z.string()).optional().describe("Only these meta keys. Omit for everything."),
        include_protected: z.boolean().optional().default(false).describe("Include underscore-prefixed internal keys, which plugins use for their own state."),
      },
      handler: async ({ site_id, id, keys, include_protected }) => {
        const client = site(site_id);
        const ns = client.site.helperNamespace ?? "wpxmcp/v1";
        if (await client.hasHelperPlugin()) {
          const res = await client.get<any>(`/${ns}/meta`, { post_id: id, keys: keys?.join(","), include_protected: include_protected ? 1 : 0 });
          return ok({ content_id: id, source: "companion plugin (all keys)", ...res.data });
        }
        const types = await client.postTypes();
        for (const t of Object.values<any>(types)) {
          try {
            const res = await client.get<any>(`/${t.rest_namespace || "wp/v2"}/${t.rest_base}/${id}`, { context: "edit" });
            return ok({ content_id: id, source: "core REST (registered keys only)", meta: res.data.meta ?? {} },
              "Only meta registered with show_in_rest is visible. Install the companion plugin to read every key.");
          } catch { /* try the next type */ }
        }
        throw new Error(`Could not find content with id ${id} in any REST-exposed post type.`);
      },
    }),

    defineTool({
      name: "set_content_meta",
      title: "Write custom fields",
      description:
        "Write custom fields (post meta) on a content item, including keys not registered with show_in_rest — which core REST refuses to write. Needs the companion plugin. Values are stored as standard post meta, so they survive if this tooling is removed.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("Content ID."),
        meta: z.record(z.string(), z.any()).describe("Key/value pairs to write. A null value deletes the key."),
      },
      handler: async ({ site_id, id, meta }) => {
        const client = site(site_id);
        client.assertWritable("set_content_meta");
        const ns = client.site.helperNamespace ?? "wpxmcp/v1";
        if (!(await client.hasHelperPlugin())) {
          throw new Error("Writing arbitrary meta keys needs the wpxmcp companion plugin — core REST only accepts keys registered with show_in_rest. Install it, or pass registered keys via update_content's `meta` argument.");
        }
        const res = await client.post<any>(`/${ns}/meta`, { post_id: id, meta });
        audit({ site: client.site.id, tool: "set_content_meta", action: "write meta", target: id, outcome: "ok", detail: Object.keys(meta).join(",") });
        return ok({ updated: true, content_id: id, ...res.data });
      },
    }),

    defineTool({
      name: "rest_api",
      title: "Call any REST endpoint",
      description:
        "Call any WordPress REST endpoint directly — the escape hatch for anything the dedicated tools do not cover, including routes registered by plugins such as WooCommerce, Yoast or ACF. Use discover_rest_routes first to find valid routes rather than guessing: an invented route returns rest_no_route and tells you nothing.",
      schema: {
        site_id: siteIdSchema,
        route: z.string().describe("Route including its namespace, e.g. \"/wc/v3/orders\" or \"/wp/v2/posts/12\"."),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().default("GET").describe("HTTP method. Anything other than GET counts as a write and needs a writable site."),
        query: z.record(z.string(), z.any()).optional().describe("Query string parameters."),
        body: z.record(z.string(), z.any()).optional().describe("JSON request body for write methods."),
        max_chars: z.number().int().min(100).optional().default(40000).describe("Truncate the response at this many characters."),
      },
      handler: async ({ site_id, route, method, query, body, max_chars }) => {
        const client = site(site_id);
        const effective = effectiveRestMethod(method, route, query);
        const writes = effective !== "GET" && effective !== "HEAD";
        if (writes) client.assertWritable(`rest_api ${effective} ${route}`);
        const res = await client.request<any>(route, { method, query, body });
        if (writes) {
          audit({ site: client.site.id, tool: "rest_api", action: `${effective} ${route}`, target: route, outcome: "ok" });
        }
        // Truncate structurally, never by slicing the serialised JSON: cutting a
        // string mid-token produces something that cannot be parsed back.
        const serialised = JSON.stringify(res.data) ?? "null";
        let data: unknown = res.data;
        let truncation: string | undefined;

        if (serialised.length > max_chars) {
          if (Array.isArray(res.data)) {
            // Keep whole elements until the budget is spent.
            const kept: unknown[] = [];
            let used = 2;
            for (const item of res.data) {
              const size = JSON.stringify(item).length + 1;
              if (used + size > max_chars) break;
              kept.push(item);
              used += size;
            }
            data = kept;
            truncation = `Response held ${res.data.length} items; ${kept.length} are shown. Narrow the query, or raise max_chars.`;
          } else {
            data = undefined;
            truncation = `Response was ${serialised.length} characters, above max_chars (${max_chars}), and is not an array so it could not be trimmed by element. A preview is in \`data_preview\`; raise max_chars to receive it in full.`;
          }
        }

        return ok({
          route, method, status: res.status,
          total: res.total, total_pages: res.totalPages,
          truncation,
          data,
          data_preview: data === undefined ? trimText(serialised, max_chars) : undefined,
        });
      },
    }),

    defineTool({
      name: "discover_rest_routes",
      title: "Discover REST routes",
      readOnly: true,
      description:
        "List the REST namespaces and routes the site actually registers, including those added by plugins. Use this before rest_api so you call routes that exist — WordPress route shapes vary between plugin versions and guessing wastes calls.",
      schema: {
        site_id: siteIdSchema,
        namespace: z.string().optional().describe("Show routes under one namespace only, e.g. \"wc/v3\"."),
        search: z.string().optional().describe("Filter routes by substring."),
      },
      handler: async ({ site_id, namespace, search }) => {
        const client = site(site_id);
        const res = await client.get<any>(namespace ? `/${namespace}` : "/");
        const routes = Object.entries<any>(res.data?.routes ?? {});
        const filtered = routes
          .filter(([path]) => !search || path.toLowerCase().includes(search.toLowerCase()))
          .map(([path, def]) => ({
            route: path,
            methods: [...new Set((def.methods ?? []).flat())],
            args: def.endpoints?.[0]?.args ? Object.keys(def.endpoints[0].args).slice(0, 25) : undefined,
          }));
        return ok({
          site: client.site.id,
          namespaces: res.data?.namespaces ?? undefined,
          namespace_filter: namespace,
          route_count: filtered.length,
          routes: filtered.slice(0, 400),
        });
      },
    }),
  ];
}
