import { z } from "zod";
import { defineTool, ok, siteIdSchema, stripHtml, type ToolContext } from "../lib/tooling.js";
import { audit } from "../lib/safety.js";

function shapeUser(u: any) {
  return {
    id: u.id,
    name: u.name,
    username: u.username ?? undefined,
    email: u.email ?? undefined,
    slug: u.slug,
    roles: u.roles ?? undefined,
    url: u.url || undefined,
    description: stripHtml(String(u.description ?? "")).slice(0, 400) || undefined,
    link: u.link,
    registered_date: u.registered_date ?? undefined,
    avatar: u.avatar_urls?.["96"],
    capabilities_summary: u.capabilities
      ? ["manage_options", "edit_posts", "publish_posts", "upload_files", "edit_theme_options", "activate_plugins"].filter((c) => u.capabilities[c])
      : undefined,
  };
}

export function userTools(ctx: ToolContext) {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    defineTool({
      name: "list_users",
      title: "List users",
      readOnly: true,
      description:
        "List users with search, role filtering, ordering and pagination. Email addresses and roles are only returned when the authenticated user has list_users capability (Administrator); otherwise WordPress returns just the public author profile.",
      schema: {
        site_id: siteIdSchema,
        search: z.string().optional().describe("Match against name, username, email and slug."),
        roles: z.array(z.string()).optional().describe("Filter by role slugs, e.g. [\"editor\", \"author\"]. Administrator only."),
        per_page: z.number().int().min(1).max(100).optional().default(20).describe("How many results per page."),
        page: z.number().int().min(1).optional().default(1).describe("Which page of results to return."),
        orderby: z.enum(["id", "include", "name", "registered_date", "slug", "email", "url"]).optional().default("name").describe("Which field to sort by."),
        order: z.enum(["asc", "desc"]).optional().default("asc").describe("Sort direction."),
        has_published_posts: z.boolean().optional().describe("Only users who have published content."),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        const query: Record<string, unknown> = {
          search: args.search, roles: args.roles, per_page: args.per_page, page: args.page,
          orderby: args.orderby, order: args.order,
        };
        if (args.has_published_posts) query.has_published_posts = true;
        if (client.hasCredentials()) query.context = "edit";
        let res;
        try {
          res = await client.get<any[]>("/wp/v2/users", query);
        } catch (e: any) {
          delete query.context; delete query.roles;
          res = await client.get<any[]>("/wp/v2/users", query);
          return ok({
            site: client.site.id, total: res.total, page: args.page,
            users: res.data.map(shapeUser),
          }, `Only public author profiles were returned — the authenticated user cannot list all users (${e.message}). Emails and roles need an Administrator account.`);
        }
        return ok({ site: client.site.id, total: res.total ?? res.data.length, total_pages: res.totalPages ?? 1, page: args.page, users: res.data.map(shapeUser) });
      },
    }),

    defineTool({
      name: "get_user",
      title: "Get a user",
      readOnly: true,
      description: "Fetch one user by ID, or the authenticated user with id: \"me\". Includes roles and a summary of notable capabilities when permitted.",
      schema: {
        site_id: siteIdSchema,
        id: z.union([z.number().int(), z.literal("me")]).describe("The user ID, or \"me\" for the account this server authenticates as."),
      },
      handler: async ({ site_id, id }) => {
        const client = site(site_id);
        const res = await client.get<any>(`/wp/v2/users/${id}`, client.hasCredentials() ? { context: "edit" } : {});
        return ok({ ...shapeUser(res.data), capabilities: res.data.capabilities ?? undefined });
      },
    }),

    defineTool({
      name: "create_user",
      title: "Create a user",
      description:
        "Create a WordPress user. Requires an Administrator account. Choose the role deliberately — \"administrator\" grants full control of the site including plugin and theme installation.",
      schema: {
        site_id: siteIdSchema,
        username: z.string().describe("Login name. Cannot be changed later."),
        email: z.string().describe("Email address. Must be unique on the site."),
        password: z.string().describe("Initial password. Use a long random value and share it out of band."),
        roles: z.array(z.string()).optional().describe("Role slugs, e.g. [\"editor\"]. Defaults to the site's default role (usually subscriber)."),
        name: z.string().optional().describe("Display name."),
        first_name: z.string().optional().describe("Given name."),
        last_name: z.string().optional().describe("Family name."),
        url: z.string().optional().describe("Website URL."),
        description: z.string().optional().describe("Author bio."),
        meta: z.record(z.any()).optional().describe("Custom fields as key/value pairs, for keys registered with show_in_rest."),
      },
      handler: async ({ site_id, ...fields }) => {
        const client = site(site_id);
        client.assertWritable("create_user");
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
        const res = await client.post<any>("/wp/v2/users", body);
        audit({ site: client.site.id, tool: "create_user", action: "create", target: res.data.id, outcome: "ok", detail: `${fields.username} roles=${(fields.roles ?? []).join(",")}` });
        return ok({ created: true, ...shapeUser(res.data) },
          fields.roles?.includes("administrator") ? "This user was created as an administrator and has full control of the site." : undefined);
      },
    }),

    defineTool({
      name: "update_user",
      title: "Update a user",
      description: "Update a user's profile, email, password or roles. Changing roles changes what that person can do — promoting to administrator grants full site control.",
      schema: {
        site_id: siteIdSchema,
        id: z.union([z.number().int(), z.literal("me")]).describe("The user ID, or \"me\"."),
        email: z.string().optional().describe("Email address."),
        password: z.string().optional().describe("New password. This immediately invalidates the user's existing sessions."),
        roles: z.array(z.string()).optional().describe("Replace the user's roles."),
        name: z.string().optional().describe("Display name."),
        first_name: z.string().optional().describe("Given name."),
        last_name: z.string().optional().describe("Family name."),
        nickname: z.string().optional().describe("Nickname, used by some themes."),
        slug: z.string().optional().describe("Author archive slug."),
        url: z.string().optional().describe("Website URL."),
        description: z.string().optional().describe("Longer descriptive text."),
        locale: z.string().optional().describe("User interface locale, e.g. \"en_GB\"."),
        meta: z.record(z.any()).optional().describe("Custom fields as key/value pairs, for keys registered with show_in_rest."),
      },
      handler: async ({ site_id, id, ...fields }) => {
        const client = site(site_id);
        client.assertWritable("update_user");
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
        if (Object.keys(body).length === 0) throw new Error("No fields to update were supplied.");
        const res = await client.post<any>(`/wp/v2/users/${id}`, body);
        audit({ site: client.site.id, tool: "update_user", action: "update", target: id, outcome: "ok", detail: Object.keys(body).join(",") });
        return ok({ updated: true, changed_fields: Object.keys(body), ...shapeUser(res.data) });
      },
    }),

    defineTool({
      name: "delete_user",
      title: "Delete a user",
      destructive: true,
      description:
        "Delete a user. WordPress has no trash for users, so this is permanent and requires confirm: true. You must say what happens to their content: reassign it to another user (strongly preferred) or let it be deleted with them.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("The user ID to delete."),
        reassign_to: z.number().int().optional().describe("User ID to inherit this user's posts. Omit only if you truly want their content deleted too."),
        confirm: z.boolean().optional().default(false).describe("Required — user deletion cannot be undone."),
      },
      handler: async ({ site_id, id, reassign_to, confirm }) => {
        const client = site(site_id);
        client.assertWritable("delete_user");

        if (!confirm) {
          const current = await client.get<any>(`/wp/v2/users/${id}`, { context: "edit" });
          const posts = await client.get<any[]>("/wp/v2/posts", { author: id, per_page: 1, status: "any", context: "edit" }).catch(() => ({ total: undefined } as any));
          audit({ site: client.site.id, tool: "delete_user", action: "delete", target: id, outcome: "refused", detail: "confirm not set" });
          return ok({
            deleted: false, requires_confirmation: true,
            user: shapeUser(current.data),
            authored_posts: posts.total ?? "unknown",
            content_disposition: reassign_to ? `Posts would be reassigned to user ${reassign_to}.` : "No reassign_to was given, so this user's content would be DELETED along with them.",
          }, "User deletion is permanent, so nothing was done. Re-run with confirm: true, ideally alongside reassign_to so the content survives.");
        }

        const res = await client.del<any>(`/wp/v2/users/${id}`, { force: true, reassign: reassign_to ?? "" });
        audit({ site: client.site.id, tool: "delete_user", action: "delete", target: id, outcome: "ok", detail: reassign_to ? `reassigned to ${reassign_to}` : "content deleted" });
        return ok({ deleted: true, id, reassigned_to: reassign_to ?? null, previous: res.data?.previous ? shapeUser(res.data.previous) : undefined });
      },
    }),

    defineTool({
      name: "list_roles",
      title: "List roles",
      readOnly: true,
      description: "List the roles registered on the site with their capabilities, so you can pick the right role before creating or updating a user. Uses the companion plugin when available and falls back to the standard WordPress roles otherwise.",
      schema: { site_id: siteIdSchema },
      handler: async ({ site_id }) => {
        const client = site(site_id);
        const ns = client.site.helperNamespace ?? "wpxmcp/v1";
        if (await client.hasHelperPlugin()) {
          const res = await client.get<any>(`/${ns}/roles`);
          return ok({ site: client.site.id, source: "companion plugin", roles: res.data });
        }
        return ok({
          site: client.site.id,
          source: "built-in defaults (companion plugin not installed, so custom roles are not listed)",
          roles: {
            administrator: "Full control, including plugins, themes, users and settings.",
            editor: "Publish and manage all content, including other people's.",
            author: "Publish and manage only their own content.",
            contributor: "Write content but cannot publish or upload files.",
            subscriber: "Read only; manages their own profile.",
          },
        });
      },
    }),
  ];
}
