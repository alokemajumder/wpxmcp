import type { WordPressClient } from "./client.js";
import { unwrap, stripHtml, wordCount } from "./tooling.js";

/* ------------------------------------------------------------------ *
 * Targeted partial edits
 * ------------------------------------------------------------------ */

export interface EditOp {
  find: string;
  replace: string;
  /** Treat `find` as a regular expression. Default false (literal). */
  regex?: boolean;
  /** Replace every occurrence rather than only the first. Default false. */
  all?: boolean;
  /** Fail loudly if the target is missing. Default true — silent no-ops hide bugs. */
  required?: boolean;
}

export interface EditResult {
  content: string;
  applied: Array<{ find: string; occurrences: number; regex: boolean }>;
  skipped: Array<{ find: string; reason: string }>;
  changed: boolean;
}

/**
 * Applies find/replace edits to a content string. Used by update_content and
 * find_content_by_url so a small change never means re-sending a whole post.
 */
export function applyEdits(original: string, edits: EditOp[]): EditResult {
  let content = original;
  const applied: EditResult["applied"] = [];
  const skipped: EditResult["skipped"] = [];

  for (const edit of edits) {
    if (typeof edit.find !== "string" || edit.find === "") {
      skipped.push({ find: String(edit.find), reason: "`find` was empty." });
      continue;
    }
    const required = edit.required !== false;
    let occurrences = 0;

    if (edit.regex) {
      let re: RegExp;
      try {
        re = new RegExp(edit.find, edit.all ? "gs" : "s");
      } catch (e: any) {
        skipped.push({ find: edit.find, reason: `Invalid regular expression: ${e.message}` });
        if (required) throw new Error(`Edit failed — invalid regex "${edit.find}": ${e.message}`);
        continue;
      }
      const matches = content.match(new RegExp(edit.find, "gs"));
      if (matches && matches.length > 1 && !edit.all) {
        throw new Error(
          `Edit is ambiguous — the regex "${truncate(edit.find, 120)}" matches ${matches.length} times. Anchor it to more surrounding text, or pass all: true to replace every match.`
        );
      }
      occurrences = matches ? (edit.all ? matches.length : 1) : 0;
      if (occurrences === 0) {
        skipped.push({ find: edit.find, reason: "Pattern did not match." });
        if (required) {
          throw new Error(
            `Edit failed — the regex "${edit.find}" matched nothing in the current content, so nothing was written. Read the content first (get_content) and match against what is actually there. Pass required: false to make a miss non-fatal.`
          );
        }
        continue;
      }
      content = content.replace(re, edit.replace);
    } else {
      const count = countOccurrences(content, edit.find);
      if (count === 0) {
        skipped.push({ find: edit.find, reason: "String not found." });
        if (required) {
          throw new Error(
            `Edit failed — "${truncate(edit.find, 120)}" does not appear in the current content, so nothing was written. Note that WordPress stores block markup with HTML comments (<!-- wp:paragraph -->), and that the editor may have reformatted whitespace or converted entities. Read it with get_content first. Pass required: false to make a miss non-fatal.`
          );
        }
        continue;
      }
      if (count > 1 && !edit.all) {
        throw new Error(
          `Edit is ambiguous — "${truncate(edit.find, 120)}" appears ${count} times. Include more surrounding text to make it unique, or pass all: true to replace every occurrence.`
        );
      }
      occurrences = edit.all ? count : 1;
      // A function replacer, because a string one expands $&, $' and $` even for a
      // literal pattern — a code sample containing '$' would splice in the rest of the post.
      content = edit.all ? content.split(edit.find).join(edit.replace) : content.replace(edit.find, () => edit.replace);
    }
    applied.push({ find: truncate(edit.find, 80), occurrences, regex: Boolean(edit.regex) });
  }

  return { content, applied, skipped, changed: content !== original };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/* ------------------------------------------------------------------ *
 * URL resolution
 * ------------------------------------------------------------------ */

export interface UrlResolution {
  found: boolean;
  id?: number;
  type?: string;
  restBase?: string;
  item?: any;
  strategy?: string;
  candidatesTried: string[];
  notes: string[];
}

/**
 * Resolves any WordPress front-end URL to the underlying object.
 *
 * Strategy order, cheapest and most reliable first:
 *   1. ?p=/?page_id= query args, and /?post_type=x&p=n
 *   2. The site's own search endpoint (/wp/v2/search) — handles permalink structures we cannot guess
 *   3. Rewrite-base matching: /documentation/foo/ -> the CPT whose rewrite slug is "documentation"
 *   4. Slug lookup across every REST-exposed type
 */
export async function resolveUrl(client: WordPressClient, rawUrl: string): Promise<UrlResolution> {
  const notes: string[] = [];
  const candidatesTried: string[] = [];

  let url: URL;
  try {
    url = new URL(rawUrl.trim().startsWith("http") ? rawUrl.trim() : `https://${rawUrl.trim()}`);
  } catch {
    return { found: false, candidatesTried, notes: [`"${rawUrl}" is not a parseable URL.`] };
  }

  const siteHost = new URL(client.baseUrl).host;
  if (url.host !== siteHost) {
    notes.push(
      `Heads up: the URL host (${url.host}) differs from the configured site (${siteHost}). Resolving against ${siteHost} anyway — pass the right site_id if this belongs to another connected site.`
    );
  }

  const types = await client.postTypes();

  // 1. Explicit id in the query string.
  const explicitId = url.searchParams.get("p") ?? url.searchParams.get("page_id");
  if (explicitId && /^\d+$/.test(explicitId)) {
    const qsType = url.searchParams.get("post_type") ?? (url.searchParams.get("page_id") ? "page" : "post");
    candidatesTried.push(`id=${explicitId} type=${qsType}`);
    const hit = await tryFetchById(client, types, qsType, Number(explicitId));
    if (hit) return { found: true, ...hit, strategy: "id in query string", candidatesTried, notes };
  }

  const segments = url.pathname.split("/").filter(Boolean).filter((s) => !/^(page|amp)$/.test(s) && !/^\d+$/.test(s));
  const lastSegment = segments[segments.length - 1] ?? "";
  let slug: string;
  try {
    slug = decodeURIComponent(lastSegment);
  } catch {
    slug = lastSegment; // a stray "%" is not an escape; use the segment as written
  }

  if (!slug) {
    notes.push("The URL points at the site root, which is the front page rather than a single piece of content. Check get_site_settings for `page_on_front`.");
    return { found: false, candidatesTried, notes };
  }

  // 2. The site's own search index knows its permalink structure better than we can guess.
  try {
    candidatesTried.push(`search?search=${slug}`);
    const search = await client.get<any[]>("/wp/v2/search", { search: slug, per_page: 20, _embed: false });
    const target = normalizeUrlForCompare(url.toString());
    const match =
      search.data.find((r: any) => normalizeUrlForCompare(r.url) === target) ??
      search.data.find((r: any) => normalizeUrlForCompare(r.url).endsWith(`/${slug}/`));
    if (match) {
      const subtype = match.subtype ?? match.type;
      const hit = await tryFetchById(client, types, subtype, match.id);
      if (hit) return { found: true, ...hit, strategy: "wp/v2/search URL match", candidatesTried, notes };
    }
  } catch (e: any) {
    notes.push(`The search endpoint was unavailable (${e.message}); fell back to slug lookups.`);
  }

  // 3. Rewrite-base matching, so /documentation/intro/ prefers the `documentation` CPT.
  const ordered = orderTypesByRewriteBase(types, segments);
  for (const typeName of ordered) {
    const type = types[typeName];
    if (!type?.rest_base) continue;
    candidatesTried.push(`${typeName}?slug=${slug}`);
    try {
      const res = await client.get<any[]>(typeRoute(type), { slug, per_page: 5, status: "any", context: "edit" });
      const item = res.data?.[0];
      if (item) {
        return { found: true, id: item.id, type: typeName, restBase: type.rest_base, item, strategy: `slug lookup in "${typeName}"`, candidatesTried, notes };
      }
    } catch (e: any) {
      // status=any needs auth; retry anonymously before giving up on this type.
      try {
        const res = await client.get<any[]>(typeRoute(type), { slug, per_page: 5 });
        const item = res.data?.[0];
        if (item) {
          return { found: true, id: item.id, type: typeName, restBase: type.rest_base, item, strategy: `slug lookup in "${typeName}" (public context)`, candidatesTried, notes };
        }
      } catch {
        /* type not queryable — move on */
      }
    }
  }

  notes.push(
    `No content matched the slug "${slug}". It may be a taxonomy archive (try list_terms with slug="${slug}"), an author or date archive, or content in a post type registered with show_in_rest => false.`
  );
  return { found: false, candidatesTried, notes };
}

function normalizeUrlForCompare(u: string): string {
  try {
    const parsed = new URL(u);
    return (parsed.pathname.replace(/\/+$/, "") + "/").toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

/** Puts the post type whose rewrite base appears in the URL first, then the usual suspects. */
function orderTypesByRewriteBase(types: Record<string, any>, segments: string[]): string[] {
  const names = Object.keys(types).filter((n) => !["attachment", "wp_block", "wp_template", "wp_template_part", "wp_navigation", "wp_global_styles", "wp_font_family", "wp_font_face", "nav_menu_item"].includes(n));
  const score = (name: string): number => {
    const t = types[name];
    const rewriteSlug: string | undefined = t?.rewrite?.slug ?? t?.slug;
    let s = 0;
    if (rewriteSlug && segments.includes(rewriteSlug)) s += 100;
    if (name && segments.includes(name)) s += 90;
    if (name === "page" && segments.length === 1) s += 50;
    if (name === "post") s += 40;
    if (name === "page") s += 30;
    return s;
  };
  return names.sort((a, b) => score(b) - score(a));
}

/** Collection route for a post type, honouring a custom rest_namespace (WordPress 5.9+). */
function typeRoute(type: any): string {
  const ns = typeof type?.rest_namespace === "string" && type.rest_namespace.trim() ? type.rest_namespace.trim().replace(/^\/+|\/+$/g, "") : "wp/v2";
  return `/${ns}/${type.rest_base}`;
}

async function tryFetchById(client: WordPressClient, types: Record<string, any>, typeName: string, id: number) {
  const type = types[typeName] ?? Object.values(types).find((t: any) => t.rest_base === typeName);
  const restBase = (type as any)?.rest_base;
  if (!restBase) return null;
  const resolvedName = Object.keys(types).find((k) => types[k].rest_base === restBase) ?? typeName;
  try {
    const res = await client.get(`${typeRoute(type)}/${id}`, { context: "edit" });
    return { id, type: resolvedName, restBase, item: res.data };
  } catch {
    try {
      const res = await client.get(`${typeRoute(type)}/${id}`);
      return { id, type: resolvedName, restBase, item: res.data };
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Summaries
 * ------------------------------------------------------------------ */

const YOAST_META_KEYS = ["_yoast_wpseo_title", "_yoast_wpseo_metadesc", "_yoast_wpseo_focuskw", "_yoast_wpseo_canonical", "_yoast_wpseo_meta-robots-noindex"];

/** Minimal shape for audit/lookup work — never the whole post body. */
export function summarizeContent(item: any, type?: string) {
  const content = unwrap(item.content);
  const excerpt = stripHtml(unwrap(item.excerpt)).slice(0, 300);
  const seo = extractSeo(item);
  return {
    id: item.id,
    type: type ?? item.type,
    title: stripHtml(unwrap(item.title)),
    slug: item.slug,
    status: item.status,
    link: item.link,
    date: item.date,
    modified: item.modified,
    author: item.author,
    parent: item.parent ?? undefined,
    excerpt: excerpt || stripHtml(content).slice(0, 300),
    word_count: wordCount(content),
    featured_media: item.featured_media || null,
    taxonomies: extractTaxonomies(item),
    seo,
    comment_status: item.comment_status,
    template: item.template || undefined,
  };
}

function extractTaxonomies(item: any): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const skip = new Set([
    "id", "date", "date_gmt", "guid", "modified", "modified_gmt", "slug", "status", "type", "link",
    "title", "content", "excerpt", "author", "featured_media", "comment_status", "ping_status",
    "sticky", "template", "format", "meta", "_links", "parent", "menu_order", "password", "generated_slug", "permalink_template", "class_list",
  ]);
  for (const [key, value] of Object.entries(item)) {
    if (skip.has(key)) continue;
    if (Array.isArray(value) && value.every((v) => typeof v === "number")) out[key] = value as number[];
  }
  return out;
}

/** Pulls SEO fields from Yoast, Rank Math, AIOSEO or SEOPress — whichever is present. */
export function extractSeo(item: any) {
  const meta = item.meta ?? {};
  const yoastHead = item.yoast_head_json ?? null;
  const seo: Record<string, unknown> = {};

  if (yoastHead) {
    seo.plugin = "yoast";
    seo.title = yoastHead.title ?? null;
    seo.description = yoastHead.description ?? null;
    seo.canonical = yoastHead.canonical ?? null;
    seo.robots = yoastHead.robots ?? null;
    seo.og_image = yoastHead.og_image?.[0]?.url ?? null;
  }
  for (const key of YOAST_META_KEYS) {
    if (meta[key] !== undefined && meta[key] !== "") {
      seo.plugin = seo.plugin ?? "yoast";
      seo[key.replace("_yoast_wpseo_", "yoast_")] = meta[key];
    }
  }
  if (meta.rank_math_title || meta.rank_math_description) {
    seo.plugin = "rank-math";
    seo.title = seo.title ?? meta.rank_math_title;
    seo.description = seo.description ?? meta.rank_math_description;
    seo.focus_keyword = meta.rank_math_focus_keyword;
  }
  if (meta._aioseo_title || meta._aioseo_description) {
    seo.plugin = "aioseo";
    seo.title = seo.title ?? meta._aioseo_title;
    seo.description = seo.description ?? meta._aioseo_description;
  }
  if (meta._seopress_titles_title || meta._seopress_titles_desc) {
    seo.plugin = "seopress";
    seo.title = seo.title ?? meta._seopress_titles_title;
    seo.description = seo.description ?? meta._seopress_titles_desc;
  }
  if (Object.keys(seo).length === 0) return { plugin: null, note: "No SEO plugin fields were present on this item. If a plugin is active, its meta may not be registered with show_in_rest." };
  return seo;
}
