import { z } from "zod";
import { defineTool, ok, siteIdSchema, stripHtml, unwrap, trimText, type ToolContext } from "../lib/tooling.js";
import { audit } from "../lib/safety.js";

function shapeMenu(m: any) {
  return {
    id: m.id,
    name: stripHtml(String(m.name ?? "")),
    slug: m.slug,
    description: m.description || undefined,
    locations: m.locations ?? [],
    auto_add: m.auto_add,
    count: m.count,
  };
}

function shapeMenuItem(i: any) {
  return {
    id: i.id,
    title: stripHtml(unwrap(i.title)),
    url: i.url,
    parent: i.parent ?? 0,
    menu_order: i.menu_order,
    type: i.type,
    object: i.object,
    object_id: i.object_id,
    target: i.target || undefined,
    description: i.description || undefined,
    classes: (i.classes ?? []).filter(Boolean),
    menus: i.menus,
    status: i.status,
  };
}

/** Renders a flat menu-item list as an indented tree, which is how humans think about menus. */
function menuTree(items: any[]): string {
  const byParent = new Map<number, any[]>();
  for (const item of items) {
    const parent = item.parent ?? 0;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push(item);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.menu_order ?? 0) - (b.menu_order ?? 0));

  const lines: string[] = [];
  const walk = (parent: number, depth: number) => {
    for (const item of byParent.get(parent) ?? []) {
      lines.push(`${"  ".repeat(depth)}- ${item.title} [id ${item.id}] → ${item.url}`);
      walk(item.id, depth + 1);
    }
  };
  walk(0, 0);
  return lines.join("\n") || "(empty)";
}

export function appearanceTools(ctx: ToolContext) {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    /* ---------------------------- Menus ---------------------------- */
    defineTool({
      name: "list_menus",
      title: "List navigation menus",
      readOnly: true,
      description:
        "List the site's navigation menus and which theme locations they are assigned to. Note that block (full-site-editing) themes may instead use navigation blocks — list_content with type \"wp_navigation\" covers those.",
      schema: { site_id: siteIdSchema },
      handler: async ({ site_id }) => {
        const client = site(site_id);
        const res = await client.get<any[]>("/wp/v2/menus", { per_page: 100, context: "edit" });
        const locations = await client.get<any>("/wp/v2/menu-locations").catch(() => ({ data: {} } as any));
        return ok({
          site: client.site.id,
          menus: res.data.map(shapeMenu),
          theme_locations: Object.entries<any>(locations.data ?? {}).map(([slug, loc]) => ({
            location: slug, description: loc.description, assigned_menu_id: loc.menu ?? null,
          })),
        });
      },
    }),

    defineTool({
      name: "get_menu",
      title: "Get a menu with its items",
      readOnly: true,
      description: "Get one navigation menu together with all of its items, rendered as an indented tree so the hierarchy is obvious.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("The menu ID from list_menus."),
      },
      handler: async ({ site_id, id }) => {
        const client = site(site_id);
        const menu = await client.get<any>(`/wp/v2/menus/${id}`, { context: "edit" });
        const items = await client.getAll<any>("/wp/v2/menu-items", { menus: id, context: "edit", orderby: "menu_order", order: "asc", status: "any" }, 300);
        return ok({
          menu: shapeMenu(menu.data),
          item_count: items.length,
          tree: menuTree(items.map(shapeMenuItem)),
          items: items.map(shapeMenuItem),
        });
      },
    }),

    defineTool({
      name: "create_menu",
      title: "Create a navigation menu",
      description: "Create an empty navigation menu, optionally assigning it to one or more theme locations. Add entries afterwards with add_menu_item.",
      schema: {
        site_id: siteIdSchema,
        name: z.string().describe("Menu name shown in wp-admin."),
        locations: z.array(z.string()).optional().describe("Theme location slugs to assign it to, e.g. [\"primary\"]. See list_menus for what the theme registers."),
        description: z.string().optional().describe("Longer descriptive text."),
        auto_add: z.boolean().optional().describe("Automatically add new top-level pages to this menu."),
      },
      handler: async ({ site_id, ...fields }) => {
        const client = site(site_id);
        client.assertWritable("create_menu");
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
        const res = await client.post<any>("/wp/v2/menus", body);
        audit({ site: client.site.id, tool: "create_menu", action: "create", target: res.data.id, outcome: "ok", detail: String(fields.name) });
        return ok({ created: true, ...shapeMenu(res.data) });
      },
    }),

    defineTool({
      name: "update_menu",
      title: "Update a navigation menu",
      description: "Rename a menu or change which theme locations it fills.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("The item ID."),
        name: z.string().optional().describe("Display name."),
        locations: z.array(z.string()).optional().describe("Replaces the current location assignments."),
        description: z.string().optional().describe("Longer descriptive text."),
        auto_add: z.boolean().optional().describe("Automatically add new top-level pages to this menu."),
      },
      handler: async ({ site_id, id, ...fields }) => {
        const client = site(site_id);
        client.assertWritable("update_menu");
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
        if (Object.keys(body).length === 0) throw new Error("No fields to update were supplied.");
        const res = await client.post<any>(`/wp/v2/menus/${id}`, body);
        audit({ site: client.site.id, tool: "update_menu", action: "update", target: id, outcome: "ok" });
        return ok({ updated: true, ...shapeMenu(res.data) });
      },
    }),

    defineTool({
      name: "delete_menu",
      title: "Delete a navigation menu",
      destructive: true,
      description: "Delete a navigation menu and all of its items. Any theme location it filled falls back to the theme's default output. Requires confirm: true.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("The menu ID to delete."),
        confirm: z.boolean().optional().default(false).describe("Required — menus and their items cannot be recovered."),
      },
      handler: async ({ site_id, id, confirm }) => {
        const client = site(site_id);
        client.assertWritable("delete_menu");
        if (!confirm) {
          const menu = await client.get<any>(`/wp/v2/menus/${id}`, { context: "edit" });
          const items = await client.getAll<any>("/wp/v2/menu-items", { menus: id, status: "any" }, 200);
          return ok({ deleted: false, requires_confirmation: true, menu: shapeMenu(menu.data), items_that_would_go: items.length },
            "Nothing was deleted. Re-run with confirm: true to remove this menu and its items.");
        }
        await client.del(`/wp/v2/menus/${id}`, { force: true });
        audit({ site: client.site.id, tool: "delete_menu", action: "delete", target: id, outcome: "ok" });
        return ok({ deleted: true, id });
      },
    }),

    defineTool({
      name: "add_menu_item",
      title: "Add a menu item",
      description:
        "Add an entry to a navigation menu. It can point at a post, page or custom post type (object_id + object), a taxonomy term, or an arbitrary URL. Use `parent` to nest it under another item and `menu_order` to position it.",
      schema: {
        site_id: siteIdSchema,
        menu_id: z.number().int().describe("Menu to add to."),
        title: z.string().describe("Link label."),
        type: z.enum(["custom", "post_type", "taxonomy", "post_type_archive"]).optional().default("custom")
          .describe("custom: an arbitrary URL. post_type: link to a post/page/CPT (set object + object_id). taxonomy: link to a term. post_type_archive: link to a CPT archive."),
        url: z.string().optional().describe("Target URL. Required for type \"custom\"."),
        object: z.string().optional().describe("For post_type: the post type slug (\"page\"). For taxonomy: the taxonomy slug (\"category\")."),
        object_id: z.number().int().optional().describe("ID of the post or term being linked to."),
        parent: z.number().int().optional().describe("Menu item ID to nest under, creating a submenu."),
        menu_order: z.number().int().optional().describe("Position within the menu. Lower numbers come first."),
        target: z.enum(["", "_blank"]).optional().describe("_blank opens in a new tab."),
        classes: z.array(z.string()).optional().describe("Extra CSS classes on the link."),
        description: z.string().optional().describe("Item description, shown by themes that support it."),
        attr_title: z.string().optional().describe("The link's title attribute."),
        xfn: z.string().optional().describe("XFN relationship value for the link."),
      },
      handler: async ({ site_id, menu_id, ...fields }) => {
        const client = site(site_id);
        client.assertWritable("add_menu_item");
        if (fields.type === "custom" && !fields.url) throw new Error("A custom menu item needs a `url`.");
        if ((fields.type === "post_type" || fields.type === "taxonomy") && !fields.object_id) {
          throw new Error(`A "${fields.type}" menu item needs both \`object\` (the post type or taxonomy slug) and \`object_id\`.`);
        }
        const body: Record<string, unknown> = { menus: menu_id, status: "publish" };
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
        const res = await client.post<any>("/wp/v2/menu-items", body);
        audit({ site: client.site.id, tool: "add_menu_item", action: "create", target: res.data.id, outcome: "ok", detail: `menu=${menu_id}` });
        return ok({ created: true, ...shapeMenuItem(res.data) });
      },
    }),

    defineTool({
      name: "update_menu_item",
      title: "Update a menu item",
      description: "Change a menu item's label, target, nesting or position.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("The menu item ID."),
        title: z.string().optional().describe("New link label."),
        url: z.string().optional().describe("New target URL."),
        parent: z.number().int().optional().describe("Set to 0 to move it back to the top level."),
        menu_order: z.number().int().optional().describe("New position; lower numbers come first."),
        target: z.enum(["", "_blank"]).optional().describe("_blank opens in a new tab."),
        classes: z.array(z.string()).optional().describe("Replaces the item's CSS classes."),
        description: z.string().optional().describe("Item description, shown by themes that support it."),
        menus: z.number().int().optional().describe("Move the item to a different menu."),
      },
      handler: async ({ site_id, id, ...fields }) => {
        const client = site(site_id);
        client.assertWritable("update_menu_item");
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
        if (Object.keys(body).length === 0) throw new Error("No fields to update were supplied.");
        const res = await client.post<any>(`/wp/v2/menu-items/${id}`, body);
        audit({ site: client.site.id, tool: "update_menu_item", action: "update", target: id, outcome: "ok" });
        return ok({ updated: true, ...shapeMenuItem(res.data) });
      },
    }),

    defineTool({
      name: "delete_menu_item",
      title: "Delete a menu item",
      destructive: true,
      description: "Remove one item from a navigation menu. Its children are re-parented to the top level rather than deleted.",
      schema: { site_id: siteIdSchema, id: z.number().int().describe("The menu item ID.") },
      handler: async ({ site_id, id }) => {
        const client = site(site_id);
        client.assertWritable("delete_menu_item");
        const res = await client.del<any>(`/wp/v2/menu-items/${id}`, { force: true });
        audit({ site: client.site.id, tool: "delete_menu_item", action: "delete", target: id, outcome: "ok" });
        return ok({ deleted: true, id, previous: res.data?.previous ? shapeMenuItem(res.data.previous) : undefined });
      },
    }),

    defineTool({
      name: "reorder_menu_items",
      title: "Reorder menu items",
      description: "Set the order and nesting of several menu items at once, which is far less error-prone than updating them one by one.",
      schema: {
        site_id: siteIdSchema,
        items: z.array(z.object({
          id: z.number().int().describe("Menu item ID."),
          menu_order: z.number().int().describe("Position; lower comes first."),
          parent: z.number().int().optional().describe("Parent item ID, or 0 for top level."),
        })).min(1).describe("The desired arrangement."),
      },
      handler: async ({ site_id, items }) => {
        const client = site(site_id);
        client.assertWritable("reorder_menu_items");
        const results: any[] = [];
        for (const item of items) {
          try {
            const body: Record<string, unknown> = { menu_order: item.menu_order };
            if (item.parent !== undefined) body.parent = item.parent;
            await client.post(`/wp/v2/menu-items/${item.id}`, body);
            results.push({ id: item.id, ok: true });
          } catch (e: any) {
            results.push({ id: item.id, ok: false, error: e.message });
          }
        }
        audit({ site: client.site.id, tool: "reorder_menu_items", action: "reorder", target: items.map((i) => i.id).join(","), outcome: "ok" });
        return ok({ reordered: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
      },
    }),

    /* --------------------------- Widgets --------------------------- */
    defineTool({
      name: "list_sidebars",
      title: "List widget areas",
      readOnly: true,
      description: "List the theme's widget areas (sidebars) and the widgets currently placed in each. Block themes typically have no classic sidebars — that is expected, not an error.",
      schema: { site_id: siteIdSchema },
      handler: async ({ site_id }) => {
        const client = site(site_id);
        const res = await client.get<any[]>("/wp/v2/sidebars", { context: "edit" });
        return ok({
          site: client.site.id,
          count: res.data.length,
          sidebars: res.data.map((s: any) => ({
            id: s.id, name: s.name, description: stripHtml(String(s.description ?? "")),
            status: s.status, widget_count: (s.widgets ?? []).length, widgets: s.widgets ?? [],
          })),
        }, res.data.length === 0 ? "This theme registers no classic widget areas — it is probably a block theme, where the equivalent lives in template parts." : undefined);
      },
    }),

    defineTool({
      name: "list_widgets",
      title: "List widgets",
      readOnly: true,
      description: "List widgets, optionally within one sidebar, including their settings and rendered output.",
      schema: {
        site_id: siteIdSchema,
        sidebar: z.string().optional().describe("Sidebar id to restrict to, e.g. \"sidebar-1\"."),
      },
      handler: async ({ site_id, sidebar }) => {
        const client = site(site_id);
        const res = await client.get<any[]>("/wp/v2/widgets", { sidebar, context: "edit" });
        return ok({
          site: client.site.id,
          count: res.data.length,
          widgets: res.data.map((w: any) => ({
            id: w.id, id_base: w.id_base, sidebar: w.sidebar,
            instance_settings: w.instance?.raw ?? undefined,
            rendered: trimText(stripHtml(String(w.rendered ?? "")), 300),
          })),
        });
      },
    }),

    defineTool({
      name: "create_widget",
      title: "Add a widget",
      description:
        "Add a widget to a sidebar. `id_base` names the widget type (block, text, nav_menu, search, categories, recent-posts…). For the modern \"block\" widget, put block markup in instance.content — that is how the block-based widget editor stores everything.",
      schema: {
        site_id: siteIdSchema,
        sidebar: z.string().describe("Target sidebar id, e.g. \"sidebar-1\". See list_sidebars."),
        id_base: z.string().describe("Widget type: \"block\" for a block widget, or a classic type such as \"text\", \"nav_menu\", \"search\", \"categories\", \"recent-posts\"."),
        instance: z.record(z.any()).optional().describe("Widget settings. For id_base \"block\", use {\"content\": \"<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->\"}. For \"nav_menu\", {\"title\": \"Menu\", \"nav_menu\": 12}."),
        position: z.number().int().optional().describe("Index within the sidebar. Appended if omitted."),
      },
      handler: async ({ site_id, sidebar, id_base, instance, position }) => {
        const client = site(site_id);
        client.assertWritable("create_widget");
        const body: Record<string, unknown> = { sidebar, id_base };
        if (instance) body.instance = { raw: instance };
        if (position !== undefined) body.position = position;
        const res = await client.post<any>("/wp/v2/widgets", body);
        audit({ site: client.site.id, tool: "create_widget", action: "create", target: res.data.id, outcome: "ok", detail: `${id_base} → ${sidebar}` });
        return ok({ created: true, id: res.data.id, id_base: res.data.id_base, sidebar: res.data.sidebar, instance_settings: res.data.instance?.raw });
      },
    }),

    defineTool({
      name: "update_widget",
      title: "Update a widget",
      description: "Change a widget's settings or move it to a different sidebar or position.",
      schema: {
        site_id: siteIdSchema,
        id: z.string().describe("Widget id, e.g. \"block-3\"."),
        instance: z.record(z.any()).optional().describe("Replacement settings. Read the widget first — this replaces the instance wholesale."),
        sidebar: z.string().optional().describe("Move it to this sidebar."),
        position: z.number().int().optional().describe("New index within the sidebar."),
      },
      handler: async ({ site_id, id, instance, sidebar, position }) => {
        const client = site(site_id);
        client.assertWritable("update_widget");
        const body: Record<string, unknown> = {};
        if (instance) body.instance = { raw: instance };
        if (sidebar !== undefined) body.sidebar = sidebar;
        if (position !== undefined) body.position = position;
        if (Object.keys(body).length === 0) throw new Error("No changes were supplied.");
        const res = await client.post<any>(`/wp/v2/widgets/${id}`, body);
        audit({ site: client.site.id, tool: "update_widget", action: "update", target: id, outcome: "ok" });
        return ok({ updated: true, id: res.data.id, sidebar: res.data.sidebar, instance_settings: res.data.instance?.raw });
      },
    }),

    defineTool({
      name: "delete_widget",
      title: "Delete a widget",
      destructive: true,
      description: "Remove a widget. By default it is moved to the inactive widgets area so its settings survive; force: true deletes it outright.",
      schema: {
        site_id: siteIdSchema,
        id: z.string().describe("Widget id."),
        force: z.boolean().optional().default(false).describe("Delete permanently instead of moving to inactive widgets."),
      },
      handler: async ({ site_id, id, force }) => {
        const client = site(site_id);
        client.assertWritable("delete_widget");
        await client.del(`/wp/v2/widgets/${id}`, force ? { force: true } : undefined);
        audit({ site: client.site.id, tool: "delete_widget", action: force ? "delete" : "deactivate", target: id, outcome: "ok" });
        return ok({ deleted: true, permanent: Boolean(force), id },
          force ? undefined : "Moved to the inactive widgets area, so its settings are preserved and it can be dragged back in wp-admin.");
      },
    }),

    /* --------------------- Block theme / FSE ----------------------- */
    defineTool({
      name: "list_templates",
      title: "List block templates",
      readOnly: true,
      description:
        "List the block theme's templates (front-page, single, archive…) or template parts (header, footer). Block themes only — a classic theme returns nothing here, and you should use the theme file tools instead.",
      schema: {
        site_id: siteIdSchema,
        kind: z.enum(["template", "template_part"]).optional().default("template").describe("Which to list."),
      },
      handler: async ({ site_id, kind }) => {
        const client = site(site_id);
        const route = kind === "template" ? "/wp/v2/templates" : "/wp/v2/template-parts";
        const res = await client.get<any[]>(route, { context: "edit", per_page: 100 });
        return ok({
          site: client.site.id, kind, count: res.data.length,
          items: res.data.map((t: any) => ({
            id: t.id, slug: t.slug, title: stripHtml(unwrap(t.title)), theme: t.theme,
            source: t.source, type: t.type, area: t.area,
            description: stripHtml(String(t.description ?? "")).slice(0, 300),
            has_customizations: t.source === "custom",
          })),
        }, res.data.length === 0 ? "No block templates were returned — the active theme is probably a classic theme. Use list_theme_files and read_theme_file instead." : undefined);
      },
    }),

    defineTool({
      name: "get_template",
      title: "Get a block template",
      readOnly: true,
      description: "Get one block template or template part, including its block markup, so you can inspect or edit the layout of an entire page type.",
      schema: {
        site_id: siteIdSchema,
        id: z.string().describe("Template id, usually \"theme//slug\", e.g. \"twentytwentyfour//single\"."),
        kind: z.enum(["template", "template_part"]).optional().default("template").describe("Whether the id names a template or a template part."),
      },
      handler: async ({ site_id, id, kind }) => {
        const client = site(site_id);
        const route = kind === "template" ? "/wp/v2/templates" : "/wp/v2/template-parts";
        const res = await client.get<any>(`${route}/${id}`, { context: "edit" });
        return ok({
          id: res.data.id, slug: res.data.slug, title: stripHtml(unwrap(res.data.title)),
          theme: res.data.theme, source: res.data.source, area: res.data.area,
          content: trimText(unwrap(res.data.content), 60000),
        });
      },
    }),

    defineTool({
      name: "update_template",
      title: "Update a block template",
      description:
        "Update a block template or template part's markup. This changes the layout of every page that uses it, so it takes effect site-wide immediately. WordPress stores the customisation in the database, leaving the theme's own file untouched — you can always revert in the Site Editor.",
      schema: {
        site_id: siteIdSchema,
        id: z.string().describe("Template id, e.g. \"twentytwentyfour//single\"."),
        kind: z.enum(["template", "template_part"]).optional().default("template").describe("Whether the id names a template or a template part."),
        content: z.string().describe("Full block markup for the template."),
        title: z.string().optional().describe("New template title."),
        description: z.string().optional().describe("New template description."),
      },
      handler: async ({ site_id, id, kind, ...fields }) => {
        const client = site(site_id);
        client.assertWritable("update_template");
        const route = kind === "template" ? "/wp/v2/templates" : "/wp/v2/template-parts";
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
        const res = await client.post<any>(`${route}/${id}`, body);
        audit({ site: client.site.id, tool: "update_template", action: "update", target: id, outcome: "ok" });
        return ok({ updated: true, id: res.data.id, source: res.data.source },
          "The customisation is stored in the database, so the theme's original file is untouched and the change can be reverted from the Site Editor.");
      },
    }),

    defineTool({
      name: "get_global_styles",
      title: "Get global styles",
      readOnly: true,
      description:
        "Read a block theme's global styles — the palette, typography, spacing and per-block styling that theme.json defines and the Site Editor overrides. This is where a block theme's design tokens live.",
      schema: { site_id: siteIdSchema },
      handler: async ({ site_id }) => {
        const client = site(site_id);
        const themes = await client.get<any[]>("/wp/v2/themes", { status: "active", context: "edit" });
        const active = themes.data[0];
        if (!active) throw new Error("Could not determine the active theme.");
        if (!active.is_block_theme) {
          return ok({ is_block_theme: false, active_theme: active.stylesheet },
            "The active theme is a classic theme, which has no global styles. Its design tokens live in its stylesheet — read theme.css or style.css with read_theme_file.");
        }
        const id = active._links?.["wp:user-global-styles"]?.[0]?.href?.split("/").pop();
        if (!id) throw new Error("The active block theme did not expose a global styles id.");
        const res = await client.get<any>(`/wp/v2/global-styles/${id}`, { context: "edit" });
        return ok({
          is_block_theme: true, active_theme: active.stylesheet, global_styles_id: id,
          settings: res.data.settings, styles: res.data.styles,
        });
      },
    }),

    defineTool({
      name: "update_global_styles",
      title: "Update global styles",
      description:
        "Update a block theme's global styles — palette, typography, spacing, per-block styling. Changes apply site-wide immediately. Read them first: this merges at the top level, so a partial `settings` object replaces that whole branch.",
      schema: {
        site_id: siteIdSchema,
        settings: z.record(z.any()).optional().describe("theme.json-shaped settings, e.g. {\"color\": {\"palette\": [...]}}."),
        styles: z.record(z.any()).optional().describe("theme.json-shaped styles, e.g. {\"color\": {\"background\": \"#fff\"}, \"typography\": {...}}."),
      },
      handler: async ({ site_id, settings, styles }) => {
        const client = site(site_id);
        client.assertWritable("update_global_styles");
        if (!settings && !styles) throw new Error("Provide `settings`, `styles`, or both.");
        const themes = await client.get<any[]>("/wp/v2/themes", { status: "active", context: "edit" });
        const active = themes.data[0];
        const id = active?._links?.["wp:user-global-styles"]?.[0]?.href?.split("/").pop();
        if (!id) throw new Error("The active theme is not a block theme, so it has no global styles to update.");
        const body: Record<string, unknown> = {};
        if (settings) body.settings = settings;
        if (styles) body.styles = styles;
        const res = await client.post<any>(`/wp/v2/global-styles/${id}`, body);
        audit({ site: client.site.id, tool: "update_global_styles", action: "update", target: id, outcome: "ok" });
        return ok({ updated: true, global_styles_id: id, settings: res.data.settings, styles: res.data.styles });
      },
    }),

    defineTool({
      name: "list_block_types",
      title: "List block types",
      readOnly: true,
      description:
        "List the block types registered on the site, with their attributes. Check here before generating block markup for an unfamiliar plugin's blocks — it tells you the exact block name and which attributes are valid.",
      schema: {
        site_id: siteIdSchema,
        namespace: z.string().optional().describe("Filter to one namespace, e.g. \"core\" or \"woocommerce\"."),
        search: z.string().optional().describe("Match against block titles and names."),
      },
      handler: async ({ site_id, namespace, search }) => {
        const client = site(site_id);
        const res = await client.get<any[]>("/wp/v2/block-types", { namespace, context: "edit" });
        let blocks = res.data;
        if (search) {
          const q = search.toLowerCase();
          blocks = blocks.filter((b: any) => String(b.name).includes(q) || String(b.title).toLowerCase().includes(q));
        }
        return ok({
          site: client.site.id, count: blocks.length,
          namespaces: [...new Set(res.data.map((b: any) => String(b.name).split("/")[0]))],
          blocks: blocks.map((b: any) => ({
            name: b.name, title: b.title, category: b.category,
            description: String(b.description ?? "").slice(0, 200),
            attributes: b.attributes ? Object.keys(b.attributes) : [],
            supports: b.supports ? Object.keys(b.supports) : undefined,
            parent: b.parent ?? undefined,
          })),
        });
      },
    }),

    defineTool({
      name: "list_reusable_blocks",
      title: "List reusable blocks (patterns)",
      readOnly: true,
      description: "List the site's reusable blocks / synced patterns — the fragments editors reuse across pages. Editing one changes every place it appears.",
      schema: { site_id: siteIdSchema },
      handler: async ({ site_id }) => {
        const client = site(site_id);
        const res = await client.get<any[]>("/wp/v2/blocks", { per_page: 100, context: "edit", status: "any" });
        return ok({
          site: client.site.id, count: res.data.length,
          blocks: res.data.map((b: any) => ({
            id: b.id, title: stripHtml(unwrap(b.title)), slug: b.slug, status: b.status,
            modified: b.modified, content_preview: trimText(unwrap(b.content), 300),
          })),
        });
      },
    }),

    defineTool({
      name: "get_theme_mods",
      title: "Get Customizer settings",
      readOnly: true,
      description:
        "Read the active theme's Customizer settings (theme mods) — logo, colors, layout options and anything else the theme registers there. Classic themes keep much of their configuration here rather than in options.",
      schema: { site_id: siteIdSchema },
      handler: async ({ site_id }) => {
        const client = site(site_id);
        const ns = client.site.helperNamespace ?? "wpxmcp/v1";
        if (!(await client.hasHelperPlugin())) {
          throw new Error(`Reading theme mods needs the wpxmcp companion plugin (core REST does not expose them). Install wp-plugin/wpxmcp-helper, or read individual values with run_wp_cli "theme mod list".`);
        }
        const res = await client.get<any>(`/${ns}/theme-mods`);
        return ok(res.data);
      },
    }),

    defineTool({
      name: "set_theme_mod",
      title: "Set a Customizer setting",
      description: "Write one Customizer setting (theme mod) for the active theme. What is valid depends entirely on the theme — read get_theme_mods first to see the keys it uses.",
      schema: {
        site_id: siteIdSchema,
        key: z.string().describe("Theme mod name, e.g. \"custom_logo\" or a theme-specific key."),
        value: z.any().describe("New value. Types matter: a logo expects an attachment ID, a color expects a hex string."),
      },
      handler: async ({ site_id, key, value }) => {
        const client = site(site_id);
        client.assertWritable("set_theme_mod");
        const ns = client.site.helperNamespace ?? "wpxmcp/v1";
        if (!(await client.hasHelperPlugin())) throw new Error("Writing theme mods needs the wpxmcp companion plugin.");
        const res = await client.post<any>(`/${ns}/theme-mods`, { key, value });
        audit({ site: client.site.id, tool: "set_theme_mod", action: "set", target: key, outcome: "ok" });
        return ok({ updated: true, ...res.data });
      },
    }),
  ];
}
