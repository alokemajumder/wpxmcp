/**
 * Pure SEO helpers for growth.ts: plugin detection, head parsing, and the
 * per-plugin mapping between normalized fields and stored meta keys.
 * No I/O here, so every function is unit-testable and Workers-safe.
 */

export type SeoPlugin = "yoast" | "rank-math" | "aioseo" | "seopress" | "seo-framework";

export const SEO_PLUGINS: SeoPlugin[] = ["yoast", "rank-math", "aioseo", "seopress", "seo-framework"];

const NAMESPACE_OF: Record<string, SeoPlugin> = {
  "yoast/v1": "yoast",
  "rankmath/v1": "rank-math",
  "aioseo/v1": "aioseo",
  "seopress/v1": "seopress",
};

/** Plugin directory (the part of the plugin file before the slash) per SEO plugin. */
const PLUGIN_DIRS: Record<string, SeoPlugin> = {
  "wordpress-seo": "yoast",
  "wordpress-seo-premium": "yoast",
  "seo-by-rank-math": "rank-math",
  "seo-by-rank-math-pro": "rank-math",
  "all-in-one-seo-pack": "aioseo",
  "all-in-one-seo-pack-pro": "aioseo",
  "wp-seopress": "seopress",
  "wp-seopress-pro": "seopress",
  autodescription: "seo-framework",
};

export interface SeoDetection {
  plugin: SeoPlugin | null;
  detected_via: string | null;
  /** More than one SEO plugin active — they fight over the head. */
  also_active?: SeoPlugin[];
}

/**
 * Detects the active SEO plugin from REST namespaces first (cheap, needs no
 * admin rights), then from an optional plugin inventory for plugins that
 * register no namespace (The SEO Framework) or when a namespace is hidden.
 */
export function detectSeoPlugin(namespaces: string[], plugins?: Array<{ plugin?: string; status?: string }> | null): SeoDetection {
  const found: Array<{ plugin: SeoPlugin; via: string }> = [];
  for (const ns of namespaces ?? []) {
    const p = NAMESPACE_OF[ns];
    if (p && !found.some((f) => f.plugin === p)) found.push({ plugin: p, via: `REST namespace ${ns}` });
  }
  for (const entry of plugins ?? []) {
    if (!entry?.plugin || entry.status === "inactive") continue;
    const p = PLUGIN_DIRS[String(entry.plugin).split("/")[0]];
    if (p && !found.some((f) => f.plugin === p)) found.push({ plugin: p, via: `active plugin ${entry.plugin}` });
  }
  if (!found.length) return { plugin: null, detected_via: null };
  const out: SeoDetection = { plugin: found[0].plugin, detected_via: found[0].via };
  if (found.length > 1) out.also_active = found.slice(1).map((f) => f.plugin);
  return out;
}

/* ------------------------------------------------------------------ *
 * Head parsing
 * ------------------------------------------------------------------ */

export interface NormalizedSeo {
  title: string | null;
  description: string | null;
  focus_keyword?: string | null;
  canonical: string | null;
  robots: { noindex: boolean; nofollow: boolean; raw: string | null };
  og: { title: string | null; description: string | null; image: string | null; type: string | null; url: string | null };
  schema_types: string[];
}

export function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeChar(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeChar(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** Attributes of one tag, lower-cased names, entity-decoded values. Attribute order does not matter. */
export function parseAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const inner = tag.replace(/^<\s*[a-zA-Z0-9-]+/, "").replace(/\/?>$/, "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    const name = m[1].toLowerCase();
    if (name in out) continue;
    out[name] = decodeHtml(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function robotsFlags(raw: string | null) {
  const tokens = (raw ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  return { noindex: tokens.includes("noindex") || tokens.includes("none"), nofollow: tokens.includes("nofollow") || tokens.includes("none"), raw };
}

/** Collects every @type from JSON-LD blocks, including inside @graph. */
export function schemaTypesFrom(values: unknown[]): string[] {
  const types = new Set<string>();
  const walk = (node: any, depth: number) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
    const t = node["@type"];
    if (typeof t === "string") types.add(t);
    else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") types.add(x);
    if (node["@graph"]) walk(node["@graph"], depth + 1);
  };
  for (const v of values) walk(v, 0);
  return [...types];
}

/** Normalizes the SEO-relevant parts of an HTML document (or a bare head fragment). */
export function parseHead(html: string): NormalizedSeo {
  const doc = String(html ?? "");
  const headEnd = doc.search(/<\/head\s*>/i);
  const head = headEnd > 0 ? doc.slice(0, headEnd) : doc;
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => parseAttributes(m[0]));
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => parseAttributes(m[0]));
  const byName = (name: string) => metas.find((a) => (a.name ?? "").toLowerCase() === name)?.content ?? null;
  const byProp = (prop: string) => metas.find((a) => (a.property ?? a.name ?? "").toLowerCase() === prop)?.content ?? null;
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const canonical = links.find((a) => (a.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"))?.href ?? null;
  const robotsRaw = byName("robots");

  // JSON-LD can sit in the body too (some themes print it in the footer).
  const jsonLd: unknown[] = [];
  for (const m of doc.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { jsonLd.push(JSON.parse(m[1].trim())); } catch { /* malformed block — skip */ }
  }

  return {
    title: titleMatch ? decodeHtml(titleMatch[1].replace(/\s+/g, " ").trim()) : null,
    description: byName("description"),
    canonical,
    robots: robotsFlags(robotsRaw),
    og: { title: byProp("og:title"), description: byProp("og:description"), image: byProp("og:image"), type: byProp("og:type"), url: byProp("og:url") },
    schema_types: schemaTypesFrom(jsonLd),
  };
}

/** Normalizes Yoast's `yoast_head_json` REST field. */
export function normalizeYoastHead(y: any): NormalizedSeo | null {
  if (!y || typeof y !== "object") return null;
  const robots = y.robots ?? {};
  const raw = [robots.index, robots.follow].filter(Boolean).join(", ") || null;
  return {
    title: y.title ?? null,
    description: y.description ?? null,
    canonical: y.canonical ?? null,
    robots: { noindex: robots.index === "noindex", nofollow: robots.follow === "nofollow", raw },
    og: {
      title: y.og_title ?? null, description: y.og_description ?? null,
      image: y.og_image?.[0]?.url ?? null, type: y.og_type ?? null, url: y.og_url ?? null,
    },
    schema_types: schemaTypesFrom([y.schema]),
  };
}

/* ------------------------------------------------------------------ *
 * Per-plugin meta keys
 * ------------------------------------------------------------------ */

export interface SeoFields {
  title?: string;
  description?: string;
  focus_keyword?: string;
  canonical?: string;
  noindex?: boolean;
  nofollow?: boolean;
}

export const SEO_META_KEYS: Record<SeoPlugin, Partial<Record<keyof SeoFields, string>>> = {
  yoast: {
    title: "_yoast_wpseo_title", description: "_yoast_wpseo_metadesc", focus_keyword: "_yoast_wpseo_focuskw",
    canonical: "_yoast_wpseo_canonical", noindex: "_yoast_wpseo_meta-robots-noindex", nofollow: "_yoast_wpseo_meta-robots-nofollow",
  },
  "rank-math": {
    title: "rank_math_title", description: "rank_math_description", focus_keyword: "rank_math_focus_keyword",
    canonical: "rank_math_canonical_url", noindex: "rank_math_robots", nofollow: "rank_math_robots",
  },
  aioseo: {
    title: "_aioseo_title", description: "_aioseo_description", focus_keyword: "_aioseo_keywords",
  },
  seopress: {
    title: "_seopress_titles_title", description: "_seopress_titles_desc", focus_keyword: "_seopress_analysis_target_kw",
    canonical: "_seopress_robots_canonical", noindex: "_seopress_robots_index", nofollow: "_seopress_robots_follow",
  },
  "seo-framework": {
    title: "_genesis_title", description: "_genesis_description", canonical: "_genesis_canonical_uri",
    noindex: "_genesis_noindex", nofollow: "_genesis_nofollow",
  },
};

export function metaKeysFor(plugin: SeoPlugin): string[] {
  return [...new Set(Object.values(SEO_META_KEYS[plugin]).filter(Boolean) as string[])];
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value) return value.split(/[\s,]+/).filter(Boolean);
  if (value && typeof value === "object") return Object.values(value).map(String);
  return [];
}

const str = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));

/** Reads normalized per-item overrides from raw post meta. Empty means "plugin default/template". */
export function readSeoMeta(plugin: SeoPlugin, meta: Record<string, unknown>): SeoFields & { noindex?: boolean; nofollow?: boolean } {
  const m = meta ?? {};
  const out: any = {};
  switch (plugin) {
    case "yoast":
      out.title = str(m._yoast_wpseo_title); out.description = str(m._yoast_wpseo_metadesc);
      out.focus_keyword = str(m._yoast_wpseo_focuskw); out.canonical = str(m._yoast_wpseo_canonical);
      out.noindex = String(m["_yoast_wpseo_meta-robots-noindex"] ?? "") === "1" ? true : String(m["_yoast_wpseo_meta-robots-noindex"] ?? "") === "2" ? false : null;
      out.nofollow = String(m["_yoast_wpseo_meta-robots-nofollow"] ?? "") === "1" ? true : null;
      break;
    case "rank-math": {
      const robots = asList(m.rank_math_robots);
      out.title = str(m.rank_math_title); out.description = str(m.rank_math_description);
      out.focus_keyword = str(m.rank_math_focus_keyword); out.canonical = str(m.rank_math_canonical_url);
      out.noindex = robots.length ? robots.includes("noindex") : null;
      out.nofollow = robots.length ? robots.includes("nofollow") : null;
      break;
    }
    case "aioseo":
      out.title = str(m._aioseo_title); out.description = str(m._aioseo_description); out.focus_keyword = str(m._aioseo_keywords);
      break;
    case "seopress":
      out.title = str(m._seopress_titles_title); out.description = str(m._seopress_titles_desc);
      out.focus_keyword = str(m._seopress_analysis_target_kw); out.canonical = str(m._seopress_robots_canonical);
      out.noindex = m._seopress_robots_index === "yes" ? true : null;
      out.nofollow = m._seopress_robots_follow === "yes" ? true : null;
      break;
    case "seo-framework":
      out.title = str(m._genesis_title); out.description = str(m._genesis_description); out.canonical = str(m._genesis_canonical_uri);
      out.noindex = String(m._genesis_noindex ?? "") === "1" ? true : String(m._genesis_noindex ?? "") === "-1" ? false : null;
      out.nofollow = String(m._genesis_nofollow ?? "") === "1" ? true : null;
      break;
  }
  return out;
}

/**
 * Translates normalized fields into the plugin's meta keys. `current` supplies
 * existing values where a key holds several settings (Rank Math's robots array).
 */
export function buildSeoMetaWrite(plugin: SeoPlugin, fields: SeoFields, current: Record<string, unknown> = {}): { meta: Record<string, unknown>; unsupported: string[] } {
  const keys = SEO_META_KEYS[plugin];
  const meta: Record<string, unknown> = {};
  const unsupported: string[] = [];
  for (const field of ["title", "description", "focus_keyword", "canonical"] as const) {
    if (fields[field] === undefined) continue;
    const key = keys[field];
    if (!key) { unsupported.push(field); continue; }
    meta[key] = fields[field];
  }
  if (fields.noindex !== undefined || fields.nofollow !== undefined) {
    switch (plugin) {
      case "yoast":
        if (fields.noindex !== undefined) meta["_yoast_wpseo_meta-robots-noindex"] = fields.noindex ? "1" : "2";
        if (fields.nofollow !== undefined) meta["_yoast_wpseo_meta-robots-nofollow"] = fields.nofollow ? "1" : "0";
        break;
      case "rank-math": {
        let robots = asList(current.rank_math_robots).filter((r) => !["index", "noindex", "follow", "nofollow"].includes(r));
        const wasNoindex = asList(current.rank_math_robots).includes("noindex");
        const wasNofollow = asList(current.rank_math_robots).includes("nofollow");
        const noindex = fields.noindex ?? wasNoindex;
        const nofollow = fields.nofollow ?? wasNofollow;
        robots = [noindex ? "noindex" : "index", ...(nofollow ? ["nofollow"] : []), ...robots];
        meta.rank_math_robots = robots;
        break;
      }
      case "seopress":
        if (fields.noindex !== undefined) meta._seopress_robots_index = fields.noindex ? "yes" : "";
        if (fields.nofollow !== undefined) meta._seopress_robots_follow = fields.nofollow ? "yes" : "";
        break;
      case "seo-framework":
        if (fields.noindex !== undefined) meta._genesis_noindex = fields.noindex ? 1 : 0;
        if (fields.nofollow !== undefined) meta._genesis_nofollow = fields.nofollow ? 1 : 0;
        break;
      case "aioseo":
        if (fields.noindex !== undefined) unsupported.push("noindex");
        if (fields.nofollow !== undefined) unsupported.push("nofollow");
        break;
    }
  }
  return { meta, unsupported };
}

/** The request body AIOSEO's `aioseo/v1/post` route expects (its Post model's column names). */
export function aioseoPostBody(id: number, fields: SeoFields): Record<string, unknown> {
  const body: Record<string, unknown> = { id };
  if (fields.title !== undefined) body.title = fields.title;
  if (fields.description !== undefined) body.description = fields.description;
  if (fields.focus_keyword !== undefined) body.keyphrases = { focus: { keyphrase: fields.focus_keyword }, additional: [] };
  if (fields.canonical !== undefined) body.canonical_url = fields.canonical;
  if (fields.noindex !== undefined || fields.nofollow !== undefined) {
    body.robots_default = false;
    if (fields.noindex !== undefined) body.robots_noindex = fields.noindex;
    if (fields.nofollow !== undefined) body.robots_nofollow = fields.nofollow;
  }
  return body;
}

/* ------------------------------------------------------------------ *
 * Stored vs rendered
 * ------------------------------------------------------------------ */

const norm = (s: string | null | undefined) => decodeHtml(String(s ?? "")).replace(/\s+/g, " ").trim().toLowerCase();

function normUrl(u: string | null | undefined): string {
  if (!u) return "";
  try {
    const p = new URL(u);
    return `${p.host}${p.pathname.replace(/\/+$/, "")}${p.search}`.toLowerCase();
  } catch {
    return String(u).replace(/\/+$/, "").toLowerCase();
  }
}

export interface SeoMismatch { field: string; expected: unknown; rendered: unknown; likely_cause: string }

/**
 * Compares what the plugin says it outputs against what a visitor receives.
 * `expected` fields that are null are skipped: no override means nothing to verify.
 */
export function compareSeo(expected: Partial<NormalizedSeo> & { noindex?: boolean | null }, rendered: NormalizedSeo): SeoMismatch[] {
  const out: SeoMismatch[] = [];
  if (expected.title && norm(expected.title) !== norm(rendered.title)) {
    out.push({ field: "title", expected: expected.title, rendered: rendered.title, likely_cause: rendered.title ? "A page cache serving an older copy, or the theme/another plugin overriding the <title>." : "The theme does not call wp_head()/title-tag support, so no <title> is printed." });
  }
  if (expected.description && norm(expected.description) !== norm(rendered.description)) {
    out.push({ field: "description", expected: expected.description, rendered: rendered.description, likely_cause: rendered.description ? "Cached page, or a second SEO plugin/theme printing its own description." : "Nothing printed a meta description — plugin output disabled for this type, or wp_head() missing." });
  }
  if (expected.canonical && normUrl(expected.canonical) !== normUrl(rendered.canonical)) {
    out.push({ field: "canonical", expected: expected.canonical, rendered: rendered.canonical, likely_cause: "Cached page, a CDN rewriting host names, or the site URL setting differing from the address visitors use." });
  }
  const expNoindex = expected.robots?.noindex ?? expected.noindex;
  if (typeof expNoindex === "boolean" && expNoindex !== rendered.robots.noindex) {
    out.push({ field: "robots.noindex", expected: expNoindex, rendered: rendered.robots.noindex, likely_cause: rendered.robots.noindex ? "\"Discourage search engines\" (blog_public = 0) is on, which forces noindex site-wide." : "Cached page, or the plugin's robots output is disabled." });
  }
  return out;
}

/**
 * Whether per-item `yoast_head_json` values in a collection response can be
 * believed. On some setups (notably ?rest_route= sites) Yoast builds the head
 * from the main query, so every item carries the same head — distinct posts
 * all reporting one identical SEO title is the tell.
 */
export function yoastCollectionHeadsTrustworthy(items: Array<{ title?: any; yoast_head_json?: any }>): boolean {
  const withHead = items.filter((i) => i?.yoast_head_json && typeof i.yoast_head_json.title === "string");
  if (withHead.length < 2) return true;
  const seoTitles = new Set(withHead.map((i) => i.yoast_head_json.title));
  const titles = new Set(withHead.map((i) => JSON.stringify(i.title?.raw ?? i.title?.rendered ?? i.title ?? "")));
  return !(seoTitles.size === 1 && titles.size > 1);
}
