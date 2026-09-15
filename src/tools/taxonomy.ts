import { z } from "zod";
import { defineTool, ok, siteIdSchema, stripHtml, type ToolContext } from "../lib/tooling.js";
import { audit } from "../lib/safety.js";
import { decodeEntities, resolveTaxonomy, resolveTermIds, resolveType, routeFor } from "./content.js";

function shapeTerm(term: any, taxonomy?: string) {
  return {
    id: term.id,
    taxonomy: term.taxonomy ?? taxonomy,
    name: decodeEntities(String(term.name ?? "")),
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
        // Accept a REST base ("posts") as well as the type slug ("post").
        const typeName = for_type ? ((await resolveType(client, for_type).catch(() => null))?.name ?? for_type) : undefined;
        const list = Object.entries<any>(taxes)
          .filter(([, t]) => !typeName || (t.types ?? []).includes(typeName))
          .map(([name, t]) => ({
            taxonomy: name,
            rest_base: t.rest_base,
            rest_namespace: t.rest_namespace && t.rest_namespace !== "wp/v2" ? t.rest_namespace : undefined,
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
        const tax = await resolveTaxonomy(client, args.taxonomy);
        const res = await client.get<any[]>(tax.route, {
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
          taxonomy: tax.name,
          rest_base: tax.restBase,
          total: res.total ?? res.data.length,
          total_pages: res.totalPages ?? 1,
          page: args.page,
          terms: res.data.map((t) => shapeTerm(t, tax.name)),
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
        const tax = await resolveTaxonomy(client, taxonomy);
        const res = await client.get<any>(`${tax.route}/${id}`, client.hasCredentials() ? { context: "edit" } : {});
        return ok(shapeTerm(res.data, tax.name));
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
        meta: z.record(z.string(), z.any()).optional().describe("Term meta, for keys registered with show_in_rest."),
      },
      handler: async ({ site_id, taxonomy, ...rest }) => {
        const client = site(site_id);
        client.assertWritable("create_term");
        const tax = await resolveTaxonomy(client, taxonomy);
        if (rest.parent && tax.info && !tax.info.hierarchical) {
          throw new Error(`"${tax.name}" is not hierarchical, so terms in it cannot have a parent. Drop \`parent\`.`);
        }
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
        let res;
        try {
          res = await client.post<any>(tax.route, body);
        } catch (e: any) {
          const existing = e?.code === "term_exists" ? e?.body?.data?.term_id : undefined;
          if (existing) {
            throw new Error(`A ${tax.name} term with that name already exists (id ${existing}${rest.parent ? " under the same parent" : ""}). Use it via get_term / assign_terms_to_content, or pick a different name or slug.`);
          }
          throw e;
        }
        audit({ site: client.site.id, tool: "create_term", action: `create ${tax.name}`, target: res.data.id, outcome: "ok", detail: String(rest.name) });
        return ok({ created: true, ...shapeTerm(res.data, tax.name) });
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
        parent: z.number().int().min(0).optional().describe("Parent term ID, or 0 for none. Hierarchical taxonomies only."),
        meta: z.record(z.string(), z.any()).optional().describe("Custom fields as key/value pairs, for keys registered with show_in_rest."),
      },
      handler: async ({ site_id, taxonomy, id, ...rest }) => {
        const client = site(site_id);
        client.assertWritable("update_term");
        const tax = await resolveTaxonomy(client, taxonomy);
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
        if (Object.keys(body).length === 0) throw new Error("No fields to update were supplied.");
        if (body.parent === id) throw new Error("A term cannot be its own parent.");
        const res = await client.post<any>(`${tax.route}/${id}`, body);
        audit({ site: client.site.id, tool: "update_term", action: `update ${tax.name}`, target: id, outcome: "ok", detail: Object.keys(body).join(",") });
        return ok({ updated: true, changed_fields: Object.keys(body), ...shapeTerm(res.data, tax.name) });
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
        const tax = await resolveTaxonomy(client, taxonomy);

        if (!confirm) {
          const current = await client.get<any>(`${tax.route}/${id}`);
          // `parent` is only a valid filter on hierarchical taxonomies; flat ones have no children.
          const children = tax.info?.hierarchical === false
            ? { data: [] as any[] }
            : await client.get<any[]>(tax.route, { parent: id, per_page: 100 }).catch(() => ({ data: [] as any[] }));
          audit({ site: client.site.id, tool: "delete_term", action: "delete", target: id, outcome: "refused", detail: "confirm not set" });
          return ok({
            deleted: false,
            requires_confirmation: true,
            term: shapeTerm(current.data, tax.name),
            assigned_items: current.data.count,
            child_terms: children.data.map((c: any) => ({ id: c.id, name: decodeEntities(String(c.name ?? "")) })),
          }, `Terms cannot be recovered once deleted, so nothing was removed. This term is on ${current.data.count} item(s)${children.data.length ? ` and has ${children.data.length} child term(s), which will move up to this term's parent` : ""}. Re-run with confirm: true to delete it.`);
        }

        const res = await client.del<any>(`${tax.route}/${id}`, { force: true });
        audit({ site: client.site.id, tool: "delete_term", action: "delete", target: id, outcome: "ok" });
        return ok({ deleted: true, term: shapeTerm(res.data?.previous ?? { id }, tax.name) });
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
        const typeInfo = await resolveType(client, type);
        const tax = await resolveTaxonomy(client, taxonomy);
        const taxBase = tax.restBase;

        // Read the item first: a taxonomy not attached to the type is silently
        // ignored by WordPress, so catch it before creating any terms.
        const currentRes = await client.get<any>(`${typeInfo.route}/${content_id}`, { context: "edit" });
        if (!Array.isArray(currentRes.data?.[taxBase])) {
          throw new Error(`${typeInfo.name} ${content_id} has no "${taxBase}" field — the ${tax.name} taxonomy is not attached to the "${typeInfo.name}" type (or is not exposed over REST), so nothing was changed. Run discover_taxonomies with for_type: "${typeInfo.name}".`);
        }
        const existing: number[] = currentRes.data[taxBase];

        // Removing never creates: a name that does not exist is simply not attached.
        const { ids: resolved, created, missing } = await resolveTermIds(client, tax, terms, mode !== "remove" && create_missing);
        if (missing.length && mode !== "remove") {
          throw new Error(`No ${tax.name} term named ${missing.map((m) => `"${m}"`).join(", ")}, and create_missing is false. Nothing was changed.`);
        }

        let next: number[];
        if (mode === "add") next = [...new Set([...existing, ...resolved])];
        else if (mode === "remove") next = existing.filter((id) => !resolved.includes(id));
        else next = [...new Set(resolved)];

        const res = await client.post<any>(`${typeInfo.route}/${content_id}`, { [taxBase]: next });
        audit({ site: client.site.id, tool: "assign_terms_to_content", action: `${mode} ${tax.name}`, target: content_id, outcome: "ok", detail: next.join(",") });

        return ok({
          updated: true, content_id, type: typeInfo.name, taxonomy: tax.name, mode,
          before: existing, after: res.data[taxBase] ?? next,
          created_terms: created.length ? created : undefined,
          not_found: missing.length ? missing : undefined,
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
        const typeInfo = await resolveType(client, type);
        const item = await client.get<any>(`${typeInfo.route}/${content_id}`, client.hasCredentials() ? { context: "edit" } : {});
        const taxes = await client.taxonomies();

        const grouped: Record<string, any[]> = {};
        for (const [taxName, tax] of Object.entries<any>(taxes)) {
          if (!(tax.types ?? []).includes(typeInfo.name)) continue;
          const ids: number[] = item.data[tax.rest_base] ?? [];
          if (!Array.isArray(ids) || ids.length === 0) { grouped[taxName] = []; continue; }
          const route = routeFor(tax.rest_namespace, tax.rest_base);
          const found: any[] = [];
          // `include` is capped by per_page, so page through large assignments.
          for (let i = 0; i < ids.length; i += 100) {
            const res = await client.get<any[]>(route, { include: ids.slice(i, i + 100), per_page: 100 });
            found.push(...(res.data ?? []));
          }
          grouped[taxName] = found.map((t) => shapeTerm(t, taxName));
        }
        return ok({ content_id, type: typeInfo.name, title: stripHtml(item.data.title?.rendered ?? item.data.title?.raw ?? ""), terms: grouped });
      },
    }),
  ];
}
