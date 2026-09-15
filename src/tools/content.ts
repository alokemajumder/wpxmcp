import { z } from "zod";
import { defineTool, ok, siteIdSchema, unwrap, stripHtml, wordCount, trimText, type ToolContext } from "../lib/tooling.js";
import { applyEdits, resolveUrl, summarizeContent, type EditOp } from "../lib/content-utils.js";
import { audit } from "../lib/safety.js";
import type { WordPressClient } from "../lib/client.js";

/* ------------------------------------------------------------------ *
 * Shared helpers (also used by taxonomy.ts, media.ts and bulk.ts)
 * ------------------------------------------------------------------ */

export interface ResolvedRoute {
  /** Registered name, e.g. "post" or "category" — never the REST base. */
  name: string;
  restBase: string;
  /** Full collection route honouring a custom rest_namespace, e.g. "/wp/v2/posts". */
  route: string;
  info: any;
}

/**
 * Builds a collection route. Post types and taxonomies may register their own
 * rest_namespace (WordPress 5.9+), so hard-coding /wp/v2 misses those.
 */
export function routeFor(namespace: unknown, restBase: string): string {
  const ns = typeof namespace === "string" && namespace.trim() ? namespace.trim().replace(/^\/+|\/+$/g, "") : "wp/v2";
  return `/${ns}/${restBase}`;
}

/** Accepts a post type slug or its REST base and returns both, plus the route. */
export async function resolveType(client: WordPressClient, type: string): Promise<ResolvedRoute> {
  const restBase = await client.restBaseForType(type);
  const types = await client.postTypes();
  const name = types[type]?.rest_base ? type : (Object.keys(types).find((k) => types[k]?.rest_base === restBase) ?? type);
  return { name, restBase, route: routeFor(types[name]?.rest_namespace, restBase), info: types[name] };
}

/** Accepts a taxonomy slug or its REST base and returns both, plus the route. */
export async function resolveTaxonomy(client: WordPressClient, taxonomy: string): Promise<ResolvedRoute> {
  const restBase = await client.restBaseForTaxonomy(taxonomy);
  const taxes = await client.taxonomies();
  const name = taxes[taxonomy]?.rest_base ? taxonomy : (Object.keys(taxes).find((k) => taxes[k]?.rest_base === restBase) ?? taxonomy);
  return { name, restBase, route: routeFor(taxes[name]?.rest_namespace, restBase), info: taxes[name] };
}

/** WordPress stores term names HTML-escaped ("Q&amp;A"), so compare decoded text. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** Picks the term a name refers to from a search result, by decoded name or slug. */
export function matchTermByName(candidates: any[], wanted: string): any | undefined {
  const lower = wanted.trim().toLowerCase();
  return candidates.find((t) => decodeEntities(String(t?.name ?? "")).trim().toLowerCase() === lower || String(t?.slug ?? "") === lower);
}

/**
 * Resolves a mix of term IDs and names to IDs, optionally creating the missing
 * names. A create that races an existing term (term_exists) reuses that term.
 */
export async function resolveTermIds(
  client: WordPressClient,
  tax: { route: string },
  values: Array<number | string>,
  createMissing: boolean
): Promise<{ ids: number[]; created: Array<{ id: number; name: string }>; missing: string[] }> {
  const ids: number[] = [];
  const created: Array<{ id: number; name: string }> = [];
  const missing: string[] = [];
  for (const value of values) {
    if (typeof value === "number") { ids.push(value); continue; }
    const wanted = value.trim();
    if (!wanted) continue;
    const search = await client.get<any[]>(tax.route, { search: wanted, per_page: 100 });
    const exact = matchTermByName(Array.isArray(search.data) ? search.data : [], wanted);
    if (exact) { ids.push(exact.id); continue; }
    if (!createMissing) { missing.push(wanted); continue; }
    try {
      const made = await client.post<any>(tax.route, { name: wanted });
      ids.push(made.data.id);
      created.push({ id: made.data.id, name: decodeEntities(String(made.data.name ?? wanted)) });
    } catch (e: any) {
      // Search is a LIKE over the escaped stored name, so "Q&A" can miss "Q&amp;A";
      // WordPress then refuses the duplicate and tells us which term it was.
      const existing = e?.code === "term_exists" ? Number(e?.body?.data?.term_id ?? e?.body?.additional_data?.[0]) : NaN;
      if (Number.isInteger(existing) && existing > 0) { ids.push(existing); continue; }
      throw e;
    }
  }
  return { ids: [...new Set(ids)], created, missing };
}

/**
 * Best-effort detection of page-builder content, where editing post_content
 * either has no visible effect or corrupts the layout.
 */
export function detectBuilder(item: any): string | null {
  const content = item?.content;
  const raw = typeof content === "object" && content ? String(content.raw ?? "") : "";
  const rendered = typeof content === "object" && content ? String(content.rendered ?? "") : String(content ?? "");
  const meta = item?.meta ?? {};
  if (meta._elementor_edit_mode === "builder" || /data-elementor-type=|class="[^"]*\belementor-(?:section|element|widget)/.test(rendered)) return "Elementor";
  if (/\[et_pb_section\b/.test(raw) || /class="[^"]*\bet_pb_section\b/.test(rendered)) return "Divi";
  if (/class="[^"]*\bfl-builder-content\b/.test(rendered)) return "Beaver Builder";
  if (/class="[^"]*\bbrxe-/.test(rendered)) return "Bricks";
  if (/class="[^"]*\bbde-/.test(rendered)) return "Breakdance";
  if (/\[vc_row\b/.test(raw)) return "WPBakery";
  return null;
}

function builderWarning(item: any): string | undefined {
  const builder = detectBuilder(item);
  return builder
    ? `This item looks like ${builder} content. Builders keep the real layout in their own meta, so editing the body here may not show on the front end or may break the layout — load_skill for ${builder} before changing it.`
    : undefined;
}

/** The raw stored body, or a clear refusal when only rendered HTML is available. */
function rawBodyOf(item: any): string {
  const content = item?.content;
  if (content && typeof content === "object" && typeof content.raw === "string") return content.raw;
  if (typeof content === "string") return content;
  if (content === undefined) {
    throw new Error("This content type has no editable body (it does not support the editor), so `edits` cannot apply. Update individual fields instead.");
  }
  throw new Error(
    "Only the rendered HTML of this item is available, not the raw stored content — the credentials lack edit access to it. Applying edits to rendered output and writing it back would destroy block markup and shortcodes, so nothing was written."
  );
}

const editSchema = z
  .array(
    z.object({
      find: z.string().describe("Exact text to look for in the current content. Read the content first — block markup includes HTML comments like <!-- wp:paragraph -->."),
      replace: z.string().describe("What to put in its place. Use an empty string to delete the matched text."),
      regex: z.boolean().optional().describe("Treat `find` as a JavaScript regular expression (dot matches newlines). Default false."),
      all: z.boolean().optional().describe("Replace every occurrence. Default false, which requires the match to be unique."),
      required: z.boolean().optional().describe("Fail the whole call if this edit matches nothing. Default true, so a typo never silently no-ops."),
    })
  )
  .optional()
  .describe(
    "Targeted find/replace edits applied to the existing raw content, so you can change one paragraph without resending the whole document. Edits apply in order. Mutually exclusive with `content`."
  );

const statusSchema = z
  .enum(["publish", "future", "draft", "pending", "private", "trash"])
  .optional();

function contentPayloadShape() {
  return {
    title: z.string().optional().describe("The title, as plain text."),
    content: z.string().optional().describe("Full content body, replacing whatever is there. For the block editor this is block markup (<!-- wp:paragraph --><p>…</p><!-- /wp:paragraph -->); classic content is plain HTML. Use `edits` instead for a small change."),
    excerpt: z.string().optional().describe("Hand-written excerpt."),
    slug: z.string().optional().describe("URL slug. Changing this on published content breaks existing links unless you add a redirect."),
    status: statusSchema.describe("publish | future | draft | pending | private | trash. \"future\" needs a `date` in the future. \"trash\" moves the item to the trash (same as delete_content without force)."),
    author: z.number().int().optional().describe("User ID of the author."),
    parent: z.number().int().min(0).optional().describe("Parent ID, for hierarchical types such as pages. 0 for none."),
    menu_order: z.number().int().optional().describe("Sort order for hierarchical types."),
    featured_media: z.number().int().min(0).optional().describe("Attachment ID of the featured image, or 0 to remove it. Upload it with create_media first."),
    comment_status: z.enum(["open", "closed"]).optional().describe("Whether comments are open on this item."),
    ping_status: z.enum(["open", "closed"]).optional().describe("Whether pingbacks and trackbacks are accepted."),
    template: z.string().optional().describe("Page template file, e.g. \"templates/full-width.php\". Empty string for the default template."),
    format: z.enum(["standard", "aside", "chat", "gallery", "link", "image", "quote", "status", "video", "audio"]).optional().describe("Post format. Only applies to types that support post formats."),
    sticky: z.boolean().optional().describe("Pin the post to the top of the blog. Posts only."),
    date: z.string().optional().describe("Publish date in site time, ISO 8601 (2026-01-31T09:00:00). With status \"future\" (or \"publish\" and a future date) this schedules the post."),
    password: z.string().optional().describe("Password-protect the content. Empty string removes the password."),
    meta: z.record(z.string(), z.any()).optional().describe("Custom fields, as key/value pairs. A key only writes if it is registered with show_in_rest — use set_content_meta for unregistered keys."),
    terms: z.record(z.string(), z.union([z.array(z.union([z.number(), z.string()])), z.number(), z.string()])).optional()
      .describe("Taxonomy assignments keyed by taxonomy slug or REST base, e.g. {\"categories\": [3], \"tags\": [\"news\"]}. Replaces the item's terms in each taxonomy given. Names that do not exist yet are created."),
  };
}

/** Turns a friendly payload into the REST body, resolving term names to IDs. */
async function buildBody(client: WordPressClient, args: any, isCreate: boolean, typeName: string) {
  const body: Record<string, unknown> = {};
  const direct = ["title", "content", "excerpt", "slug", "author", "parent", "menu_order", "featured_media",
    "comment_status", "ping_status", "template", "format", "sticky", "date", "password", "meta", "status"];
  for (const key of direct) {
    if (args[key] !== undefined) body[key] = args[key];
  }

  // Guardrail: new content is a draft unless the caller explicitly asks otherwise.
  const notes: string[] = [];
  if (isCreate && args.status === undefined) {
    body.status = "draft";
    notes.push("Created as a draft — wpxmcp never publishes implicitly. Pass status: \"publish\" to publish, or publish it after review.");
  }

  if (args.terms) {
    const taxes = await client.taxonomies();
    const byBase: Record<string, any> = {};
    for (const [name, tax] of Object.entries<any>(taxes)) byBase[tax.rest_base] = { name, ...tax };

    // Validate every taxonomy before creating any term, so a typo cannot leave stray terms behind.
    const plan: Array<{ tax: any; values: Array<number | string> }> = [];
    for (const [taxKey, rawValue] of Object.entries<any>(args.terms)) {
      const tax = byBase[taxKey] ?? (taxes[taxKey] ? { name: taxKey, ...taxes[taxKey] } : null);
      if (!tax) {
        throw new Error(`Unknown taxonomy "${taxKey}" in terms. Available REST bases: ${Object.keys(byBase).join(", ")}. Run discover_taxonomies.`);
      }
      if (Array.isArray(tax.types) && !tax.types.includes(typeName)) {
        throw new Error(`Taxonomy "${tax.name}" is not attached to the "${typeName}" type (it applies to: ${tax.types.join(", ") || "nothing"}), so WordPress would silently ignore it. Run discover_taxonomies with for_type: "${typeName}".`);
      }
      plan.push({ tax, values: Array.isArray(rawValue) ? rawValue : [rawValue] });
    }
    for (const { tax, values } of plan) {
      const { ids, created } = await resolveTermIds(client, { route: routeFor(tax.rest_namespace, tax.rest_base) }, values, true);
      for (const c of created) notes.push(`Created the missing ${tax.name} term "${c.name}" (id ${c.id}).`);
      body[tax.rest_base] = ids;
    }
  }
  return { body, notes };
}

/**
 * WordPress's REST status enum excludes "trash" (it is an internal status), so
 * a status change to trash has to go through DELETE instead.
 */
async function writeUpdate(client: WordPressClient, route: string, id: number, body: Record<string, unknown>) {
  const trash = body.status === "trash";
  const fields = { ...body };
  if (trash) delete fields.status;
  let data: any;
  if (Object.keys(fields).length) data = (await client.post<any>(`${route}/${id}`, fields)).data;
  if (trash) data = (await client.del<any>(`${route}/${id}`)).data;
  return { data, trashed: trash };
}

export function contentTools(ctx: ToolContext) {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    /* ---------------------------------------------------------------- */
    defineTool({
      name: "discover_content_types",
      title: "Discover content types",
      readOnly: true,
      description:
        "List every content type registered on the site — post, page, and any custom post type — with its REST base, whether it is hierarchical, which taxonomies apply, and which fields it supports. Call this before working with an unfamiliar site: a type absent here is registered with show_in_rest => false and cannot be reached over REST at all.",
      schema: {
        site_id: siteIdSchema,
        include_counts: z.boolean().optional().default(false).describe("Also report how many items exist per type. Costs one extra request per type."),
      },
      handler: async ({ site_id, include_counts }) => {
        const client = site(site_id);
        const types = await client.postTypes(true);
        const out: any[] = [];
        for (const [name, t] of Object.entries<any>(types)) {
          const route = routeFor(t.rest_namespace, t.rest_base);
          const entry: any = {
            type: name,
            rest_base: t.rest_base,
            rest_namespace: t.rest_namespace && t.rest_namespace !== "wp/v2" ? t.rest_namespace : undefined,
            label: t.name,
            description: t.description || undefined,
            hierarchical: t.hierarchical,
            viewable: t.viewable,
            taxonomies: t.taxonomies ?? [],
            supports: t.supports ? Object.keys(t.supports).filter((k) => t.supports[k]) : undefined,
            has_archive: t.has_archive ?? undefined,
            rewrite_slug: t.rewrite?.slug ?? undefined,
          };
          if (include_counts) {
            try {
              // Attachments only accept inherit/private/trash, not "any".
              const status = name === "attachment" ? undefined : "any";
              const res = await client.get(route, { per_page: 1, status, context: "edit" });
              entry.count = res.total ?? null;
            } catch {
              try {
                const res = await client.get(route, { per_page: 1 });
                entry.count = res.total ?? null;
                entry.count_note = "published only (edit-context count was refused)";
              } catch { entry.count = null; }
            }
          }
          out.push(entry);
        }
        return ok({ site: client.site.id, count: out.length, types: out });
      },
    }),

    /* ---------------------------------------------------------------- */
    defineTool({
      name: "list_content",
      title: "List content",
      readOnly: true,
      description:
        "List items of any content type — posts, pages, or a custom post type — with filtering, search, ordering and pagination. Returns compact summaries by default so a listing never floods the context; pass full_content: true only when you genuinely need bodies.",
      schema: {
        site_id: siteIdSchema,
        type: z.string().optional().default("post").describe("Content type slug (post, page, or a CPT such as \"product\"). Run discover_content_types if unsure."),
        search: z.string().optional().describe("Free-text search across title and content."),
        status: z.union([z.string(), z.array(z.string())]).optional().describe("Filter by status: publish, draft, pending, private, future, trash, or \"any\". Anything other than publish requires authentication."),
        per_page: z.number().int().min(1).max(100).optional().default(20).describe("How many results per page (WordPress caps this at 100)."),
        page: z.number().int().min(1).optional().default(1).describe("Which page of results to return."),
        order: z.enum(["asc", "desc"]).optional().default("desc").describe("Sort direction."),
        orderby: z.enum(["date", "id", "include", "title", "slug", "modified", "menu_order", "relevance", "parent", "author"]).optional().default("date").describe("Which field to sort by. \"relevance\" requires `search`; \"include\" requires `include`."),
        author: z.number().int().optional().describe("Filter to one author's user ID."),
        parent: z.number().int().optional().describe("Filter to children of this parent ID (0 for top-level items)."),
        slug: z.string().optional().describe("Filter by exact slug."),
        include: z.array(z.number().int()).max(100).optional().describe("Only these IDs."),
        exclude: z.array(z.number().int()).optional().describe("Leave out these IDs."),
        sticky: z.boolean().optional().describe("Posts only: true for only sticky posts, false to leave them out."),
        categories: z.array(z.union([z.number(), z.string()])).optional().describe("Category IDs to include."),
        tags: z.array(z.union([z.number(), z.string()])).optional().describe("Tag IDs to include."),
        taxonomy_filters: z.record(z.string(), z.array(z.union([z.number(), z.string()]))).optional()
          .describe("Filter by any custom taxonomy, keyed by REST base, e.g. {\"product_cat\": [12]}."),
        after: z.string().optional().describe("Only items published after this ISO 8601 date."),
        before: z.string().optional().describe("Only items published before this ISO 8601 date."),
        modified_after: z.string().optional().describe("Only items modified after this ISO 8601 date."),
        full_content: z.boolean().optional().default(false).describe("Include the full content body of each item. Off by default — listings are for finding things."),
        fields: z.array(z.string()).optional().describe("Return only these top-level fields, overriding the default summary shape. Also sent as _fields so WordPress returns less."),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        const type = await resolveType(client, args.type);
        if (args.orderby === "relevance" && !args.search) throw new Error("orderby \"relevance\" requires `search`.");
        if (args.orderby === "include" && !args.include?.length) throw new Error("orderby \"include\" requires `include`.");
        const query: Record<string, unknown> = {
          search: args.search,
          per_page: args.per_page,
          page: args.page,
          order: args.order,
          orderby: args.orderby,
          author: args.author,
          parent: args.parent,
          slug: args.slug,
          include: args.include,
          exclude: args.exclude,
          sticky: args.sticky,
          categories: args.categories,
          tags: args.tags,
          after: args.after,
          before: args.before,
          modified_after: args.modified_after,
          _fields: args.fields?.length ? args.fields : undefined,
        };
        if (args.status) query.status = Array.isArray(args.status) ? args.status.join(",") : args.status;
        if (args.taxonomy_filters) for (const [k, v] of Object.entries(args.taxonomy_filters)) query[k] = v;
        // `edit` context exposes raw content and non-public statuses; harmless when authenticated.
        if (client.hasCredentials()) query.context = "edit";

        let res;
        try {
          res = await client.get<any[]>(type.route, query);
        } catch (e: any) {
          if (args.status && args.status !== "publish" && !client.hasCredentials()) {
            throw new Error(`Listing "${args.status}" content requires authentication, and this site has no credentials configured. ${e.message}`);
          }
          if (!query.context) throw e;
          delete query.context;
          res = await client.get<any[]>(type.route, query);
        }

        const items = (res.data ?? []).map((item: any) => {
          if (args.fields?.length) {
            const picked: any = {};
            for (const f of args.fields) picked[f] = item[f];
            return picked;
          }
          const summary: any = summarizeContent(item, type.name);
          if (args.full_content) summary.content = unwrap(item.content);
          return summary;
        });

        return ok({
          site: client.site.id,
          type: type.name,
          rest_base: type.restBase,
          page: args.page,
          per_page: args.per_page,
          total: res.total ?? items.length,
          total_pages: res.totalPages ?? 1,
          returned: items.length,
          items,
        });
      },
    }),

    /* ---------------------------------------------------------------- */
    defineTool({
      name: "get_content",
      title: "Get content by ID",
      readOnly: true,
      description:
        "Fetch one item of any content type by ID, including the raw content body exactly as stored — which is what you must read before making targeted edits, since the block editor stores markup with HTML comment delimiters.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().min(1).describe("The content ID."),
        type: z.string().optional().default("post").describe("Content type slug. Wrong type gives a 404 — use find_content_by_url or get_content_by_slug if unsure."),
        raw: z.boolean().optional().default(true).describe("Return the raw stored content rather than the rendered output. Keep true for editing; set false to see what visitors get."),
        include_meta: z.boolean().optional().default(true).describe("Include registered custom fields."),
        max_content_chars: z.number().int().min(100).optional().default(60000).describe("Truncate very long bodies at this many characters."),
      },
      handler: async ({ site_id, id, type, raw, include_meta, max_content_chars }) => {
        const client = site(site_id);
        const resolved = await resolveType(client, type);
        const query: Record<string, unknown> = {};
        if (client.hasCredentials()) query.context = "edit";
        const res = await client.get<any>(`${resolved.route}/${id}`, query);
        const item = res.data;

        const hasRaw = typeof item.content?.raw === "string";
        const content = raw ? unwrap(item.content) : (item.content?.rendered ?? unwrap(item.content));
        const payload: any = {
          ...summarizeContent(item, resolved.name),
          content: trimText(content, max_content_chars),
          content_format: raw && !hasRaw ? "rendered (raw content needs credentials with edit access)" : raw ? "raw" : "rendered",
          content_length: content.length,
          content_is_blocks: /<!--\s*wp:/.test(content),
          sticky: item.sticky,
          menu_order: item.menu_order,
          format: item.format,
        };
        if (include_meta) payload.meta = item.meta ?? {};
        if (item.content?.protected) payload.protected = true;
        const warning = builderWarning(item);
        if (warning) payload.builder_warning = warning;
        return ok(payload);
      },
    }),

    /* ---------------------------------------------------------------- */
    defineTool({
      name: "get_content_summary",
      title: "Get a content summary",
      readOnly: true,
      description:
        "Return a minimal summary of one item — id, title, slug, status, excerpt, taxonomies, word count and SEO fields (Yoast, Rank Math, AIOSEO or SEOPress) — without the body. Built for audits and lookups over many items. Accepts either an id (with type) or a full URL.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().min(1).optional().describe("Content ID. Provide this or `url`."),
        type: z.string().optional().default("post").describe("Content type, used with `id`."),
        url: z.string().optional().describe("Any front-end URL on the site; the type is detected automatically."),
      },
      handler: async ({ site_id, id, type, url }) => {
        const client = site(site_id);
        if (!id && !url) throw new Error("Provide either `id` (with `type`) or `url`.");
        let item: any;
        let resolvedType = type;

        if (url) {
          const resolution = await resolveUrl(client, url);
          if (!resolution.found) {
            return ok({ found: false, url, tried: resolution.candidatesTried, notes: resolution.notes }, "No content matched that URL.");
          }
          item = resolution.item;
          resolvedType = resolution.type!;
        } else {
          const resolved = await resolveType(client, type);
          resolvedType = resolved.name;
          const query: Record<string, unknown> = {};
          if (client.hasCredentials()) query.context = "edit";
          item = (await client.get<any>(`${resolved.route}/${id}`, query)).data;
        }
        return ok({ found: true, ...summarizeContent(item, resolvedType) });
      },
    }),

    /* ---------------------------------------------------------------- */
    defineTool({
      name: "get_content_by_slug",
      title: "Find content by slug",
      readOnly: true,
      description:
        "Look up content by slug across every content type at once, or within specific types. Use when you know the URL tail but not which post type owns it.",
      schema: {
        site_id: siteIdSchema,
        slug: z.string().min(1).describe("The slug, i.e. the last path segment of the URL."),
        types: z.array(z.string()).optional().describe("Restrict to these content types. Defaults to every REST-exposed content type."),
        include_content: z.boolean().optional().default(false).describe("Include full bodies in the results."),
      },
      handler: async ({ site_id, slug, types, include_content }) => {
        const client = site(site_id);
        const all = await client.postTypes();
        // Editor-internal types answer slug queries poorly (or not at all) and are never what a URL points at.
        const internal = new Set(["attachment", "nav_menu_item", "wp_block", "wp_template", "wp_template_part", "wp_navigation", "wp_global_styles", "wp_font_family", "wp_font_face"]);
        const requested = types?.map((t) => all[t] ? t : (Object.keys(all).find((k) => all[k]?.rest_base === t) ?? t));
        const candidates = (requested ?? Object.keys(all).filter((t) => !internal.has(t))).filter((t) => all[t]?.rest_base);
        const matches: any[] = [];
        const errors: Record<string, string> = {};

        for (const typeName of candidates) {
          const route = routeFor(all[typeName].rest_namespace, all[typeName].rest_base);
          const query: Record<string, unknown> = { slug, per_page: 5 };
          if (client.hasCredentials()) { query.context = "edit"; query.status = "any"; }
          let data: any[] | undefined;
          try {
            data = (await client.get<any[]>(route, query)).data;
          } catch (e: any) {
            if (query.context) {
              // The user may lack edit rights on this type; the public listing still answers.
              try { data = (await client.get<any[]>(route, { slug, per_page: 5 })).data; } catch { /* reported below */ }
            }
            if (!data) errors[typeName] = e.message;
          }
          for (const item of data ?? []) {
            const summary: any = summarizeContent(item, typeName);
            if (include_content) summary.content = unwrap(item.content);
            matches.push(summary);
          }
        }
        return ok(
          { site: client.site.id, slug, searched_types: candidates.length, match_count: matches.length, matches, type_errors: Object.keys(errors).length ? errors : undefined },
          matches.length === 0 ? `Nothing with slug "${slug}" in ${candidates.length} content types. It may be a taxonomy term archive — try list_terms.` : undefined
        );
      },
    }),

    /* ---------------------------------------------------------------- */
    defineTool({
      name: "find_content_by_url",
      title: "Find (and optionally update) content by URL",
      description:
        "Resolve any WordPress front-end URL to the content behind it, detecting the post type from the URL shape (so /documentation/getting-started/ finds the `documentation` custom post type), then optionally update it in the same call. This is the tool to reach for when a human hands you a link. Detection tries, in order: an explicit ?p= id, the site's own search index, the registered rewrite base, then a slug sweep across every type.",
      schema: {
        site_id: siteIdSchema,
        url: z.string().describe("Any URL on the site — permalink, ?p=123, or a pretty CPT URL."),
        update: z.boolean().optional().default(false).describe("Apply the supplied changes once the content is found. Off by default, so this tool is safe to use purely for lookup."),
        edits: editSchema,
        ...contentPayloadShape(),
        include_content: z.boolean().optional().default(false).describe("Return the full body along with the match."),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        if (args.update) {
          client.assertWritable("find_content_by_url (update)");
          if (args.edits?.length && args.content !== undefined) {
            throw new Error("Pass either `content` (full replacement) or `edits` (targeted changes), not both.");
          }
        }
        const resolution = await resolveUrl(client, args.url);

        if (!resolution.found) {
          return ok({ found: false, url: args.url, strategies_tried: resolution.candidatesTried, notes: resolution.notes },
            "Could not resolve that URL to any content.");
        }

        const types = await client.postTypes();
        const route = routeFor(types[resolution.type!]?.rest_namespace, resolution.restBase!);
        const base: any = {
          found: true,
          id: resolution.id,
          type: resolution.type,
          rest_base: resolution.restBase,
          resolved_by: resolution.strategy,
          notes: resolution.notes.length ? resolution.notes : undefined,
          summary: summarizeContent(resolution.item, resolution.type),
        };

        if (!args.update) {
          const payload: any = { ...base };
          if (args.include_content) payload.content = unwrap(resolution.item.content);
          return ok(payload);
        }

        const extraNotes: string[] = [];
        let newContent: string | undefined;
        if (args.edits?.length) {
          // The resolver may have fallen back to the public (rendered) view, so
          // always re-read in edit context before rewriting the body.
          const fresh = (await client.get<any>(`${route}/${resolution.id}`, { context: "edit" })).data;
          const current = rawBodyOf(fresh);
          const result = applyEdits(current, args.edits as EditOp[]);
          base.edit_report = { applied: result.applied, skipped: result.skipped };
          if (result.changed) newContent = result.content;
          const warning = builderWarning(fresh);
          if (warning) extraNotes.push(warning);
        }

        const { body, notes } = await buildBody(client, { ...args, content: newContent ?? args.content }, false, resolution.type!);
        if (Object.keys(body).length === 0) {
          return ok({ ...base, updated: false },
            args.edits?.length ? "The edits produced no change and no other fields were supplied, so nothing was written." : "update was true but no fields were supplied, so nothing was written.");
        }

        const { data, trashed } = await writeUpdate(client, route, resolution.id!, body);
        audit({ site: client.site.id, tool: "find_content_by_url", action: trashed ? "update+trash" : "update", target: resolution.id, outcome: "ok", detail: Object.keys(body).join(",") });

        return ok({ ...base, updated: true, trashed: trashed || undefined, changed_fields: Object.keys(body), notes: [...(base.notes ?? []), ...notes, ...extraNotes], result: summarizeContent(data, resolution.type) });
      },
    }),

    /* ---------------------------------------------------------------- */
    defineTool({
      name: "create_content",
      title: "Create content",
      description:
        "Create a post, page, or any custom post type. Content is created as a DRAFT unless you explicitly pass status: \"publish\" — this server never publishes to a live site implicitly. Schedule by passing status: \"future\" with a future `date`. Taxonomy terms can be given by name and are created if missing.",
      schema: {
        site_id: siteIdSchema,
        type: z.string().optional().default("post").describe("Content type to create."),
        ...contentPayloadShape(),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        client.assertWritable("create_content");
        const type = await resolveType(client, args.type);
        if (!args.title && !args.content) {
          throw new Error("Provide at least a `title` or `content` — WordPress will otherwise create an empty auto-draft.");
        }
        if (args.status === "trash") throw new Error("New content cannot be created straight into the trash. Use draft instead.");
        if (args.status === "future" && !args.date) {
          throw new Error("status \"future\" needs a `date` in the future — without one WordPress publishes immediately.");
        }
        const { body, notes } = await buildBody(client, args, true, type.name);
        const res = await client.post<any>(type.route, body);
        audit({ site: client.site.id, tool: "create_content", action: `create ${type.name}`, target: res.data.id, outcome: "ok", detail: String(body.status) });
        if (args.status === "future" && res.data.status === "publish") {
          notes.push("The date given was not in the future, so WordPress published the item immediately instead of scheduling it.");
        }

        return ok({
          created: true,
          id: res.data.id,
          type: type.name,
          status: res.data.status,
          date: res.data.date,
          link: res.data.link,
          edit_link: `${client.site.url}/wp-admin/post.php?post=${res.data.id}&action=edit`,
          notes,
          summary: summarizeContent(res.data, type.name),
        });
      },
    }),

    /* ---------------------------------------------------------------- */
    defineTool({
      name: "update_content",
      title: "Update content",
      description:
        "Update any content type by ID. Supply `content` to replace the body wholesale, or `edits` for targeted find/replace changes that leave the rest of the document untouched — the latter is safer on long pages and is what you should reach for when changing a heading, a price, or one paragraph. An edit that matches nothing fails loudly rather than silently writing nothing.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().min(1).describe("The content ID to update."),
        type: z.string().optional().default("post").describe("Content type of that ID."),
        edits: editSchema,
        ...contentPayloadShape(),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        client.assertWritable("update_content");
        const type = await resolveType(client, args.type);
        if (args.edits?.length && args.content !== undefined) {
          throw new Error("Pass either `content` (full replacement) or `edits` (targeted changes), not both.");
        }

        let editReport: any;
        let newContent: string | undefined;
        const extraNotes: string[] = [];
        if (args.edits?.length) {
          const currentRes = await client.get<any>(`${type.route}/${args.id}`, { context: "edit" });
          const current = rawBodyOf(currentRes.data);
          const result = applyEdits(current, args.edits as EditOp[]);
          editReport = { applied: result.applied, skipped: result.skipped, before_length: current.length, after_length: result.content.length };
          if (result.changed) newContent = result.content;
          const warning = builderWarning(currentRes.data);
          if (warning) extraNotes.push(warning);
        }

        const { body, notes } = await buildBody(client, { ...args, content: newContent ?? args.content }, false, type.name);

        if (Object.keys(body).length === 0) {
          if (args.edits?.length) {
            return ok({ updated: false, id: args.id, edit_report: editReport }, "The edits produced no change and no other fields were supplied, so nothing was written.");
          }
          throw new Error("No changes were supplied. Pass fields to change (title, content, status…) or `edits`.");
        }

        const { data, trashed } = await writeUpdate(client, type.route, args.id, body);
        audit({ site: client.site.id, tool: "update_content", action: `${trashed ? "update+trash" : "update"} ${type.name}`, target: args.id, outcome: "ok", detail: Object.keys(body).join(",") });

        return ok({
          updated: true,
          id: data?.id ?? args.id,
          type: type.name,
          status: data?.status,
          trashed: trashed || undefined,
          changed_fields: Object.keys(body),
          edit_report: editReport,
          notes: [...notes, ...extraNotes],
          link: data?.link,
          summary: data ? summarizeContent(data, type.name) : undefined,
        });
      },
    }),

    /* ---------------------------------------------------------------- */
    defineTool({
      name: "delete_content",
      title: "Delete content",
      destructive: true,
      description:
        "Delete content of any type. By default it goes to the trash and stays recoverable from wp-admin. Permanent deletion requires force: true AND confirm: true, and cannot be undone — the row is removed from the database along with its meta.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().min(1).describe("The content ID to delete."),
        type: z.string().optional().default("post").describe("Content type of that ID."),
        force: z.boolean().optional().default(false).describe("Skip the trash and delete permanently. Requires confirm: true."),
        confirm: z.boolean().optional().default(false).describe("Explicit acknowledgement, required only for permanent deletion."),
      },
      handler: async ({ site_id, id, type, force, confirm }) => {
        const client = site(site_id);
        client.assertWritable("delete_content");
        const resolved = await resolveType(client, type);

        if (force && !confirm) {
          const current = await client.get<any>(`${resolved.route}/${id}`, { context: "edit" });
          audit({ site: client.site.id, tool: "delete_content", action: "permanent delete", target: id, outcome: "refused", detail: "confirm not set" });
          return ok({
            deleted: false,
            requires_confirmation: true,
            id,
            type: resolved.name,
            title: stripHtml(unwrap(current.data.title)),
            status: current.data.status,
            link: current.data.link,
            word_count: wordCount(unwrap(current.data.content)),
          }, "Permanent deletion is irreversible, so it was not carried out. This is what would be destroyed — re-run with force: true AND confirm: true to proceed, or drop `force` to move it to the trash instead (recoverable).");
        }

        let res;
        try {
          res = await client.del<any>(`${resolved.route}/${id}`, force ? { force: true } : undefined);
        } catch (e: any) {
          if (e?.code === "rest_trash_not_supported") {
            throw new Error(`This ${resolved.name} cannot be trashed (the type or site does not support the trash — e.g. EMPTY_TRASH_DAYS is 0), so nothing was deleted. Deleting it means permanent removal: re-run with force: true to preview, then force: true AND confirm: true.`);
          }
          if (e?.code === "rest_already_trashed") {
            throw new Error(`${resolved.name} ${id} is already in the trash. To remove it for good, re-run with force: true to preview, then force: true AND confirm: true. To restore it, update_content with status: "draft".`);
          }
          throw e;
        }
        audit({ site: client.site.id, tool: "delete_content", action: force ? "permanent delete" : "trash", target: id, outcome: "ok" });

        return ok({
          deleted: true,
          permanent: Boolean(force),
          id,
          type: resolved.name,
          // A trash returns the post itself (now "trash"); a force delete returns { deleted, previous }.
          status: force ? undefined : res.data?.status,
          previous_status: force ? res.data?.previous?.status : undefined,
          title: stripHtml(unwrap(res.data?.previous?.title ?? res.data?.title)),
        }, force ? "Permanently deleted." : "Moved to the trash — recoverable from wp-admin, or by updating its status to \"draft\".");
      },
    }),
  ];
}
