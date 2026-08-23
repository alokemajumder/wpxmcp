import { z } from "zod";
import { defineTool, ok, siteIdSchema, unwrap, stripHtml, wordCount, trimText, type ToolContext } from "../lib/tooling.js";
import { applyEdits, resolveUrl, summarizeContent, type EditOp } from "../lib/content-utils.js";
import { audit } from "../lib/safety.js";
import type { WordPressClient } from "../lib/client.js";

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
    "Targeted find/replace edits applied to the existing content, so you can change one paragraph without resending the whole document. Edits apply in order. Mutually exclusive with `content`."
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
    status: statusSchema.describe("publish | future | draft | pending | private | trash."),
    author: z.number().int().optional().describe("User ID of the author."),
    parent: z.number().int().optional().describe("Parent ID, for hierarchical types such as pages."),
    menu_order: z.number().int().optional().describe("Sort order for hierarchical types."),
    featured_media: z.number().int().optional().describe("Attachment ID of the featured image. Upload it with create_media first."),
    comment_status: z.enum(["open", "closed"]).optional().describe("Whether comments are open on this item."),
    ping_status: z.enum(["open", "closed"]).optional().describe("Whether pingbacks and trackbacks are accepted."),
    template: z.string().optional().describe("Page template file, e.g. \"templates/full-width.php\"."),
    format: z.string().optional().describe("Post format: standard, aside, gallery, link, image, quote, status, video, audio, chat."),
    sticky: z.boolean().optional().describe("Pin the post to the top of the blog. Posts only."),
    date: z.string().optional().describe("Publish date in site time, ISO 8601 (2026-01-31T09:00:00). With status \"future\" this schedules the post."),
    password: z.string().optional().describe("Password-protect the content."),
    meta: z.record(z.any()).optional().describe("Custom fields, as key/value pairs. A key only writes if it is registered with show_in_rest — use set_content_meta for unregistered keys."),
    terms: z.record(z.union([z.array(z.union([z.number(), z.string()])), z.number(), z.string()])).optional()
      .describe("Taxonomy assignments keyed by taxonomy REST base, e.g. {\"categories\": [3], \"tags\": [\"news\"]}. Names that do not exist yet are created."),
  };
}

/** Turns a friendly payload into the REST body, resolving term names to IDs. */
async function buildBody(client: WordPressClient, args: any, isCreate: boolean) {
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

    for (const [taxKey, rawValue] of Object.entries<any>(args.terms)) {
      const tax = byBase[taxKey] ?? (taxes[taxKey] ? { name: taxKey, ...taxes[taxKey] } : null);
      if (!tax) {
        throw new Error(`Unknown taxonomy "${taxKey}" in terms. Available REST bases: ${Object.keys(byBase).join(", ")}. Run discover_taxonomies.`);
      }
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      const ids: number[] = [];
      for (const value of values) {
        if (typeof value === "number") { ids.push(value); continue; }
        const search = await client.get<any[]>(`/wp/v2/${tax.rest_base}`, { search: value, per_page: 20 });
        const exact = search.data.find((t: any) => t.name.toLowerCase() === String(value).toLowerCase() || t.slug === value);
        if (exact) { ids.push(exact.id); continue; }
        const created = await client.post<any>(`/wp/v2/${tax.rest_base}`, { name: value });
        ids.push(created.data.id);
        notes.push(`Created the missing ${tax.name} term "${value}" (id ${created.data.id}).`);
      }
      body[tax.rest_base] = ids;
    }
  }
  return { body, notes };
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
          const entry: any = {
            type: name,
            rest_base: t.rest_base,
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
              const res = await client.get(`/wp/v2/${t.rest_base}`, { per_page: 1, status: "any", context: "edit" });
              entry.count = res.total ?? null;
            } catch {
              try {
                const res = await client.get(`/wp/v2/${t.rest_base}`, { per_page: 1 });
                entry.count = res.total ?? null;
                entry.count_note = "published only (unauthenticated count)";
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
        per_page: z.number().int().min(1).max(100).optional().default(20).describe("How many results per page."),
        page: z.number().int().min(1).optional().default(1).describe("Which page of results to return."),
        order: z.enum(["asc", "desc"]).optional().default("desc").describe("Sort direction."),
        orderby: z.enum(["date", "id", "include", "title", "slug", "modified", "menu_order", "relevance", "parent", "author"]).optional().default("date").describe("Which field to sort by."),
        author: z.number().int().optional().describe("Filter to one author's user ID."),
        parent: z.number().int().optional().describe("Filter to children of this parent ID."),
        slug: z.string().optional().describe("Filter by exact slug."),
        categories: z.array(z.union([z.number(), z.string()])).optional().describe("Category IDs to include."),
        tags: z.array(z.union([z.number(), z.string()])).optional().describe("Tag IDs to include."),
        taxonomy_filters: z.record(z.array(z.union([z.number(), z.string()]))).optional()
          .describe("Filter by any custom taxonomy, keyed by REST base, e.g. {\"product_cat\": [12]}."),
        after: z.string().optional().describe("Only items published after this ISO 8601 date."),
        before: z.string().optional().describe("Only items published before this ISO 8601 date."),
        modified_after: z.string().optional().describe("Only items modified after this ISO 8601 date."),
        full_content: z.boolean().optional().default(false).describe("Include the full content body of each item. Off by default — listings are for finding things."),
        fields: z.array(z.string()).optional().describe("Return only these top-level fields, overriding the default summary shape."),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        const restBase = await client.restBaseForType(args.type);
        const query: Record<string, unknown> = {
          search: args.search,
          per_page: args.per_page,
          page: args.page,
          order: args.order,
          orderby: args.orderby,
          author: args.author,
          parent: args.parent,
          slug: args.slug,
          categories: args.categories,
          tags: args.tags,
          after: args.after,
          before: args.before,
          modified_after: args.modified_after,
        };
        if (args.status) query.status = Array.isArray(args.status) ? args.status.join(",") : args.status;
        if (args.taxonomy_filters) for (const [k, v] of Object.entries(args.taxonomy_filters)) query[k] = v;
        // `edit` context exposes raw content and non-public statuses; harmless when authenticated.
        if (client.hasCredentials()) query.context = "edit";

        let res;
        try {
          res = await client.get<any[]>(`/wp/v2/${restBase}`, query);
        } catch (e: any) {
          if (args.status && args.status !== "publish" && !client.hasCredentials()) {
            throw new Error(`Listing "${args.status}" content requires authentication, and this site has no credentials configured. ${e.message}`);
          }
          delete query.context;
          res = await client.get<any[]>(`/wp/v2/${restBase}`, query);
        }

        const items = (res.data ?? []).map((item: any) => {
          if (args.fields?.length) {
            const picked: any = {};
            for (const f of args.fields) picked[f] = item[f];
            return picked;
          }
          const summary: any = summarizeContent(item, args.type);
          if (args.full_content) summary.content = unwrap(item.content);
          return summary;
        });

        return ok({
          site: client.site.id,
          type: args.type,
          rest_base: restBase,
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
        id: z.number().int().describe("The content ID."),
        type: z.string().optional().default("post").describe("Content type slug. Wrong type gives a 404 — use find_content_by_url or get_content_by_slug if unsure."),
        raw: z.boolean().optional().default(true).describe("Return the raw stored content rather than the rendered output. Keep true for editing; set false to see what visitors get."),
        include_meta: z.boolean().optional().default(true).describe("Include registered custom fields."),
        max_content_chars: z.number().int().optional().default(60000).describe("Truncate very long bodies at this many characters."),
      },
      handler: async ({ site_id, id, type, raw, include_meta, max_content_chars }) => {
        const client = site(site_id);
        const restBase = await client.restBaseForType(type);
        const query: Record<string, unknown> = {};
        if (client.hasCredentials()) query.context = "edit";
        const res = await client.get<any>(`/wp/v2/${restBase}/${id}`, query);
        const item = res.data;

        const content = raw ? unwrap(item.content) : (item.content?.rendered ?? unwrap(item.content));
        const payload: any = {
          ...summarizeContent(item, type),
          content: trimText(content, max_content_chars),
          content_length: content.length,
          content_is_blocks: /<!--\s*wp:/.test(content),
        };
        if (include_meta) payload.meta = item.meta ?? {};
        if (item.content?.protected) payload.protected = true;
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
        id: z.number().int().optional().describe("Content ID. Provide this or `url`."),
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
          const restBase = await client.restBaseForType(type);
          const query: Record<string, unknown> = {};
          if (client.hasCredentials()) query.context = "edit";
          item = (await client.get<any>(`/wp/v2/${restBase}/${id}`, query)).data;
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
        slug: z.string().describe("The slug, i.e. the last path segment of the URL."),
        types: z.array(z.string()).optional().describe("Restrict to these content types. Defaults to every REST-exposed type."),
        include_content: z.boolean().optional().default(false).describe("Include full bodies in the results."),
      },
      handler: async ({ site_id, slug, types, include_content }) => {
        const client = site(site_id);
        const all = await client.postTypes();
        const candidates = (types ?? Object.keys(all)).filter((t) => all[t]?.rest_base);
        const matches: any[] = [];
        const errors: Record<string, string> = {};

        for (const typeName of candidates) {
          const restBase = all[typeName].rest_base;
          const query: Record<string, unknown> = { slug, per_page: 5 };
          if (client.hasCredentials()) { query.context = "edit"; query.status = "any"; }
          try {
            const res = await client.get<any[]>(`/wp/v2/${restBase}`, query);
            for (const item of res.data ?? []) {
              const summary: any = summarizeContent(item, typeName);
              if (include_content) summary.content = unwrap(item.content);
              matches.push(summary);
            }
          } catch (e: any) {
            errors[typeName] = e.message;
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
        const resolution = await resolveUrl(client, args.url);

        if (!resolution.found) {
          return ok({ found: false, url: args.url, strategies_tried: resolution.candidatesTried, notes: resolution.notes },
            "Could not resolve that URL to any content.");
        }

        const base = {
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

        client.assertWritable("find_content_by_url (update)");
        const { body, notes } = await buildBody(client, args, false);

        if (args.edits?.length) {
          if (args.content !== undefined) throw new Error("Pass either `content` (full replacement) or `edits` (targeted changes), not both.");
          const current = unwrap(resolution.item.content);
          const result = applyEdits(current, args.edits as EditOp[]);
          if (!result.changed) {
            return ok({ ...base, updated: false, edit_report: result }, "The edits produced no change, so nothing was written.");
          }
          body.content = result.content;
          (base as any).edit_report = { applied: result.applied, skipped: result.skipped };
        }

        if (Object.keys(body).length === 0) {
          return ok({ ...base, updated: false }, "update was true but no fields were supplied, so nothing was written.");
        }

        const updated = await client.post<any>(`/wp/v2/${resolution.restBase}/${resolution.id}`, body);
        audit({ site: client.site.id, tool: "find_content_by_url", action: "update", target: resolution.id, outcome: "ok", detail: Object.keys(body).join(",") });

        return ok({ ...base, updated: true, changed_fields: Object.keys(body), notes: [...(base.notes ?? []), ...notes], result: summarizeContent(updated.data, resolution.type) });
      },
    }),

    /* ---------------------------------------------------------------- */
    defineTool({
      name: "create_content",
      title: "Create content",
      description:
        "Create a post, page, or any custom post type. Content is created as a DRAFT unless you explicitly pass status: \"publish\" — this server never publishes to a live site implicitly. Taxonomy terms can be given by name and are created if missing.",
      schema: {
        site_id: siteIdSchema,
        type: z.string().optional().default("post").describe("Content type to create."),
        ...contentPayloadShape(),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        client.assertWritable("create_content");
        const restBase = await client.restBaseForType(args.type);
        if (!args.title && !args.content) {
          throw new Error("Provide at least a `title` or `content` — WordPress will otherwise create an empty auto-draft.");
        }
        const { body, notes } = await buildBody(client, args, true);
        const res = await client.post<any>(`/wp/v2/${restBase}`, body);
        audit({ site: client.site.id, tool: "create_content", action: `create ${args.type}`, target: res.data.id, outcome: "ok", detail: String(body.status) });

        return ok({
          created: true,
          id: res.data.id,
          type: args.type,
          status: res.data.status,
          link: res.data.link,
          edit_link: `${client.site.url}/wp-admin/post.php?post=${res.data.id}&action=edit`,
          notes,
          summary: summarizeContent(res.data, args.type),
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
        id: z.number().int().describe("The content ID to update."),
        type: z.string().optional().default("post").describe("Content type of that ID."),
        edits: editSchema,
        ...contentPayloadShape(),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        client.assertWritable("update_content");
        const restBase = await client.restBaseForType(args.type);

        const { body, notes } = await buildBody(client, args, false);
        let editReport: any;

        if (args.edits?.length) {
          if (args.content !== undefined) throw new Error("Pass either `content` (full replacement) or `edits` (targeted changes), not both.");
          const currentRes = await client.get<any>(`/wp/v2/${restBase}/${args.id}`, client.hasCredentials() ? { context: "edit" } : {});
          const current = unwrap(currentRes.data.content);
          const result = applyEdits(current, args.edits as EditOp[]);
          if (!result.changed) {
            return ok({ updated: false, id: args.id, edit_report: result }, "The edits produced no change, so nothing was written.");
          }
          body.content = result.content;
          editReport = { applied: result.applied, skipped: result.skipped, before_length: current.length, after_length: result.content.length };
        }

        if (Object.keys(body).length === 0) {
          throw new Error("No changes were supplied. Pass fields to change (title, content, status…) or `edits`.");
        }

        const res = await client.post<any>(`/wp/v2/${restBase}/${args.id}`, body);
        audit({ site: client.site.id, tool: "update_content", action: `update ${args.type}`, target: args.id, outcome: "ok", detail: Object.keys(body).join(",") });

        return ok({
          updated: true,
          id: res.data.id,
          type: args.type,
          changed_fields: Object.keys(body),
          edit_report: editReport,
          notes,
          link: res.data.link,
          summary: summarizeContent(res.data, args.type),
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
        id: z.number().int().describe("The content ID to delete."),
        type: z.string().optional().default("post").describe("Content type of that ID."),
        force: z.boolean().optional().default(false).describe("Skip the trash and delete permanently. Requires confirm: true."),
        confirm: z.boolean().optional().default(false).describe("Explicit acknowledgement, required only for permanent deletion."),
      },
      handler: async ({ site_id, id, type, force, confirm }) => {
        const client = site(site_id);
        client.assertWritable("delete_content");
        const restBase = await client.restBaseForType(type);

        if (force && !confirm) {
          const current = await client.get<any>(`/wp/v2/${restBase}/${id}`, client.hasCredentials() ? { context: "edit" } : {});
          audit({ site: client.site.id, tool: "delete_content", action: "permanent delete", target: id, outcome: "refused", detail: "confirm not set" });
          return ok({
            deleted: false,
            requires_confirmation: true,
            id,
            type,
            title: stripHtml(unwrap(current.data.title)),
            status: current.data.status,
            link: current.data.link,
            word_count: wordCount(unwrap(current.data.content)),
          }, "Permanent deletion is irreversible, so it was not carried out. This is what would be destroyed — re-run with force: true AND confirm: true to proceed, or drop `force` to move it to the trash instead (recoverable).");
        }

        const res = await client.del<any>(`/wp/v2/${restBase}/${id}`, force ? { force: true } : undefined);
        audit({ site: client.site.id, tool: "delete_content", action: force ? "permanent delete" : "trash", target: id, outcome: "ok" });

        return ok({
          deleted: true,
          permanent: Boolean(force),
          id,
          type,
          previous_status: res.data?.previous?.status ?? res.data?.status,
          title: stripHtml(unwrap(res.data?.previous?.title ?? res.data?.title)),
        }, force ? "Permanently deleted." : "Moved to the trash — recoverable from wp-admin, or by updating its status away from \"trash\".");
      },
    }),
  ];
}
