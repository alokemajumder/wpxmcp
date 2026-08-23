import { z } from "zod";
import { defineTool, ok, siteIdSchema, stripHtml, type ToolContext } from "../lib/tooling.js";
import { audit } from "../lib/safety.js";

function shapeTerm(term: any, taxonomy?: string) {
  return {
    id: term.id,
    taxonomy: term.taxonomy ?? taxonomy,
    name: stripHtml(String(term.name ?? "")),
    slug: term.slug,
    description: stripHtml(String(term.description ?? "")).slice(0, 500),
    parent: term.parent ?? 0,
    count: term.count,
    link: term.link,
    meta: term.meta && Object.keys(term.meta).length ? term.meta : undefined,
  };
}

export function taxonomyTools(ctx: ToolContext) {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    defineTool({
      name: "discover_taxonomies",
      title: "Discover taxonomies",
      readOnly: true,
      description:
        "List every taxonomy on the site — categories, tags, and any custom taxonomy — with its REST base, which post types it applies to, and whether it is hierarchical. A taxonomy missing here is registered with show_in_rest => false and is unreachable over REST.",
      schema: {
        site_id: siteIdSchema,
        for_type: z.string().optional().describe("Only taxonomies attached to this content type."),
      },
      handler: async ({ site_id, for_type }) => {
        const client = site(site_id);
        const taxes = await client.taxonomies(true);
        const list = Object.entries<any>(taxes)
          .filter(([, t]) => !for_type || (t.types ?? []).includes(for_type))
          .map(([name, t]) => ({
            taxonomy: name,
            rest_base: t.rest_base,
            label: t.name,
            description: t.description || undefined,
            hierarchical: t.hierarchical,
            applies_to: t.types ?? [],
            visibility: t.visibility ?? undefined,
          }));
        return ok({ site: client.site.id, count: list.length, taxonomies: list });
      },
    }),

    defineTool({
      name: "list_terms",
      title: "List taxonomy terms",
      readOnly: true,
      description:
        "List terms in any taxonomy with search, ordering, hierarchy filtering and pagination. Works for categories, tags and custom taxonomies alike.",
      schema: {
        site_id: siteIdSchema,
        taxonomy: z.string().optional().default("category").describe("Taxonomy slug or REST base (category, post_tag/tags, or a custom one)."),
        search: z.string().optional().describe("Match against term names."),
        slug: z.string().optional().describe("Filter by exact slug."),
        parent: z.number().int().optional().describe("Only direct children of this term ID. Hierarchical taxonomies only."),
        post: z.number().int().optional().describe("Only terms assigned to this content ID."),
        hide_empty: z.boolean().optional().default(false).describe("Skip terms with no content assigned."),
        per_page: z.number().int().min(1).max(100).optional().default(50).describe("How many results per page."),
        page: z.number().int().min(1).optional().default(1).describe("Which page of results to return."),
        orderby: z.enum(["id", "include", "name", "slug", "term_group", "description", "count"]).optional().default("name").describe("Which field to sort by."),
        order: z.enum(["asc", "desc"]).optional().default("asc").describe("Sort direction."),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        const restBase = await client.restBaseForTaxonomy(args.taxonomy);
        const res = await client.get<any[]>(`/wp/v2/${restBase}`, {
          search: args.search,
          slug: args.slug,
          parent: args.parent,
          post: args.post,
          hide_empty: args.hide_empty,
          per_page: args.per_page,
          page: args.page,
          orderby: args.orderby,
          order: args.order,
        });
        return ok({
          site: client.site.id,
          taxonomy: args.taxonomy,
          rest_base: restBase,
          total: res.total ?? res.data.length,
          total_pages: res.totalPages ?? 1,
          page: args.page,
          terms: res.data.map((t) => shapeTerm(t, args.taxonomy)),
        });
      },
    }),

    defineTool({
      name: "get_term",
      title: "Get a term",
      readOnly: true,
      description: "Fetch one taxonomy term by ID, including its description, parent, item count and any registered term meta.",
      schema: {
        site_id: siteIdSchema,
        taxonomy: z.string().optional().default("category").describe("Taxonomy slug or REST base (category, post_tag/tags, or a custom one)."),
        id: z.number().int().describe("The term ID."),
      },
      handler: async ({ site_id, taxonomy, id }) => {
        const client = site(site_id);
        const restBase = await client.restBaseForTaxonomy(taxonomy);
        const res = await client.get<any>(`/wp/v2/${restBase}/${id}`, client.hasCredentials() ? { context: "edit" } : {});
        return ok(shapeTerm(res.data, taxonomy));
      },
    }),

    defineTool({
      name: "create_term",
      title: "Create a term",
      description: "Create a term in any taxonomy. If a term with the same name already exists, WordPress rejects it — search with list_terms first when you might be duplicating.",
      schema: {
        site_id: siteIdSchema,
        taxonomy: z.string().optional().default("category").describe("Taxonomy to create the term in."),
        name: z.string().describe("Display name of the term."),
        slug: z.string().optional().describe("URL slug. Derived from the name if omitted."),
        description: z.string().optional().describe("Longer descriptive text."),
        parent: z.number().int().optional().describe("Parent term ID. Hierarchical taxonomies only — passing this on a flat taxonomy such as tags is an error."),
        meta: z.record(z.any()).optional().describe("Term meta, for keys registered with show_in_rest."),
      },
      handler: async ({ site_id, taxonomy, ...rest }) => {
        const client = site(site_id);
        client.assertWritable("create_term");
        const restBase = await client.restBaseForTaxonomy(taxonomy);
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
        const res = await client.post<any>(`/wp/v2/${restBase}`, body);
        audit({ site: client.site.id, tool: "create_term", action: `create ${taxonomy}`, target: res.data.id, outcome: "ok", detail: String(rest.name) });
        return ok({ created: true, ...shapeTerm(res.data, taxonomy) });
      },
    }),

    defineTool({
      name: "update_term",
      title: "Update a term",
      description: "Update a term's name, slug, description, parent or meta in any taxonomy. Changing a slug changes the term archive URL.",
      schema: {
        site_id: siteIdSchema,
        taxonomy: z.string().optional().default("category").describe("Taxonomy slug or REST base (category, post_tag/tags, or a custom one)."),
        id: z.number().int().describe("The term ID to update."),
        name: z.string().optional().describe("Display name."),
        slug: z.string().optional().describe("URL slug."),
        description: z.string().optional().describe("Longer descriptive text."),
        parent: z.number().int().optional().describe("Parent ID, or 0 for none."),
        meta: z.record(z.any()).optional().describe("Custom fields as key/value pairs, for keys registered with show_in_rest."),
      },
      handler: async ({ site_id, taxonomy, id, ...rest }) => {
        const client = site(site_id);
        client.assertWritable("update_term");
        const restBase = await client.restBaseForTaxonomy(taxonomy);
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
        if (Object.keys(body).length === 0) throw new Error("No fields to update were supplied.");
        const res = await client.post<any>(`/wp/v2/${restBase}/${id}`, body);
        audit({ site: client.site.id, tool: "update_term", action: `update ${taxonomy}`, target: id, outcome: "ok", detail: Object.keys(body).join(",") });
        return ok({ updated: true, changed_fields: Object.keys(body), ...shapeTerm(res.data, taxonomy) });
      },
    }),

    defineTool({
      name: "delete_term",
      title: "Delete a term",
      destructive: true,
      description:
        "Delete a term from any taxonomy. Terms have no trash — deletion is immediate and permanent, so this reports what will be affected and requires confirm: true. Content assigned to the term is not deleted; it simply loses the assignment (posts losing their only category fall back to the default category).",
      schema: {
        site_id: siteIdSchema,
        taxonomy: z.string().optional().default("category").describe("Taxonomy slug or REST base (category, post_tag/tags, or a custom one)."),
        id: z.number().int().describe("The term ID to delete."),
        confirm: z.boolean().optional().default(false).describe("Required — term deletion cannot be undone."),
      },
      handler: async ({ site_id, taxonomy, id, confirm }) => {
        const client = site(site_id);
        client.assertWritable("delete_term");
        const restBase = await client.restBaseForTaxonomy(taxonomy);

        if (!confirm) {
          const current = await client.get<any>(`/wp/v2/${restBase}/${id}`);
          const children = await client.get<any[]>(`/wp/v2/${restBase}`, { parent: id, per_page: 100 }).catch(() => ({ data: [] as any[] }));
          audit({ site: client.site.id, tool: "delete_term", action: "delete", target: id, outcome: "refused", detail: "confirm not set" });
          return ok({
            deleted: false,
            requires_confirmation: true,
            term: shapeTerm(current.data, taxonomy),
            assigned_items: current.data.count,
            child_terms: children.data.map((c: any) => ({ id: c.id, name: c.name })),
          }, `Terms cannot be recovered once deleted, so nothing was removed. This term is on ${current.data.count} item(s)${children.data.length ? ` and has ${children.data.length} child term(s), which will be re-parented` : ""}. Re-run with confirm: true to delete it.`);
        }

        const res = await client.del<any>(`/wp/v2/${restBase}/${id}`, { force: true });
        audit({ site: client.site.id, tool: "delete_term", action: "delete", target: id, outcome: "ok" });
        return ok({ deleted: true, term: shapeTerm(res.data?.previous ?? { id }, taxonomy) });
      },
    }),

    defineTool({
      name: "assign_terms_to_content",
      title: "Assign terms to content",
      description:
        "Assign taxonomy terms to any content item. Terms may be given as IDs or as names — names that do not exist are created for you. By default this replaces the item's terms in that taxonomy; pass mode: \"add\" to keep the existing ones, or \"remove\" to detach.",
      schema: {
        site_id: siteIdSchema,
        content_id: z.number().int().describe("The content item to modify."),
        type: z.string().optional().default("post").describe("Content type of that ID."),
        taxonomy: z.string().describe("Taxonomy to assign within (category, post_tag, or a custom one)."),
        terms: z.array(z.union([z.number(), z.string()])).describe("Term IDs, or names — unknown names are created."),
        mode: z.enum(["replace", "add", "remove"]).optional().default("replace")
          .describe("replace: these become the only terms. add: keep existing and add these. remove: detach these."),
        create_missing: z.boolean().optional().default(true).describe("Create terms given by name that do not exist yet."),
      },
      handler: async ({ site_id, content_id, type, taxonomy, terms, mode, create_missing }) => {
        const client = site(site_id);
        client.assertWritable("assign_terms_to_content");
        const typeBase = await client.restBaseForType(type);
        const taxBase = await client.restBaseForTaxonomy(taxonomy);

        const resolved: number[] = [];
        const created: any[] = [];
        for (const value of terms) {
          if (typeof value === "number") { resolved.push(value); continue; }
          const search = await client.get<any[]>(`/wp/v2/${taxBase}`, { search: value, per_page: 20 });
          const exact = search.data.find((t: any) => t.name.toLowerCase() === value.toLowerCase() || t.slug === value);
          if (exact) { resolved.push(exact.id); continue; }
          if (!create_missing) throw new Error(`No term named "${value}" in ${taxonomy}, and create_missing is false.`);
          const made = await client.post<any>(`/wp/v2/${taxBase}`, { name: value });
          resolved.push(made.data.id);
          created.push({ id: made.data.id, name: made.data.name });
        }

        const currentRes = await client.get<any>(`/wp/v2/${typeBase}/${content_id}`, client.hasCredentials() ? { context: "edit" } : {});
        const existing: number[] = currentRes.data[taxBase] ?? [];

        let next: number[];
        if (mode === "add") next = [...new Set([...existing, ...resolved])];
        else if (mode === "remove") next = existing.filter((id) => !resolved.includes(id));
        else next = [...new Set(resolved)];

        const res = await client.post<any>(`/wp/v2/${typeBase}/${content_id}`, { [taxBase]: next });
        audit({ site: client.site.id, tool: "assign_terms_to_content", action: `${mode} ${taxonomy}`, target: content_id, outcome: "ok", detail: next.join(",") });

        return ok({
          updated: true, content_id, type, taxonomy, mode,
          before: existing, after: res.data[taxBase] ?? next,
          created_terms: created.length ? created : undefined,
        });
      },
    }),

    defineTool({
      name: "get_content_terms",
      title: "Get terms on content",
      readOnly: true,
      description: "Get every taxonomy term assigned to one content item, grouped by taxonomy and resolved to full term objects rather than bare IDs.",
      schema: {
        site_id: siteIdSchema,
        content_id: z.number().int().describe("The content item to inspect."),
        type: z.string().optional().default("post").describe("Content type of that ID."),
      },
      handler: async ({ site_id, content_id, type }) => {
        const client = site(site_id);
        const typeBase = await client.restBaseForType(type);
        const item = await client.get<any>(`/wp/v2/${typeBase}/${content_id}`, client.hasCredentials() ? { context: "edit" } : {});
        const taxes = await client.taxonomies();

        const grouped: Record<string, any[]> = {};
        for (const [taxName, tax] of Object.entries<any>(taxes)) {
          if (!(tax.types ?? []).includes(type)) continue;
          const ids: number[] = item.data[tax.rest_base] ?? [];
          if (!Array.isArray(ids) || ids.length === 0) { grouped[taxName] = []; continue; }
          const res = await client.get<any[]>(`/wp/v2/${tax.rest_base}`, { include: ids, per_page: 100 });
          grouped[taxName] = res.data.map((t) => shapeTerm(t, taxName));
        }
        return ok({ content_id, type, title: stripHtml(item.data.title?.rendered ?? item.data.title?.raw ?? ""), terms: grouped });
      },
    }),
  ];
}
