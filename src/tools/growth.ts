import { z } from "zod";
import { defineTool, ok, siteIdSchema, stripHtml, unwrap, wordCount, type ToolContext, type ToolSpec } from "../lib/tooling.js";
import type { WordPressClient } from "../lib/client.js";
import { WPError } from "../lib/errors.js";
import { audit, issueConfirmation, consumeConfirmation, fingerprintOp } from "../lib/safety.js";
import { platform } from "../lib/platform.js";
import { resolveUrl } from "../lib/content-utils.js";
import { resolveType, routeFor } from "./content.js";
import { resolveSiteUrl, isSameSite } from "./site.js";
import { checkDownloadUrl, assertResolvesPublic } from "./media.js";
import { readCapped } from "../lib/http-utils.js";
import {
  SEO_META_KEYS, SEO_PLUGINS, aioseoPostBody, buildSeoMetaWrite, compareSeo, detectSeoPlugin, metaKeysFor, normalizeYoastHead,
  parseHead, readSeoMeta, schemaTypesFrom, yoastCollectionHeadsTrustworthy, type NormalizedSeo, type SeoFields, type SeoPlugin,
} from "../lib/growth-seo.js";
import {
  analyzeRobots, buildLinkGraph, contentKey, decodeCursor, encodeCursor, extractLinks, isInternalUrl, isoWeek, mapLimit,
  parseWpDate, slugFromUrl, sortBySeverity, suggestLinks, toCsv, weekSeries, worstSeverity,
  type FleetIssue, type GraphItem, type Severity,
} from "../lib/growth-links.js";

/* ------------------------------------------------------------------ *
 * HTTP helpers (front-end fetches, not REST)
 * ------------------------------------------------------------------ */

const UA = "wpxmcp/2.0 (site auditor)";
const MAX_REDIRECTS = 5;
const SKIP_TYPES = new Set(["attachment", "nav_menu_item", "wp_block", "wp_template", "wp_template_part", "wp_navigation", "wp_global_styles", "wp_font_family", "wp_font_face"]);


interface PageFetch {
  url: string;
  final_url: string;
  status: number;
  hops: number;
  content_type: string | null;
  text: string;
  ms: number;
  blocked_redirect?: string;
  location?: string | null;
}

/**
 * Fetches a page on the configured site, following redirects by hand and only
 * while they stay on the same host (same rules as get_page_html).
 */
async function fetchSitePage(client: WordPressClient, input: string, opts: { maxBytes?: number; timeoutMs?: number; follow?: boolean } = {}): Promise<PageFetch> {
  const start = resolveSiteUrl(client.site.url, input);
  const timeoutMs = opts.timeoutMs ?? Math.min(client.site.timeoutMs ?? 30_000, 30_000);
  const began = Date.now();
  let current = start;
  let hops = 0;
  let res: Response;
  let blocked: string | undefined;
  try {
    for (;;) {
      res = await fetch(current.toString(), {
        headers: { "User-Agent": UA, Accept: "text/html,text/plain,application/xml;q=0.9,*/*;q=0.8", ...(client.site.headers ?? {}) },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location || opts.follow === false) break;
      const next = new URL(location, current);
      if (!isSameSite(client.site.url, next) || hops >= MAX_REDIRECTS) { blocked = next.toString(); break; }
      await res.body?.cancel().catch(() => undefined);
      current = next;
      hops++;
    }
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new Error(`Fetching ${current} timed out after ${timeoutMs}ms.`);
    throw new Error(`Could not fetch ${current}: ${e?.cause?.code ?? e?.message ?? String(e)}.`);
  }
  const location = res!.status >= 300 && res!.status < 400 ? res!.headers.get("location") : null;
  const body = blocked || location ? { text: "", truncated: false } : await readCapped(res!, opts.maxBytes ?? 1024 * 1024);
  if (blocked || location) await res!.body?.cancel().catch(() => undefined);
  return {
    url: start.toString(), final_url: current.toString(), status: res!.status, hops,
    content_type: res!.headers.get("content-type"), text: body.text, ms: Date.now() - began,
    blocked_redirect: blocked, location,
  };
}

interface LinkCheck {
  url: string;
  status: number | null;
  final_url: string;
  redirects: Array<{ url: string; status: number }>;
  error?: string;
  blocked?: string;
  requests: number;
}

/** HEAD first, GET when HEAD is refused or errors; redirects followed by hand, every hop re-validated. */
async function checkLink(url: string, env: { siteUrl: string; siteHeaders?: Record<string, string>; timeoutMs: number; allowPrivate: boolean }): Promise<LinkCheck> {
  const redirects: LinkCheck["redirects"] = [];
  let current = url;
  let requests = 0;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const internal = isInternalUrl(env.siteUrl, current);
    if (!internal && !env.allowPrivate) {
      try {
        // The resolve check closes DNS rebinding: a public name pointing at an internal address.
        await assertResolvesPublic(checkDownloadUrl(current));
      } catch {
        return { url, status: null, final_url: current, redirects, blocked: "private, loopback or local-network address — not checked", requests };
      }
    }
    const headers: Record<string, string> = { "User-Agent": UA, Accept: "*/*", ...(internal ? env.siteHeaders ?? {} : {}) };
    let res: Response | undefined;
    let lastError: any;
    for (const method of ["HEAD", "GET"] as const) {
      requests++;
      try {
        res = await fetch(current, { method, headers, redirect: "manual", signal: AbortSignal.timeout(env.timeoutMs) });
        await res.body?.cancel().catch(() => undefined);
        // Many servers mishandle HEAD (405, 403, even 404); confirm failures with GET.
        if (method === "HEAD" && res.status >= 400 && res.status !== 410) continue;
        break;
      } catch (e: any) {
        lastError = e;
        res = undefined;
        if (e?.name === "TimeoutError" || e?.name === "AbortError") break;
      }
    }
    if (!res) {
      const msg = lastError?.name === "TimeoutError" || lastError?.name === "AbortError" ? `timed out after ${env.timeoutMs}ms` : String(lastError?.cause?.code ?? lastError?.message ?? lastError);
      return { url, status: null, final_url: current, redirects, error: msg, requests };
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return { url, status: res.status, final_url: current, redirects, requests };
    redirects.push({ url: current, status: res.status });
    try {
      current = new URL(location, current).toString();
    } catch {
      return { url, status: res.status, final_url: current, redirects, error: `invalid Location header "${location}"`, requests };
    }
  }
  return { url, status: null, final_url: current, redirects, error: `more than ${MAX_REDIRECTS} redirects (loop?)`, requests };
}

/* ------------------------------------------------------------------ *
 * WordPress helpers
 * ------------------------------------------------------------------ */

async function loadItem(client: WordPressClient, id: number, type?: string): Promise<{ item: any; type: string; route: string }> {
  if (type) {
    const t = await resolveType(client, type);
    const res = await client.get<any>(`${t.route}/${id}`, { context: "edit" });
    return { item: res.data, type: t.name, route: t.route };
  }
  const types = await client.postTypes();
  const order = ["post", "page", ...Object.keys(types).filter((n) => n !== "post" && n !== "page" && !SKIP_TYPES.has(n))];
  for (const name of order) {
    const t = types[name];
    if (!t?.rest_base) continue;
    const route = routeFor(t.rest_namespace, t.rest_base);
    try {
      const res = await client.get<any>(`${route}/${id}`, { context: "edit" });
      return { item: res.data, type: name, route };
    } catch (e) {
      if (e instanceof WPError && e.status !== 404 && e.status !== 400) throw e;
    }
  }
  throw new Error(`No content with id ${id} was found in any REST-exposed post type. Pass \`type\` if it belongs to a custom type.`);
}

async function detectPlugin(client: WordPressClient): Promise<ReturnType<typeof detectSeoPlugin> & { routes: string[]; namespaces: string[] }> {
  const d = await client.discovery();
  let detection = detectSeoPlugin(d.namespaces);
  if (!detection.plugin) {
    try {
      const plugins = await client.get<any[]>("/wp/v2/plugins", { _fields: "plugin,status" });
      detection = detectSeoPlugin(d.namespaces, Array.isArray(plugins.data) ? plugins.data : []);
    } catch { /* not an administrator — namespaces are all we have */ }
  }
  return { ...detection, routes: d.routes, namespaces: d.namespaces };
}

async function readRawMeta(client: WordPressClient, id: number, keys: string[], item: any): Promise<{ meta: Record<string, unknown>; source: string }> {
  const ns = client.site.helperNamespace ?? "wpxmcp/v1";
  if (await client.hasHelperPlugin()) {
    try {
      const res = await client.get<any>(`/${ns}/meta`, { post_id: id, keys: keys.join(",") });
      return { meta: res.data?.meta ?? {}, source: "companion plugin" };
    } catch { /* fall through to core */ }
  }
  const visible: Record<string, unknown> = {};
  for (const k of keys) if (item?.meta && k in item.meta) visible[k] = item.meta[k];
  return { meta: visible, source: "core REST (only keys registered with show_in_rest are visible)" };
}

const hasTemplateVars = (s: unknown) => typeof s === "string" && /%%?[a-z_]+%%?/i.test(s);

function looseNormalize(obj: any): Partial<NormalizedSeo> {
  if (!obj || typeof obj !== "object") return {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v) return v;
    }
    return null;
  };
  const robots = typeof obj.robots === "string" ? obj.robots : obj.robots && typeof obj.robots === "object" ? Object.values(obj.robots).join(", ") : null;
  return {
    title: pick("title", "og:title"),
    description: pick("description"),
    canonical: pick("canonical_url", "canonical"),
    robots: robots ? { noindex: /noindex/i.test(robots), nofollow: /nofollow/i.test(robots), raw: robots } : undefined,
    schema_types: obj.schema ? schemaTypesFrom([obj.schema]) : undefined,
  } as Partial<NormalizedSeo>;
}

/** What the plugin itself reports it will output, from whatever its REST surface offers. */
async function readPluginHead(client: WordPressClient, plugin: SeoPlugin | null, item: any, routes: string[], notes: string[]): Promise<Partial<NormalizedSeo> | null> {
  if (!plugin) return null;
  try {
    switch (plugin) {
      case "yoast": {
        if (item?.yoast_head_json) return normalizeYoastHead(item.yoast_head_json);
        if (routes.includes("/yoast/v1/get_head") && item?.link) {
          const res = await client.get<any>("/yoast/v1/get_head", { url: item.link });
          return normalizeYoastHead(res.data?.json) ?? (res.data?.html ? parseHead(res.data.html) : null);
        }
        notes.push("No yoast_head_json on this item — Yoast is inactive, or its REST head output is disabled — so only stored overrides are shown.");
        return null;
      }
      case "rank-math": {
        if (routes.includes("/rankmath/v1/getHead") && item?.link) {
          const res = await client.get<any>("/rankmath/v1/getHead", { url: item.link });
          if (typeof res.data?.head === "string") return parseHead(res.data.head);
        }
        notes.push("Rank Math's getHead route is unavailable — enable \"Headless CMS Support\" in Rank Math → General Settings → Others to expose it.");
        return null;
      }
      case "aioseo": {
        if (item?.aioseo_head_json) return looseNormalize(item.aioseo_head_json);
        if (typeof item?.aioseo_head === "string") return parseHead(item.aioseo_head);
        notes.push("AIOSEO exposes no aioseo_head_json on this item; enable its REST API output (AIOSEO → Settings → Advanced) to see computed values.");
        return null;
      }
      case "seopress": {
        const r = routes.find((x) => x.startsWith("/seopress/v1/posts/") && x.endsWith("/title-description-metas"));
        if (r && item?.id) {
          const res = await client.get<any>(`/seopress/v1/posts/${item.id}/title-description-metas`);
          return looseNormalize(res.data);
        }
        return null;
      }
      case "seo-framework":
        return null;
    }
  } catch (e: any) {
    notes.push(`Could not read ${plugin}'s computed head: ${e.message}`);
  }
  return null;
}

/* ------------------------------------------------------------------ */

const seoPluginSchema = z.enum(SEO_PLUGINS as [SeoPlugin, ...SeoPlugin[]]);

export function growthTools(ctx: ToolContext): Array<ToolSpec<any>> {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);
  const allowPrivate = () => {
    try { return platform().env.WPX_ALLOW_PRIVATE_URLS === "true"; } catch { return false; }
  };

  return [
    /* ---------------------------- get_seo_meta ---------------------------- */
    defineTool({
      name: "get_seo_meta",
      title: "Get SEO metadata",
      readOnly: true,
      description:
        "Read the SEO metadata for one piece of content (by id or URL), normalized across Yoast, Rank Math, AIOSEO, SEOPress and The SEO Framework: title, description, focus keyword, canonical, robots, Open Graph and schema types. Detects the active plugin, shows the per-item overrides it stores, and compares them with what the rendered page actually emits — a mismatch usually means page caching or a theme override. Works without an SEO plugin too (reports what WordPress core renders).",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().optional().describe("Content ID. Give either id or url."),
        type: z.string().optional().describe("Content type of the id (post, page, a custom type). Omit to search post, page and then other types."),
        url: z.string().optional().describe("Front-end path or URL on the site, e.g. \"/about/\". Resolved to its content where possible; the site root is audited as the homepage."),
        plugin: seoPluginSchema.optional().describe("Force which SEO plugin's fields to read, when detection misses it (e.g. REST namespaces hidden by a security plugin)."),
        compare_rendered: z.boolean().optional().default(true).describe("Fetch the public page and compare its <head> with the stored values. Skipped automatically for unpublished content."),
      },
      handler: async ({ site_id, id, type, url, plugin, compare_rendered }) => {
        const client = site(site_id);
        if (id === undefined && !url) throw new Error("Pass either `id` or `url`.");
        const notes: string[] = [];
        const detection = await detectPlugin(client);
        const active = plugin ?? detection.plugin;
        if (plugin && plugin !== detection.plugin) notes.push(`Using ${plugin} as requested; detection found ${detection.plugin ?? "no SEO plugin"}.`);

        let item: any = null;
        let typeName: string | undefined;
        let pageUrl: string | undefined = url;
        if (id !== undefined) {
          const loaded = await loadItem(client, id, type);
          item = loaded.item;
          typeName = loaded.type;
          pageUrl = pageUrl ?? item.link;
        } else if (url) {
          const target = resolveSiteUrl(client.site.url, url);
          const isRoot = target.pathname.replace(/\/+$/, "") === "" && !target.searchParams.has("p") && !target.searchParams.has("page_id");
          if (!isRoot) {
            const r = await resolveUrl(client, target.toString());
            if (r.found && r.id) {
              const loaded = await loadItem(client, r.id, r.type);
              item = loaded.item;
              typeName = loaded.type;
            } else {
              notes.push(`"${url}" did not resolve to a content item (${r.notes.join(" ")}); only the rendered page is reported.`);
            }
          } else {
            notes.push("This is the homepage; its SEO title/description come from the plugin's homepage settings (or Settings → General when there is no SEO plugin).");
          }
        }

        const keys = active ? metaKeysFor(active) : [];
        let overrides: Record<string, unknown> | undefined;
        let overridesSource: string | undefined;
        let normalizedOverrides: any;
        if (item && active) {
          const raw = await readRawMeta(client, item.id, keys, item);
          overrides = raw.meta;
          overridesSource = raw.source;
          normalizedOverrides = readSeoMeta(active, raw.meta);
        }

        const pluginHead = item ? await readPluginHead(client, active, item, detection.routes, notes) : null;
        const stored = {
          title: pluginHead?.title ?? (hasTemplateVars(normalizedOverrides?.title) ? null : normalizedOverrides?.title) ?? null,
          description: pluginHead?.description ?? (hasTemplateVars(normalizedOverrides?.description) ? null : normalizedOverrides?.description) ?? null,
          focus_keyword: normalizedOverrides?.focus_keyword ?? null,
          canonical: pluginHead?.canonical ?? normalizedOverrides?.canonical ?? null,
          robots: pluginHead?.robots ?? (typeof normalizedOverrides?.noindex === "boolean" || typeof normalizedOverrides?.nofollow === "boolean"
            ? { noindex: normalizedOverrides.noindex === true, nofollow: normalizedOverrides.nofollow === true, raw: null } : null),
          og: pluginHead?.og ?? null,
          schema_types: pluginHead?.schema_types ?? null,
        };

        let rendered: NormalizedSeo | null = null;
        let mismatches: ReturnType<typeof compareSeo> | undefined;
        let renderInfo: any;
        const publiclyVisible = !item || item.status === "publish";
        if (compare_rendered && pageUrl && publiclyVisible) {
          try {
            const page = await fetchSitePage(client, pageUrl);
            renderInfo = { url: page.final_url, status: page.status, redirected: page.hops > 0 || undefined, blocked_redirect: page.blocked_redirect };
            if (page.status >= 200 && page.status < 300) {
              rendered = parseHead(page.text);
              mismatches = active ? compareSeo(stored as any, rendered) : [];
              if (!active && !rendered.description) notes.push("No SEO plugin is active, so WordPress core prints no meta description, canonical on archives, Open Graph or schema. Install one to control these.");
            } else {
              notes.push(`The page answered HTTP ${page.status}, so its head could not be compared.`);
            }
          } catch (e: any) {
            notes.push(`Rendered page not fetched: ${e.message}`);
          }
        } else if (compare_rendered && !publiclyVisible) {
          notes.push(`Status is "${item?.status}", so there is no public page to compare against.`);
        }

        if (active && overrides && Object.values(overrides).every((v) => v === "" || v === null || v === undefined)) {
          notes.push("No per-item overrides are stored, so the plugin's templates/defaults apply.");
        }

        return ok({
          site: client.site.id,
          id: item?.id, type: typeName, status: item?.status, link: item?.link ?? pageUrl,
          seo_plugin: { active, detected: detection.plugin, detected_via: detection.detected_via, also_active: detection.also_active },
          stored,
          overrides: overrides ? { source: overridesSource, meta: overrides } : undefined,
          rendered: rendered ?? undefined,
          rendered_fetch: renderInfo,
          mismatches: mismatches?.length ? mismatches : mismatches ? [] : undefined,
          warnings: detection.also_active ? [`Several SEO plugins are active (${[detection.plugin, ...detection.also_active].join(", ")}); they will print duplicate or conflicting tags.`] : undefined,
          notes: notes.length ? notes : undefined,
        });
      },
    }),

    /* ---------------------------- set_seo_meta ---------------------------- */
    defineTool({
      name: "set_seo_meta",
      title: "Set SEO metadata",
      destructive: true,
      description:
        "Set the SEO title, meta description, focus keyword, canonical URL and robots noindex/nofollow for one content item, written the way the active SEO plugin expects: its own REST route where one exists (Rank Math updateMeta, AIOSEO, SEOPress), otherwise its post meta keys via core REST (when registered) or the companion plugin's meta route. Always previews first: the initial call shows before → after and returns a confirm_token; re-run with the token to write. Refuses when no SEO plugin is active, because WordPress core would ignore the values.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("Content ID to update."),
        type: z.string().optional().describe("Content type of the id. Omit to search post, page and then other types."),
        title: z.string().optional().describe("SEO title. Plugin template variables (%%title%% for Yoast, %title% for Rank Math) are passed through. Empty string clears the override."),
        description: z.string().optional().describe("Meta description; ~140–160 characters reads best in results. Empty string clears the override."),
        focus_keyword: z.string().optional().describe("Focus keyphrase used by the plugin's content analysis. Not supported by The SEO Framework."),
        canonical: z.string().optional().describe("Absolute canonical URL. Empty string clears the override so the plugin's default applies."),
        noindex: z.boolean().optional().describe("true asks search engines not to index this item; false explicitly allows indexing."),
        nofollow: z.boolean().optional().describe("true asks search engines not to follow links on this item."),
        plugin: seoPluginSchema.optional().describe("Force the target plugin when detection misses it. Writing a plugin's keys while that plugin is inactive has no visible effect."),
        confirm_token: z.string().optional().describe("Token from the preview call. Omit to preview; pass it back unchanged with identical arguments to apply."),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        client.assertWritable("set_seo_meta");
        const fields: SeoFields = {};
        for (const k of ["title", "description", "focus_keyword", "canonical", "noindex", "nofollow"] as const) {
          if (args[k] !== undefined) (fields as any)[k] = args[k];
        }
        if (!Object.keys(fields).length) throw new Error("Nothing to set — pass at least one of title, description, focus_keyword, canonical, noindex, nofollow.");
        if (fields.canonical) {
          try {
            const u = new URL(fields.canonical);
            if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
          } catch {
            throw new Error(`canonical must be an absolute http(s) URL, got "${fields.canonical}".`);
          }
        }

        const detection = await detectPlugin(client);
        const plugin = args.plugin ?? detection.plugin;
        if (!plugin) {
          throw new Error(
            "No SEO plugin is active on this site, so there is nowhere for these values to go — WordPress core has no per-item meta description, canonical or robots fields and would ignore them. Install and activate an SEO plugin (Yoast SEO, Rank Math, AIOSEO, SEOPress or The SEO Framework), or pass `plugin` if one is active but was not detected."
          );
        }

        const { item, type: typeName, route } = await loadItem(client, args.id, args.type);
        const keys = metaKeysFor(plugin);
        const current = await readRawMeta(client, item.id, keys, item);
        const { meta, unsupported } = buildSeoMetaWrite(plugin, fields, current.meta);
        const hasHelper = await client.hasHelperPlugin();
        const ns = client.site.helperNamespace ?? "wpxmcp/v1";
        const routes = detection.routes;

        type Step = { via: string; method: "POST" | "PUT"; route: string; body: Record<string, unknown>; keys: string[] };
        const steps: Step[] = [];
        const metaFallback = (m: Record<string, unknown>) => {
          const ks = Object.keys(m);
          if (!ks.length) return;
          const registered = item.meta && typeof item.meta === "object" && !Array.isArray(item.meta) && ks.every((k) => k in item.meta);
          if (registered) steps.push({ via: "core REST meta (keys registered with show_in_rest)", method: "POST", route: `${route}/${item.id}`, body: { meta: m }, keys: ks });
          else if (hasHelper) steps.push({ via: "companion plugin meta route", method: "POST", route: `/${ns}/meta`, body: { post_id: item.id, meta: m }, keys: ks });
          else {
            throw new Error(
              `${plugin}'s meta keys (${ks.join(", ")}) are not registered with show_in_rest on this site, so core REST cannot write them. Install the wpxmcp companion plugin (its /${ns}/meta route writes any key), or register the keys with register_post_meta(..., ['show_in_rest' => true]).`
            );
          }
        };

        if (plugin === "rank-math" && routes.includes("/rankmath/v1/updateMeta")) {
          steps.push({ via: "Rank Math REST route", method: "POST", route: "/rankmath/v1/updateMeta", body: { objectType: "post", objectID: item.id, meta }, keys: Object.keys(meta) });
        } else if (plugin === "aioseo") {
          if (!routes.includes("/aioseo/v1/post")) {
            throw new Error("AIOSEO keeps its data in its own table (wp_aioseo_posts), so post meta writes are ignored, and its /aioseo/v1/post REST route is not registered here. Update this item in the editor's AIOSEO panel instead.");
          }
          steps.push({ via: "AIOSEO REST route", method: "POST", route: "/aioseo/v1/post", body: aioseoPostBody(item.id, fields), keys: Object.keys(fields) });
        } else if (plugin === "seopress" && routes.some((r) => r.startsWith("/seopress/v1/posts/") && r.endsWith("/title-description-metas")) && (fields.title !== undefined || fields.description !== undefined)) {
          const body: Record<string, unknown> = {};
          if (fields.title !== undefined) body.title = fields.title;
          if (fields.description !== undefined) body.description = fields.description;
          steps.push({ via: "SEOPress REST route", method: "PUT", route: `/seopress/v1/posts/${item.id}/title-description-metas`, body, keys: ["_seopress_titles_title", "_seopress_titles_desc"].filter((_, i) => (i === 0 ? fields.title : fields.description) !== undefined) });
          const rest = { ...meta };
          delete rest._seopress_titles_title;
          delete rest._seopress_titles_desc;
          metaFallback(rest);
        } else {
          metaFallback(meta);
        }

        const before = readSeoMeta(plugin, current.meta) as any;
        const changes = Object.entries(fields).map(([field, to]) => ({
          field, key: (SEO_META_KEYS[plugin] as any)[field] ?? null, from: before[field] ?? null, to,
        }));
        const warnings: string[] = [];
        if (unsupported.length) warnings.push(`${plugin} has no per-item field for: ${unsupported.join(", ")} — those values are not written.`);
        if (args.plugin && args.plugin !== detection.plugin) warnings.push(`Writing ${args.plugin} keys although detection found ${detection.plugin ?? "no SEO plugin"}; they only take effect while ${args.plugin} is active.`);
        if (fields.description && fields.description.length > 160) warnings.push(`The description is ${fields.description.length} characters; results usually truncate around 155–160.`);
        if (fields.title && fields.title.length > 60 && !hasTemplateVars(fields.title)) warnings.push(`The title is ${fields.title.length} characters; results usually truncate past ~60.`);
        if (fields.noindex === true && item.status === "publish") warnings.push("noindex on published content removes it from search results once crawled.");
        if (current.source.startsWith("core")) warnings.push("Current values were read from core REST, which only sees registered keys — `from` may show null for values that do exist.");

        const fingerprint = fingerprintOp(["set_seo_meta", client.site.id, item.id, typeName, plugin, fields, item.modified_gmt ?? item.modified, steps]);
        if (!args.confirm_token) {
          const token = await issueConfirmation(client.site.id, `set SEO meta on ${typeName} ${item.id}`, fingerprint);
          audit({ site: client.site.id, tool: "set_seo_meta", action: "preview", target: item.id, outcome: "dry-run", detail: Object.keys(fields).join(",") });
          return ok({
            applied: false, dry_run: true, id: item.id, type: typeName, title: stripHtml(unwrap(item.title)), plugin,
            changes, plan: steps.map((s) => ({ via: s.via, method: s.method, route: s.route, keys: s.keys })),
            warnings: warnings.length ? warnings : undefined, confirm_token: token,
          }, "Nothing was written. Review the changes, then re-run the identical call with this confirm_token to apply them (valid 10 minutes).");
        }

        const check = await consumeConfirmation(args.confirm_token, fingerprint);
        if (!check.valid) {
          return ok({ applied: false, refused: true, reason: check.reason },
            "The confirmation was not accepted, so nothing was written. If the arguments are unchanged, the item changed since the preview — re-run without confirm_token for a fresh preview.");
        }

        const results: any[] = [];
        for (const step of steps) {
          try {
            await client.request(step.route, { method: step.method, body: step.body });
            results.push({ via: step.via, route: step.route, ok: true });
          } catch (e: any) {
            results.push({ via: step.via, route: step.route, ok: false, error: e.message });
          }
        }
        const failed = results.filter((r) => !r.ok).length;
        audit({ site: client.site.id, tool: "set_seo_meta", action: "apply", target: item.id, outcome: failed ? "error" : "ok", detail: `${plugin}: ${Object.keys(fields).join(",")}` });
        let after: any;
        try {
          const refreshed = await loadItem(client, item.id, typeName);
          after = readSeoMeta(plugin, (await readRawMeta(client, item.id, keys, refreshed.item)).meta);
        } catch { /* reporting only */ }
        return ok({ applied: failed === 0, id: item.id, plugin, results, after, warnings: warnings.length ? warnings : undefined },
          failed ? "Some writes failed — see results." : "Written. Run get_seo_meta to confirm the rendered page picked it up; a page cache may need purging first.");
      },
    }),

    /* ---------------------------- seo_site_check ---------------------------- */
    defineTool({
      name: "seo_site_check",
      title: "Site-level SEO check",
      readOnly: true,
      description:
        "Check the site-wide SEO fundamentals in one call: \"Discourage search engines\" (blog_public), robots.txt content and whether it blocks everything, sitemap reachability (core wp-sitemap.xml or the SEO plugin's index), homepage title/description/canonical/Open Graph, plain vs pretty permalinks, HTTPS and the http→https redirect, and duplicate titles across recent published content. Each check reports pass/warn/fail with a concrete fix.",
      schema: {
        site_id: siteIdSchema,
        sample_size: z.number().int().min(10).max(300).optional().default(100).describe("How many recent published posts and pages to scan for duplicate titles."),
      },
      handler: async ({ site_id, sample_size }) => {
        const client = site(site_id);
        const checks: Array<{ check: string; status: "pass" | "warn" | "fail" | "info"; detail: string; data?: unknown }> = [];
        const add = (check: string, status: "pass" | "warn" | "fail" | "info", detail: string, data?: unknown) => checks.push({ check, status, detail, data });
        const hasHelper = await client.hasHelperPlugin().catch(() => false);
        const ns = client.site.helperNamespace ?? "wpxmcp/v1";
        const root = (await client.get<any>("/")).data ?? {};
        const detection = await detectPlugin(client);
        add("SEO plugin", detection.plugin ? (detection.also_active ? "warn" : "pass") : "warn",
          detection.plugin
            ? `${detection.plugin} (${detection.detected_via})${detection.also_active ? `; also active: ${detection.also_active.join(", ")} — more than one SEO plugin prints duplicate tags` : ""}.`
            : "No SEO plugin detected. Core WordPress prints a title and a basic sitemap but no meta descriptions, Open Graph or schema.");

        let options: Record<string, any> | null = null;
        if (hasHelper) {
          try { options = (await client.get<any>(`/${ns}/options`, { names: "blog_public,permalink_structure" })).data?.options ?? null; } catch { /* not admin */ }
        }

        // Homepage
        let home: ReturnType<typeof parseHead> | null = null;
        try {
          const page = await fetchSitePage(client, "/");
          if (page.blocked_redirect) add("Homepage", "warn", `The homepage redirects off the configured host to ${page.blocked_redirect}. Set the site URL in the MCP config to the address WordPress answers on.`);
          else if (page.status >= 400) add("Homepage", "fail", `The homepage answered HTTP ${page.status}.`);
          else {
            home = parseHead(page.text);
            add("Homepage title", home.title ? (home.title.length > 65 ? "warn" : "pass") : "fail", home.title ? `"${home.title}" (${home.title.length} chars)${home.title.length > 65 ? " — likely truncated in results" : ""}.` : "No <title> in the homepage head — the theme may lack title-tag support.");
            add("Homepage meta description", home.description ? "pass" : "warn", home.description ? `"${home.description.slice(0, 160)}"` : "No meta description on the homepage. Set it in the SEO plugin's homepage settings.");
            add("Homepage canonical", home.canonical ? "pass" : "info", home.canonical ? home.canonical : "No rel=canonical on the homepage (core only prints canonicals on single content; SEO plugins add it).");
            const ogMissing = [["og:title", home.og.title], ["og:description", home.og.description], ["og:image", home.og.image]].filter(([, v]) => !v).map(([k]) => k);
            add("Homepage Open Graph", ogMissing.length ? "warn" : "pass", ogMissing.length ? `Missing ${ogMissing.join(", ")} — shared links will render without a proper preview.` : "og:title, og:description and og:image present.");
            if (home.schema_types.length) add("Structured data", "pass", `Homepage JSON-LD types: ${home.schema_types.join(", ")}.`);
            else add("Structured data", "info", "No JSON-LD on the homepage.");
          }
        } catch (e: any) {
          add("Homepage", "fail", `Could not fetch the homepage: ${e.message}`);
        }

        // Search engine visibility
        if (options && "blog_public" in options) {
          const pub = String(options.blog_public) !== "0";
          add("Search engine visibility", pub ? "pass" : "fail", pub ? "\"Discourage search engines from indexing this site\" is off (blog_public = 1)." : "\"Discourage search engines from indexing this site\" is ON (blog_public = 0) — the whole site is noindexed. Untick it in Settings → Reading before launch.");
        } else if (home) {
          add("Search engine visibility", home.robots.noindex ? "fail" : "pass",
            home.robots.noindex ? `The homepage emits robots "${home.robots.raw}". Usually Settings → Reading → "Discourage search engines" is ticked.` : "The homepage does not emit noindex (blog_public read from the rendered page; the setting itself needs the companion plugin).");
        }
        if (home && options && String(options.blog_public) !== "0" && home.robots.noindex) {
          add("Homepage robots", "fail", `blog_public is on, but the homepage still emits "${home.robots.raw}" — the SEO plugin's homepage settings or a theme is forcing noindex.`);
        }

        // robots.txt
        let robots: ReturnType<typeof analyzeRobots> | null = null;
        for (const candidate of ["/robots.txt", "/?robots=1"]) {
          try {
            const page = await fetchSitePage(client, candidate, { maxBytes: 128 * 1024 });
            const looksPlain = page.status === 200 && !/^\s*</.test(page.text) && (/text\/plain/i.test(page.content_type ?? "") || /user-agent\s*:/i.test(page.text));
            if (!looksPlain) continue;
            robots = analyzeRobots(page.text);
            add("robots.txt", robots.blocks_all ? "fail" : "pass",
              robots.blocks_all ? `robots.txt disallows "/" for every crawler (${candidate}). Remove the "Disallow: /" line under "User-agent: *".` : `Served at ${candidate}; no site-wide block.${robots.sitemaps.length ? "" : " It declares no Sitemap: line."}`,
              { disallow_for_all: robots.disallows_for_all, sitemaps: robots.sitemaps, content: page.text.slice(0, 1500) });
            break;
          } catch { /* try next */ }
        }
        if (!robots) add("robots.txt", "warn", "robots.txt could not be read (neither /robots.txt nor /?robots=1 returned plain text). A physical file, a server rule or a security plugin may be intercepting it.");

        // Sitemap
        const abs = (u: string) => { try { return new URL(u, client.site.url.replace(/\/+$/, "") + "/").toString(); } catch { return u; } };
        const sitemapCandidates = [...new Set([
          ...(robots?.sitemaps ?? []),
          ...(detection.plugin === "yoast" || detection.plugin === "rank-math" ? ["/sitemap_index.xml", "/?sitemap=1"] : []),
          ...(detection.plugin === "aioseo" || detection.plugin === "seopress" ? ["/sitemap.xml", "/sitemaps.xml"] : []),
          "/wp-sitemap.xml", "/?sitemap=index",
        ].map(abs))].slice(0, 6);
        let sitemapFound: string | null = null;
        const sitemapTried: Array<{ url: string; result: string; is_sitemap: boolean }> = [];
        for (const candidate of sitemapCandidates) {
          try {
            const page = await fetchSitePage(client, candidate, { maxBytes: 256 * 1024 });
            const isSitemap = page.status === 200 && /<(urlset|sitemapindex)\b/i.test(page.text);
            sitemapTried.push({ url: candidate, result: page.blocked_redirect ? "off-site redirect" : `HTTP ${page.status}${page.status === 200 && !isSitemap ? " (not XML sitemap)" : ""}`, is_sitemap: isSitemap });
            if (isSitemap) { sitemapFound = page.final_url; break; }
          } catch (e: any) {
            sitemapTried.push({ url: candidate, result: e.message.slice(0, 80), is_sitemap: false });
          }
        }
        const brokenDeclared = (robots?.sitemaps ?? []).map(abs).filter((u) => sitemapTried.some((t) => t.url === u && !t.is_sitemap));
        add("XML sitemap", sitemapFound ? (brokenDeclared.length ? "warn" : "pass") : "fail", sitemapFound ? `Reachable at ${sitemapFound}.${robots && !robots.sitemaps.length ? " Add a Sitemap: line to robots.txt so crawlers find it." : ""}${brokenDeclared.length ? ` But robots.txt declares ${brokenDeclared.join(", ")}, which does not answer — crawlers follow that line (on plain permalinks, pretty sitemap URLs 404).` : ""}` : "No XML sitemap answered. Core sitemaps are disabled when blog_public is 0 or a plugin turns them off; enable one in the SEO plugin.", { tried: sitemapTried });

        // Permalinks
        let pretty: boolean | null = null;
        if (options && "permalink_structure" in options) pretty = Boolean(options.permalink_structure);
        const recent = await client.getAll<any>("/wp/v2/posts", { status: "publish", _fields: "id,link,title,yoast_head_json", orderby: "date", order: "desc" }, Math.ceil(sample_size / 2)).catch(() => [] as any[]);
        if (pretty === null && recent.length) pretty = !/[?&]p=\d+/.test(recent[0].link ?? "");
        if (pretty !== null) add("Permalinks", pretty ? "pass" : "warn", pretty ? `Pretty permalinks${options?.permalink_structure ? ` (${options.permalink_structure})` : ""}.` : "Plain permalinks (?p=123). Choose \"Post name\" in Settings → Permalinks — and plan redirects if the site is already indexed.");

        // HTTPS
        const siteUrl = new URL(client.site.url);
        const homeUrl = typeof root.home === "string" ? root.home : client.site.url;
        if (siteUrl.protocol === "https:") {
          let detail = "The site is served over HTTPS.";
          let status: "pass" | "warn" = "pass";
          if (!siteUrl.port) {
            try {
              const httpUrl = new URL(client.site.url);
              httpUrl.protocol = "http:";
              const res = await fetch(httpUrl.toString(), { method: "GET", redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
              await res.body?.cancel().catch(() => undefined);
              const loc = res.headers.get("location") ?? "";
              if (res.status >= 300 && res.status < 400 && loc.startsWith("https:")) detail += ` http:// redirects to https:// (HTTP ${res.status}).`;
              else { status = "warn"; detail += ` But http:// answered HTTP ${res.status} without redirecting to https:// — add a site-wide 301.`; }
            } catch (e: any) { detail += ` (http:// variant not reachable: ${e.message})`; }
          }
          if (homeUrl.startsWith("http:")) { status = "warn"; detail += ` WordPress's home URL is still ${homeUrl} — update Settings → General so links and canonicals use https.`; }
          add("HTTPS", status, detail);
        } else {
          add("HTTPS", "warn", `The site is served over plain HTTP (${client.site.url}). Browsers mark it "Not secure" and HTTPS is a ranking signal — install a certificate and redirect.`);
        }

        // Duplicate titles
        const pages = await client.getAll<any>("/wp/v2/pages", { status: "publish", _fields: "id,link,title,yoast_head_json", orderby: "date", order: "desc" }, Math.floor(sample_size / 2)).catch(() => [] as any[]);
        const titleMap = new Map<string, Array<{ id: number; link: string }>>();
        const trustYoast = yoastCollectionHeadsTrustworthy(recent) && yoastCollectionHeadsTrustworthy(pages);
        for (const it of [...recent, ...pages]) {
          const t = String((trustYoast ? it.yoast_head_json?.title : null) ?? stripHtml(unwrap(it.title))).trim();
          if (!t) continue;
          const key = t.toLowerCase();
          if (!titleMap.has(key)) titleMap.set(key, []);
          titleMap.get(key)!.push({ id: it.id, link: it.link });
        }
        const dupes = [...titleMap.entries()].filter(([, v]) => v.length > 1).map(([title, items]) => ({ title, items })).slice(0, 25);
        add("Duplicate titles", dupes.length ? "warn" : "pass", dupes.length ? `${dupes.length} title(s) shared by more than one published item among the ${recent.length + pages.length} scanned.` : `No duplicates among ${recent.length + pages.length} recent published posts and pages.${trustYoast ? "" : " (Compared post titles: Yoast returned the same SEO head for every item in the list, which it does when the REST request is routed through the front page.)"}`, dupes.length ? dupes : undefined);

        const counts = { fail: 0, warn: 0, pass: 0, info: 0 };
        for (const c of checks) counts[c.status]++;
        return ok({ site: client.site.id, url: client.site.url, summary: counts, overall: counts.fail ? "fail" : counts.warn ? "needs attention" : "pass", checks });
      },
    }),

    /* ---------------------------- check_links ---------------------------- */
    defineTool({
      name: "check_links",
      title: "Check for broken links",
      readOnly: true,
      description:
        "Find broken links and images in rendered content: 4xx/5xx and network failures, redirect chains, http:// links on an https site (mixed content), and internal links to draft, trashed or missing content. Scans given ids, a content type, or one front-end URL. Internal links only by default; external checks are opt-in and never reach private or loopback addresses. Checks run with bounded concurrency and are capped per call — follow next_cursor for the rest (each checked link costs 1–2 outbound requests, which matters on Cloudflare Workers).",
      schema: {
        site_id: siteIdSchema,
        ids: z.array(z.number().int()).max(50).optional().describe("Content IDs to scan (of `type`). Takes precedence over the type-wide scan."),
        type: z.string().optional().default("post").describe("Content type to scan when no ids or url are given, and the type of `ids`."),
        url: z.string().optional().describe("Scan a single front-end page on the site instead (whole rendered page, including menus and footer)."),
        status: z.string().optional().default("publish").describe("Which content status to scan in a type-wide scan."),
        limit: z.number().int().min(1).max(100).optional().default(20).describe("How many content items to extract links from in a type-wide scan (most recent first)."),
        include_external: z.boolean().optional().default(false).describe("Also check links to other hosts. Private, loopback and link-local hosts are always skipped."),
        include_images: z.boolean().optional().default(true).describe("Also check <img src> URLs."),
        max_links: z.number().int().min(1).max(500).optional().default(150).describe("Maximum distinct URLs to check in this call; the rest are reachable via next_cursor."),
        concurrency: z.number().int().min(1).max(10).optional().default(6).describe("How many URLs to check at once."),
        timeout_ms: z.number().int().min(1000).max(30000).optional().default(10000).describe("Per-request timeout."),
        cursor: z.string().optional().describe("next_cursor from a previous call with the same arguments, to continue where it stopped."),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        const siteUrl = client.site.url;
        const siteHttps = siteUrl.startsWith("https:");
        const notes: string[] = [];
        const sources = new Map<string, { url: string; kind: "a" | "img"; found_in: Set<string | number> }>();
        const addLinks = (html: string, base: string, from: string | number) => {
          for (const l of extractLinks(html, base, { images: args.include_images })) {
            const entry = sources.get(l.url) ?? { url: l.url, kind: l.kind, found_in: new Set() };
            entry.found_in.add(from);
            sources.set(l.url, entry);
          }
        };

        let scanned = 0;
        if (args.url) {
          const page = await fetchSitePage(client, args.url, { maxBytes: 2 * 1024 * 1024 });
          if (page.status >= 400) notes.push(`The page itself answered HTTP ${page.status}.`);
          addLinks(page.text, page.final_url, page.final_url);
          scanned = 1;
        } else {
          const t = await resolveType(client, args.type);
          let items: any[];
          if (args.ids?.length) {
            const settled = await mapLimit(args.ids, 4, (id) => client.get<any>(`${t.route}/${id}`, { context: "edit", _fields: "id,link,status,content" }));
            items = settled.flatMap((r, i) => {
              if (r.status === "fulfilled") return [r.value.data];
              notes.push(`id ${args.ids![i]}: ${(r.reason as any)?.message ?? r.reason}`);
              return [];
            });
          } else {
            items = await client.getAll<any>(t.route, { status: args.status, context: "edit", _fields: "id,link,status,content", orderby: "date", order: "desc" }, args.limit);
          }
          for (const it of items) addLinks(it.content?.rendered ?? unwrap(it.content), it.link || siteUrl, it.id);
          scanned = items.length;
        }

        const all = [...sources.values()];
        const external = all.filter((l) => !isInternalUrl(siteUrl, l.url));
        const candidates = args.include_external ? all : all.filter((l) => isInternalUrl(siteUrl, l.url));
        const state = decodeCursor<{ o: number }>(args.cursor) ?? { o: 0 };
        const slice = candidates.slice(state.o, state.o + args.max_links);
        const env = { siteUrl, siteHeaders: client.site.headers, timeoutMs: args.timeout_ms, allowPrivate: allowPrivate() };
        const settled = await mapLimit(slice, args.concurrency, (l) => checkLink(l.url, env));

        const broken: any[] = [];
        const redirects: any[] = [];
        const blocked: any[] = [];
        const mixed: any[] = [];
        let okCount = 0;
        let requests = 0;
        slice.forEach((l, i) => {
          const r = settled[i];
          const found_in = [...l.found_in].slice(0, 10);
          if (siteHttps && l.url.startsWith("http:")) mixed.push({ url: l.url, kind: l.kind, found_in, note: l.kind === "img" ? "Browsers block or warn on http images on https pages." : "Link uses http:// on an https site." });
          if (r.status === "rejected") { broken.push({ url: l.url, kind: l.kind, error: String((r.reason as any)?.message ?? r.reason), found_in }); return; }
          const c = r.value;
          requests += c.requests;
          if (c.blocked) { blocked.push({ url: l.url, reason: c.blocked, found_in }); return; }
          const internal = isInternalUrl(siteUrl, l.url);
          if (c.error || c.status === null || c.status >= 400) {
            broken.push({ url: l.url, kind: l.kind, internal, status: c.status, error: c.error, final_url: c.redirects.length ? c.final_url : undefined, found_in });
            return;
          }
          okCount++;
          if (c.redirects.length) redirects.push({ url: l.url, kind: l.kind, final_url: c.final_url, hops: c.redirects.length, chain: c.redirects.map((h) => h.status), found_in, fix: "Update the link to the final URL to save a round trip." });
        });

        // Why is an internal link broken? Look the target up: draft, trash, private, or gone.
        const lookups = broken.filter((b) => b.internal && b.kind === "a" && !/\/wp-(content|includes|admin)\//.test(b.url) && (b.status === 404 || b.status === 401 || b.status === 403 || b.status === 410)).slice(0, 15);
        await mapLimit(lookups, 3, async (b) => {
          const key = contentKey(b.url);
          const types = await client.postTypes();
          const candidatesTypes = ["post", "page", ...Object.keys(types).filter((n) => !["post", "page"].includes(n) && !SKIP_TYPES.has(n))].slice(0, 6);
          for (const name of candidatesTypes) {
            const td = types[name];
            if (!td?.rest_base) continue;
            const route = routeFor(td.rest_namespace, td.rest_base);
            try {
              if (key.startsWith("id:")) {
                const res = await client.get<any>(`${route}/${key.slice(3)}`, { context: "edit", _fields: "id,status,link" });
                b.target = { id: res.data.id, type: name, status: res.data.status };
                break;
              }
              const slug = slugFromUrl(b.url)?.replace(/__trashed$/, "");
              if (!slug) break;
              const res = await client.get<any[]>(route, { slug: `${slug},${slug}__trashed`, status: "any", context: "edit", _fields: "id,status,link", per_page: 1 });
              if (res.data?.[0]) { b.target = { id: res.data[0].id, type: name, status: res.data[0].status }; break; }
            } catch { /* not in this type */ }
          }
          b.reason = b.target ? `links to ${b.target.status} content (${b.target.type} ${b.target.id})` : "no matching content — deleted, or a slug that changed without a redirect";
        });

        for (const b of broken) if (b.internal && !b.reason && (b.kind === "img" || /\/wp-content\//.test(b.url))) b.reason = "file missing — deleted from the media library or uploads folder";
        const next = state.o + slice.length < candidates.length ? encodeCursor({ o: state.o + slice.length }) : undefined;
        if (!args.include_external && external.length) notes.push(`${external.length} external URL(s) were not checked; pass include_external: true to check them.`);
        return ok({
          site: client.site.id,
          scanned_sources: scanned,
          urls_found: all.length,
          checked: slice.length,
          range: slice.length ? `${state.o + 1}–${state.o + slice.length} of ${candidates.length}` : `0 of ${candidates.length}`,
          outbound_requests: requests,
          summary: { ok: okCount, broken: broken.length, redirected: redirects.length, mixed_content: mixed.length, skipped_private: blocked.length },
          broken,
          internal_unpublished: broken.filter((b) => b.target && b.target.status !== "publish"),
          redirects: redirects.slice(0, 100),
          mixed_content: mixed.slice(0, 100),
          skipped: blocked.length ? blocked.slice(0, 30) : undefined,
          next_cursor: next,
          notes: notes.length ? notes : undefined,
        }, next ? `More URLs remain — call again with cursor "${next}" and the same arguments.` : undefined);
      },
    }),

    /* ---------------------------- internal_link_report ---------------------------- */
    defineTool({
      name: "internal_link_report",
      title: "Internal link report",
      readOnly: true,
      description:
        "Build the internal link graph across published content and report orphans (nothing links to them), dead ends (they link to nothing), links pointing at drafts/private/trashed items, and link suggestions: related pairs (shared categories/tags and title keywords) with no link between them. Read-only — suggestions only; add links with update_content. Based on content bodies, so menu, widget and archive links are not counted.",
      schema: {
        site_id: siteIdSchema,
        types: z.array(z.string()).min(1).max(6).optional().default(["post", "page"]).describe("Content types to include in the graph."),
        limit: z.number().int().min(2).max(1000).optional().default(300).describe("Maximum published items to load across all types (most recent first). The graph is only as complete as this."),
        max_suggestions: z.number().int().min(0).max(100).optional().default(30).describe("How many link suggestions to return."),
        max_rows: z.number().int().min(1).max(200).optional().default(50).describe("Maximum rows in each list (orphans, dead ends, and so on)."),
      },
      handler: async ({ site_id, types, limit, max_suggestions, max_rows }) => {
        const client = site(site_id);
        const taxes = await client.taxonomies();
        const items: GraphItem[] = [];
        const others: Array<{ id: number; status: string; link?: string; slug?: string }> = [];
        const truncated: string[] = [];
        for (const typeArg of types) {
          const remaining = limit - items.length;
          if (remaining <= 0) { truncated.push(typeArg); continue; }
          const t = await resolveType(client, typeArg);
          const taxFields = (t.info?.taxonomies ?? []).map((tx: string) => taxes[tx]?.rest_base).filter(Boolean);
          const rows = await client.getAll<any>(t.route, { status: "publish", context: "edit", orderby: "date", order: "desc", _fields: ["id", "status", "link", "slug", "title", "content", ...taxFields].join(",") }, remaining);
          if (rows.length >= remaining) truncated.push(t.name);
          for (const r of rows) {
            items.push({
              id: r.id, type: t.name, status: r.status, title: stripHtml(unwrap(r.title)), link: r.link, slug: r.slug,
              html: r.content?.raw ?? r.content?.rendered ?? "",
              terms: taxFields.flatMap((f: string) => (Array.isArray(r[f]) ? r[f].map((x: number) => x * 10 + taxFields.indexOf(f)) : [])),
            });
          }
          try {
            const rest = await client.getAll<any>(t.route, { status: "draft,pending,private,future,trash", context: "edit", _fields: "id,status,link,slug" }, 300);
            others.push(...rest);
          } catch { /* needs edit rights */ }
        }

        const graph = buildLinkGraph(client.site.url, items, others);
        const byId = new Map(items.map((i) => [i.id, i]));
        const row = (id: number) => { const i = byId.get(id)!; return { id, type: i.type, title: i.title, link: i.link }; };

        // Terms carried by most items (the default category, a catch-all tag) say nothing about relatedness.
        const freq = new Map<number, number>();
        for (const i of items) for (const t of new Set(i.terms)) freq.set(t, (freq.get(t) ?? 0) + 1);
        const common = items.length >= 10 ? [...freq.entries()].filter(([, n]) => n / items.length > 0.4).map(([t]) => t) : [];

        const orphans = items.filter((i) => (graph.inbound.get(i.id)?.size ?? 0) === 0);
        const deadEnds = items.filter((i) => (graph.outbound.get(i.id)?.size ?? 0) === 0);
        const suggestions = suggestLinks(items, graph, { max: max_suggestions, ignoreTerms: common }).map((s) => ({
          from: row(s.from), to: row(s.to), score: s.score, why: [
            s.shared_keywords.length ? `title keywords: ${s.shared_keywords.join(", ")}` : null,
            s.shared_terms ? `${s.shared_terms} shared term(s)` : null,
            (graph.inbound.get(s.to)?.size ?? 0) === 0 ? "target is an orphan" : null,
          ].filter(Boolean).join("; "),
        }));
        const hubs = items.map((i) => ({ ...row(i.id), inbound: graph.inbound.get(i.id)?.size ?? 0 })).filter((h) => h.inbound > 0).sort((a, b) => b.inbound - a.inbound).slice(0, 10);
        const unresolvedGrouped = new Map<string, number[]>();
        for (const u of graph.unresolved) {
          if (!unresolvedGrouped.has(u.url)) unresolvedGrouped.set(u.url, []);
          unresolvedGrouped.get(u.url)!.push(u.from);
        }
        const totalLinks = [...graph.outbound.values()].reduce((n, s) => n + s.size, 0);

        return ok({
          site: client.site.id,
          items: items.length,
          internal_links: totalLinks,
          avg_outbound: items.length ? Math.round((totalLinks / items.length) * 10) / 10 : 0,
          summary: { orphans: orphans.length, dead_ends: deadEnds.length, links_to_unpublished: graph.toUnpublished.length, unresolved_internal_urls: unresolvedGrouped.size, suggestions: suggestions.length },
          orphans: orphans.slice(0, max_rows).map((i) => row(i.id)),
          dead_ends: deadEnds.slice(0, max_rows).map((i) => row(i.id)),
          links_to_unpublished: graph.toUnpublished.slice(0, max_rows).map((l) => ({ from: row(l.from), url: l.url, target_id: l.target, target_status: l.target_status })),
          unresolved_internal_urls: [...unresolvedGrouped.entries()].slice(0, max_rows).map(([url, from]) => ({ url, from: [...new Set(from)].slice(0, 10) })),
          top_linked: hubs,
          suggestions,
          notes: [
            truncated.length ? `The item limit (${limit}) was reached while loading ${truncated.join(", ")}, so some items are missing and inbound counts are understated — raise limit for a complete graph.` : null,
            "Only links inside content bodies are counted; items linked from menus, widgets or archive pages can still appear as orphans.",
            unresolvedGrouped.size ? "Unresolved URLs are internal links matching no scanned item: archives, media, content outside the scanned types — or genuinely missing pages (check_links confirms)." : null,
          ].filter(Boolean),
        });
      },
    }),

    /* ---------------------------- content_inventory ---------------------------- */
    defineTool({
      name: "content_inventory",
      title: "Content inventory",
      readOnly: true,
      description:
        "Export a content inventory — one row per item with id, type, status, URL, title, word count, published and modified dates, author name, term names, whether it has a featured image, and the SEO title/description when Yoast exposes them. JSON or CSV, with field selection and cursor pagination, for content audits, migrations and spreadsheets.",
      schema: {
        site_id: siteIdSchema,
        types: z.array(z.string()).min(1).max(10).optional().default(["post", "page"]).describe("Content types to include, in order."),
        status: z.string().optional().default("publish").describe("Status filter: publish, draft, pending, private, future, or \"any\"."),
        fields: z.array(z.enum(["id", "type", "status", "url", "title", "slug", "words", "published", "modified", "author", "terms", "featured_image", "seo_title", "seo_description"]))
          .optional().describe("Columns to include, in order. Omit for all. Leaving out words, terms and author makes each page cheaper to build."),
        format: z.enum(["json", "csv"]).optional().default("json").describe("json rows, or a CSV document with a header row."),
        per_page: z.number().int().min(1).max(100).optional().default(100).describe("Rows per call."),
        cursor: z.string().optional().describe("next_cursor from the previous call, to fetch the next rows."),
      },
      handler: async ({ site_id, types, status, fields, format, per_page, cursor }) => {
        const client = site(site_id);
        const columns = fields?.length ? fields : ["id", "type", "status", "url", "title", "slug", "words", "published", "modified", "author", "terms", "featured_image", "seo_title", "seo_description"];
        const want = new Set(columns);
        const taxes = await client.taxonomies();
        let state = decodeCursor<{ t: number; o: number }>(cursor) ?? { t: 0, o: 0 };
        const raw: Array<{ item: any; type: string; taxFields: Array<{ field: string; route: string }> }> = [];
        let totalForType: Record<string, number | undefined> = {};
        let requests = 0;

        while (raw.length < per_page && state.t < types.length && requests < 6) {
          const t = await resolveType(client, types[state.t]);
          const taxFields = (t.info?.taxonomies ?? []).map((tx: string) => taxes[tx]).filter((x: any) => x?.rest_base)
            .map((x: any) => ({ field: x.rest_base, route: routeFor(x.rest_namespace, x.rest_base) }));
          const f = ["id", "status", "link", "title", "slug", "date", "modified", "author", "featured_media", "yoast_head_json"];
          if (want.has("words")) f.push("content");
          if (want.has("terms")) f.push(...taxFields.map((x: { field: string }) => x.field));
          const take = per_page - raw.length;
          const res = await client.get<any[]>(t.route, { status, context: "edit", per_page: take, offset: state.o, orderby: "id", order: "asc", _fields: f.join(",") });
          requests++;
          const batch = Array.isArray(res.data) ? res.data : [];
          totalForType[t.name] = res.total;
          for (const item of batch) raw.push({ item, type: t.name, taxFields });
          state = { t: state.t, o: state.o + batch.length };
          if (batch.length < take || (res.total !== undefined && state.o >= res.total)) state = { t: state.t + 1, o: 0 };
        }

        const authors = new Map<number, string>();
        if (want.has("author")) {
          const ids = [...new Set(raw.map((r) => r.item.author).filter(Boolean))];
          if (ids.length) {
            try {
              const res = await client.get<any[]>("/wp/v2/users", { include: ids.join(","), per_page: 100, context: "edit", _fields: "id,name" });
              for (const u of res.data ?? []) authors.set(u.id, u.name);
            } catch {
              try {
                const res = await client.get<any[]>("/wp/v2/users", { include: ids.join(","), per_page: 100, _fields: "id,name" });
                for (const u of res.data ?? []) authors.set(u.id, u.name);
              } catch { /* ids only */ }
            }
          }
        }
        const termNames = new Map<string, string>();
        if (want.has("terms")) {
          const byRoute = new Map<string, Set<number>>();
          for (const r of raw) for (const tf of r.taxFields) {
            for (const id of Array.isArray(r.item[tf.field]) ? r.item[tf.field] : []) {
              if (!byRoute.has(tf.route)) byRoute.set(tf.route, new Set());
              byRoute.get(tf.route)!.add(id);
            }
          }
          for (const [route, idSet] of byRoute) {
            const ids = [...idSet];
            for (let i = 0; i < ids.length && i < 300; i += 100) {
              try {
                const res = await client.get<any[]>(route, { include: ids.slice(i, i + 100).join(","), per_page: 100, _fields: "id,name" });
                for (const term of res.data ?? []) termNames.set(`${route}#${term.id}`, stripHtml(String(term.name ?? "")));
              } catch { /* taxonomy not readable */ }
            }
          }
        }

        const trustYoast = yoastCollectionHeadsTrustworthy(raw.map((r) => r.item));
        const rows = raw.map(({ item, type, taxFields }) => {
          const full: Record<string, unknown> = {
            id: item.id, type, status: item.status, url: item.link, title: stripHtml(unwrap(item.title)), slug: item.slug,
            words: want.has("words") ? wordCount(unwrap(item.content)) : undefined,
            published: item.date, modified: item.modified,
            author: authors.get(item.author) ?? item.author,
            terms: taxFields.flatMap((tf) => (Array.isArray(item[tf.field]) ? item[tf.field] : []).map((id: number) => termNames.get(`${tf.route}#${id}`) ?? String(id))),
            featured_image: Boolean(item.featured_media),
            seo_title: trustYoast ? item.yoast_head_json?.title ?? null : null,
            seo_description: trustYoast ? item.yoast_head_json?.description ?? null : null,
          };
          const out: Record<string, unknown> = {};
          for (const c of columns) out[c] = full[c];
          return out;
        });

        const next = state.t < types.length ? encodeCursor(state) : undefined;
        const seoNote = !trustYoast && (want.has("seo_title") || want.has("seo_description"))
          ? "seo_title/seo_description are blank: Yoast returned one identical head for every item in the list (it builds it from the front page on ?rest_route= sites). Use get_seo_meta per item for real values."
          : undefined;
        if (format === "csv") {
          const header = `rows: ${rows.length}${next ? ` · next_cursor: ${next}` : " · end of inventory"}${seoNote ? ` · ${seoNote}` : ""}`;
          return ok(toCsv(columns, rows), header);
        }
        return ok({ site: client.site.id, status, count: rows.length, totals: totalForType, columns, rows, next_cursor: next, note: seoNote });
      },
    }),

    /* ---------------------------- content_calendar ---------------------------- */
    defineTool({
      name: "content_calendar",
      title: "Content calendar",
      readOnly: true,
      description:
        "Editorial calendar view: scheduled (future) content grouped by ISO week, publishing cadence per week over the last N weeks, stale drafts not touched in N days, and gaps against a target posts-per-week. Useful for content teams planning what to publish next.",
      schema: {
        site_id: siteIdSchema,
        types: z.array(z.string()).min(1).max(5).optional().default(["post"]).describe("Content types to include."),
        weeks_back: z.number().int().min(1).max(52).optional().default(12).describe("How many past weeks of publishing cadence to report (including the current week)."),
        weeks_ahead: z.number().int().min(1).max(26).optional().default(8).describe("How many upcoming weeks to lay out (including the current week)."),
        stale_draft_days: z.number().int().min(1).max(3650).optional().default(30).describe("A draft or pending item not modified for this many days is reported as stale."),
        target_per_week: z.number().min(0).max(100).optional().describe("Desired items per week. When set, weeks below it are reported as gaps."),
      },
      handler: async ({ site_id, types, weeks_back, weeks_ahead, stale_draft_days, target_per_week }) => {
        const client = site(site_id);
        const now = new Date();
        const iso = (d: Date) => d.toISOString().slice(0, 19);
        const scheduled: any[] = [];
        const published: any[] = [];
        const drafts: any[] = [];
        const notes: string[] = [];
        const since = new Date(now.getTime() - weeks_back * 7 * 86_400_000);
        for (const typeArg of types) {
          const t = await resolveType(client, typeArg);
          const [fut, pub, dr] = await Promise.allSettled([
            client.getAll<any>(t.route, { status: "future", context: "edit", orderby: "date", order: "asc", _fields: "id,title,date,link,author,status" }, 200),
            client.getAll<any>(t.route, { status: "publish", after: iso(since), orderby: "date", order: "desc", _fields: "id,date" }, 1000),
            client.getAll<any>(t.route, { status: "draft,pending", context: "edit", modified_before: iso(new Date(now.getTime() - stale_draft_days * 86_400_000)), orderby: "modified", order: "asc", _fields: "id,title,modified,author,status,link" }, 100),
          ]);
          if (fut.status === "fulfilled") scheduled.push(...fut.value.map((x) => ({ ...x, type: t.name })));
          else notes.push(`${t.name}: scheduled items unavailable (${(fut.reason as any)?.message})`);
          if (pub.status === "fulfilled") published.push(...pub.value.map((x) => ({ ...x, type: t.name })));
          else notes.push(`${t.name}: published items unavailable (${(pub.reason as any)?.message})`);
          if (dr.status === "fulfilled") drafts.push(...dr.value.map((x) => ({ ...x, type: t.name })));
          else notes.push(`${t.name}: drafts unavailable (${(dr.reason as any)?.message})`);
        }

        const pastWeeks = weekSeries(now, -(weeks_back - 1), weeks_back);
        const perWeek = new Map(pastWeeks.map((w) => [w.week, 0]));
        const dates: number[] = [];
        for (const p of published) {
          const d = parseWpDate(p.date);
          if (!d) continue;
          dates.push(d.getTime());
          const k = isoWeek(d);
          if (perWeek.has(k)) perWeek.set(k, perWeek.get(k)! + 1);
        }
        dates.sort((a, b) => a - b);
        let longestGapDays = 0;
        for (let i = 1; i < dates.length; i++) longestGapDays = Math.max(longestGapDays, Math.round((dates[i] - dates[i - 1]) / 86_400_000));
        const lastPublished = dates.length ? new Date(dates[dates.length - 1]) : null;
        const cadence = pastWeeks.map((w) => ({ week: w.week, starts: w.starts, published: perWeek.get(w.week) ?? 0 }));
        const completeWeeks = cadence.slice(0, -1);
        const avg = completeWeeks.length ? Math.round((completeWeeks.reduce((n, w) => n + w.published, 0) / completeWeeks.length) * 100) / 100 : cadence[0]?.published ?? 0;

        const aheadWeeks = weekSeries(now, 0, weeks_ahead);
        const byWeek = new Map<string, any[]>(aheadWeeks.map((w) => [w.week, []]));
        const later: any[] = [];
        for (const s of scheduled) {
          const d = parseWpDate(s.date);
          const k = d ? isoWeek(d) : "unknown";
          const entry = { id: s.id, type: s.type, title: stripHtml(unwrap(s.title)), date: s.date };
          if (byWeek.has(k)) byWeek.get(k)!.push(entry);
          else later.push({ ...entry, week: k });
        }
        const currentWeek = aheadWeeks[0]?.week;
        const upcoming = aheadWeeks.map((w) => {
          const items = byWeek.get(w.week) ?? [];
          const alreadyPublished = w.week === currentWeek ? perWeek.get(w.week) ?? 0 : 0;
          const row: any = { week: w.week, starts: w.starts, scheduled: items.length, items };
          if (w.week === currentWeek) row.published_so_far = alreadyPublished;
          if (target_per_week !== undefined) row.shortfall = Math.max(0, Math.ceil(target_per_week - items.length - alreadyPublished));
          return row;
        });

        const staleDrafts = drafts.map((d) => {
          const m = parseWpDate(d.modified);
          return { id: d.id, type: d.type, status: d.status, title: stripHtml(unwrap(d.title)) || "(no title)", modified: d.modified, days_idle: m ? Math.floor((now.getTime() - m.getTime()) / 86_400_000) : null };
        });

        const gaps = target_per_week === undefined ? undefined : {
          target_per_week,
          past_weeks_below_target: completeWeeks.filter((w) => w.published < target_per_week).map((w) => ({ week: w.week, published: w.published })),
          upcoming_weeks_short: upcoming.filter((w) => w.shortfall > 0).map((w) => ({ week: w.week, scheduled: w.scheduled, shortfall: w.shortfall })),
          items_needed_to_fill_upcoming: upcoming.reduce((n, w) => n + (w.shortfall ?? 0), 0),
        };

        return ok({
          site: client.site.id, types, generated: now.toISOString(),
          cadence: {
            weeks: cadence, published_total: published.length, avg_per_complete_week: avg,
            zero_weeks: completeWeeks.filter((w) => w.published === 0).length,
            longest_gap_days: longestGapDays || undefined,
            last_published: lastPublished?.toISOString().slice(0, 10) ?? null,
            days_since_last_publish: lastPublished ? Math.floor((now.getTime() - lastPublished.getTime()) / 86_400_000) : null,
          },
          scheduled: { total: scheduled.length, by_week: upcoming, beyond_window: later.length ? later.slice(0, 50) : undefined },
          stale_drafts: { older_than_days: stale_draft_days, count: staleDrafts.length, items: staleDrafts.slice(0, 50) },
          gaps,
          notes: notes.length ? notes : undefined,
        });
      },
    }),

    /* ---------------------------- fleet_report ---------------------------- */
    defineTool({
      name: "fleet_report",
      title: "Fleet health report",
      readOnly: true,
      description:
        "One report across every configured WordPress site (or a chosen subset), checked in parallel: reachability and response time, WordPress version, pending core/plugin/theme updates, active plugin count, companion plugin presence, HTTPS, search-engine blocking (blog_public / homepage noindex) and Site Health critical issues. Each site is isolated, so one failure never breaks the report. Sites are sorted worst first with headline issues — the starting point for agency maintenance rounds.",
      schema: {
        site_ids: z.array(z.string()).optional().describe("Only these site ids. Omit for every configured site."),
        concurrency: z.number().int().min(1).max(4).optional().default(4).describe("How many sites to check at once."),
        include_health: z.boolean().optional().default(true).describe("Include Site Health issue counts (via the companion plugin, one request per site)."),
        check_homepage: z.boolean().optional().default(true).describe("Fetch each homepage to detect noindex and the WordPress generator version when the companion plugin is absent."),
        timeout_ms: z.number().int().min(2000).max(60000).optional().default(15000).describe("Per-request timeout for each site."),
      },
      handler: async ({ site_ids, concurrency, include_health, check_homepage, timeout_ms }) => {
        const configured = registry.sites;
        if (!configured.length) throw new Error("No sites are configured. Run list_sites for how to add them.");
        const unknown = (site_ids ?? []).filter((id) => !registry.has(id));
        const targets = site_ids?.length ? configured.filter((s) => site_ids.includes(s.id)) : configured;
        const began = Date.now();

        const settled = await mapLimit(targets, concurrency, async (cfg) => {
          const client = registry.resolve(cfg.id);
          const issues: FleetIssue[] = [];
          const row: any = { id: cfg.id, url: cfg.url, reachable: false };
          const t0 = Date.now();
          let root: any;
          try {
            root = (await client.request<any>("/", { timeoutMs: timeout_ms })).data ?? {};
            row.reachable = true;
            row.response_ms = Date.now() - t0;
            row.name = root.name;
          } catch (e: any) {
            row.response_ms = Date.now() - t0;
            issues.push({ severity: "critical", issue: `Unreachable: ${String(e.message).slice(0, 200)}` });
            return { ...row, severity: worstSeverity(issues), issues };
          }
          if (row.response_ms > 3000) issues.push({ severity: "warning", issue: `Slow REST index (${row.response_ms} ms).` });
          const namespaces: string[] = root.namespaces ?? [];
          const helperNs = cfg.helperNamespace ?? "wpxmcp/v1";
          row.companion_plugin = namespaces.includes(helperNs);
          row.https = String(root.home ?? cfg.url).startsWith("https:");
          const localHost = /^(localhost|127\.|\[?::1\]?|.*\.(local|localhost|test)$)/i.test(new URL(cfg.url).hostname);
          const seo = detectSeoPlugin(namespaces);
          if (seo.plugin) row.seo_plugin = seo.plugin;

          const authed = client.hasCredentials();
          if (!authed) issues.push({ severity: "info", issue: "No credentials configured — updates, plugins, Site Health and blog_public cannot be read." });
          if (row.companion_plugin && authed) {
            try {
              const info = (await client.request<any>(`/${helperNs}/site-info`, { query: { include_health: include_health ? 1 : 0 }, timeoutMs: Math.max(timeout_ms, 30_000) })).data ?? {};
              row.wp_version = info.wordpress?.version;
              row.php_version = info.php?.version;
              row.environment = info.wordpress?.environment;
              const u = info.updates ?? {};
              row.updates = { core: u.core_update_available ? u.core_latest ?? true : false, plugins: u.plugin_updates ?? 0, themes: u.theme_updates ?? 0 };
              if (u.core_update_available) issues.push({ severity: "warning", issue: `WordPress core update available (${u.core_latest ?? "newer version"}).` });
              if (u.plugin_updates) issues.push({ severity: u.plugin_updates >= 5 ? "critical" : "warning", issue: `${u.plugin_updates} plugin update(s) pending${Array.isArray(u.plugin_update_list) && u.plugin_update_list.length ? `: ${u.plugin_update_list.slice(0, 5).map((p: any) => p.name ?? p.plugin ?? p).join(", ")}` : ""}.` });
              if (u.theme_updates) issues.push({ severity: "warning", issue: `${u.theme_updates} theme update(s) pending.` });
              if (info.wordpress?.debug && info.wordpress?.environment === "production") issues.push({ severity: "warning", issue: "WP_DEBUG is on in production." });
              if (info.cron?.overdue_events > 10) issues.push({ severity: "warning", issue: `${info.cron.overdue_events} overdue cron events — WP-Cron may not be running.` });
              if (info.site_health) {
                const list: any[] = info.site_health.issues ?? [];
                const critical = list.filter((x) => x.status === "critical");
                row.site_health = { critical: critical.length, recommended: list.filter((x) => x.status === "recommended").length };
                if (critical.length) issues.push({ severity: "critical", issue: `Site Health: ${critical.length} critical — ${critical.slice(0, 3).map((c) => stripHtml(String(c.label))).join("; ")}.` });
              }
            } catch (e: any) {
              issues.push({ severity: "warning", issue: `Companion diagnostics failed: ${String(e.message).slice(0, 160)}` });
            }
            try {
              const opts = (await client.request<any>(`/${helperNs}/options`, { query: { names: "blog_public" }, timeoutMs: timeout_ms })).data?.options ?? {};
              if ("blog_public" in opts) {
                row.blog_public = String(opts.blog_public) !== "0";
                if (!row.blog_public) issues.push({ severity: row.environment && row.environment !== "production" ? "info" : "critical", issue: "\"Discourage search engines\" is on (blog_public = 0)." });
              }
            } catch { /* not admin */ }
          } else if (!row.companion_plugin) {
            issues.push({ severity: "info", issue: "Companion plugin not installed — update counts, PHP version and Site Health are not visible." });
          }

          if (authed) try {
            const plugins = (await client.request<any[]>("/wp/v2/plugins", { query: { _fields: "plugin,status" }, timeoutMs: timeout_ms })).data;
            if (Array.isArray(plugins)) {
              row.plugins = { active: plugins.filter((p) => p.status !== "inactive").length, inactive: plugins.filter((p) => p.status === "inactive").length };
              if (!seo.plugin) row.seo_plugin = detectSeoPlugin(namespaces, plugins).plugin ?? null;
            }
          } catch (e: any) {
            const status = e instanceof WPError ? e.status : 0;
            issues.push({ severity: status === 401 ? "critical" : "info", issue: status === 401 ? "Credentials rejected (HTTP 401) — the Application Password may be revoked." : `Plugin list not readable (${status || e.message}) — needs an Administrator account.` });
          }

          if (!row.https) {
            const nonProd = localHost || (row.environment && row.environment !== "production");
            issues.push({ severity: nonProd ? "info" : "warning", issue: `Not served over HTTPS${nonProd ? " (local/non-production site)" : ""}.` });
          }

          if (check_homepage) {
            try {
              const page = await fetchSitePage(client, "/", { maxBytes: 512 * 1024, timeoutMs: timeout_ms });
              row.homepage_status = page.status;
              if (page.blocked_redirect) issues.push({ severity: "warning", issue: `Homepage redirects off-host to ${page.blocked_redirect} — the configured URL is not canonical.` });
              else if (page.status >= 500) issues.push({ severity: "critical", issue: `Homepage returns HTTP ${page.status}.` });
              else if (page.status >= 400) issues.push({ severity: "warning", issue: `Homepage returns HTTP ${page.status}.` });
              else {
                const head = parseHead(page.text);
                row.homepage_noindex = head.robots.noindex;
                if (head.robots.noindex && row.blog_public !== false) issues.push({ severity: row.environment && row.environment !== "production" ? "info" : "critical", issue: `Homepage is noindex ("${head.robots.raw}").` });
                if (!row.wp_version) {
                  const gen = /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s*([\d.]+)/i.exec(page.text);
                  if (gen) row.wp_version = gen[1];
                }
              }
            } catch (e: any) {
              issues.push({ severity: "warning", issue: `Homepage fetch failed: ${String(e.message).slice(0, 160)}` });
            }
          }
          return { ...row, severity: worstSeverity(issues), issues };
        });

        const rows = settled.map((r, i) =>
          r.status === "fulfilled" ? r.value : { id: targets[i].id, url: targets[i].url, reachable: false, severity: "critical" as Severity, issues: [{ severity: "critical" as Severity, issue: `Check failed: ${(r.reason as any)?.message ?? r.reason}` }] }
        );
        const sorted = sortBySeverity(rows);
        const counts = { critical: 0, warning: 0, info: 0, ok: 0 } as Record<Severity, number>;
        for (const r of sorted) counts[r.severity as Severity]++;
        return ok({
          checked: sorted.length, duration_ms: Date.now() - began, by_severity: counts,
          unknown_site_ids: unknown.length ? unknown : undefined,
          headline: sorted.filter((r) => r.severity === "critical" || r.severity === "warning").slice(0, 10)
            .map((r) => `${r.id}: ${r.issues.filter((i: FleetIssue) => i.severity === "critical" || i.severity === "warning").map((i: FleetIssue) => i.issue).slice(0, 2).join(" | ")}`),
          sites: sorted,
        });
      },
    }),
  ];
}

