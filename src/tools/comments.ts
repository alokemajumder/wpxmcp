import { z } from "zod";
import { defineTool, ok, siteIdSchema, stripHtml, unwrap, type ToolContext } from "../lib/tooling.js";
import { audit } from "../lib/safety.js";
import type { WordPressClient } from "../lib/client.js";

/**
 * Trashing goes through DELETE rather than status: "trash". With the trash
 * disabled (EMPTY_TRASH_DAYS = 0) wp_trash_comment() deletes permanently,
 * whereas DELETE without force refuses — the recoverable behaviour we promise.
 */
async function trashComment(client: WordPressClient, id: number) {
  try {
    return (await client.del<any>(`/wp/v2/comments/${id}`)).data;
  } catch (e: any) {
    if (e?.code === "rest_trash_not_supported") {
      throw new Error(`The trash is disabled on this site, so comment ${id} was not removed. Deleting it would be permanent — use delete_comment with force: true and confirm: true if that is intended.`);
    }
    if (e?.code === "rest_already_trashed") {
      throw new Error(`Comment ${id} is already in the trash. Use status "untrash" to restore it, or delete_comment with force: true and confirm: true to remove it for good.`);
    }
    throw e;
  }
}

function shapeComment(c: any) {
  return {
    id: c.id,
    post: c.post,
    parent: c.parent,
    author_name: c.author_name,
    author_email: c.author_email || undefined,
    author_url: c.author_url || undefined,
    author_id: c.author || undefined,
    date: c.date,
    status: c.status,
    link: c.link,
    content: stripHtml(unwrap(c.content)).slice(0, 2000),
  };
}

export function commentTools(ctx: ToolContext) {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    defineTool({
      name: "list_comments",
      title: "List comments",
      readOnly: true,
      description:
        "List comments with filtering by post, status, author and date. Moderating? Filter status: \"hold\" for the pending queue or \"spam\" for what the spam filter caught — both require authentication.",
      schema: {
        site_id: siteIdSchema,
        post: z.number().int().optional().describe("Only comments on this content ID."),
        status: z.enum(["approve", "hold", "spam", "trash", "all"]).optional().describe("Moderation status. Anything other than \"approve\" requires authentication."),
        search: z.string().optional().describe("Free-text search term."),
        author_email: z.string().optional().describe("Filter by commenter email. Administrator only."),
        parent: z.number().int().optional().describe("Only replies to this comment ID (0 for top-level comments)."),
        type: z.string().optional().describe("Comment type: \"comment\" (the default WordPress applies), \"pingback\", \"trackback\", or a custom type such as \"review\"."),
        after: z.string().optional().describe("ISO 8601 date."),
        before: z.string().optional().describe("ISO 8601 date."),
        per_page: z.number().int().min(1).max(100).optional().default(25).describe("How many results per page."),
        page: z.number().int().min(1).optional().default(1).describe("Which page of results to return."),
        orderby: z.enum(["date", "date_gmt", "id", "include", "post", "parent", "type"]).optional().default("date").describe("Which field to sort by."),
        order: z.enum(["asc", "desc"]).optional().default("desc").describe("Sort direction."),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        const query: Record<string, unknown> = {
          post: args.post, search: args.search, author_email: args.author_email, parent: args.parent, type: args.type,
          after: args.after, before: args.before, per_page: args.per_page, page: args.page,
          orderby: args.orderby, order: args.order,
        };
        if (args.status) query.status = args.status;
        if (client.hasCredentials()) query.context = "edit";
        const res = await client.get<any[]>("/wp/v2/comments", query);
        return ok({
          site: client.site.id,
          total: res.total ?? res.data.length,
          total_pages: res.totalPages ?? 1,
          page: args.page,
          comments: res.data.map(shapeComment),
        });
      },
    }),

    defineTool({
      name: "get_comment",
      title: "Get a comment",
      readOnly: true,
      description: "Fetch one comment by ID with its full text, author details and moderation status.",
      schema: { site_id: siteIdSchema, id: z.number().int().describe("The comment ID.") },
      handler: async ({ site_id, id }) => {
        const client = site(site_id);
        const res = await client.get<any>(`/wp/v2/comments/${id}`, client.hasCredentials() ? { context: "edit" } : {});
        return ok({ ...shapeComment(res.data), content_html: unwrap(res.data.content) });
      },
    }),

    defineTool({
      name: "create_comment",
      title: "Create a comment",
      description: "Post a comment on a content item, optionally as a threaded reply. Set status to \"approve\" to publish it immediately (requires moderation capability); otherwise it enters the normal moderation queue.",
      schema: {
        site_id: siteIdSchema,
        post: z.number().int().describe("Content ID to comment on. Its comment_status must be \"open\"."),
        content: z.string().describe("The comment body. Basic HTML is allowed; WordPress sanitises it."),
        parent: z.number().int().optional().describe("Comment ID this replies to, for threading."),
        author_name: z.string().optional().describe("Display name, when not commenting as a logged-in user."),
        author_email: z.string().optional().describe("Email, when not commenting as a logged-in user."),
        author_url: z.string().optional().describe("Commenter website URL."),
        author: z.number().int().optional().describe("Post as this registered user ID."),
        status: z.enum(["approve", "hold", "spam"]).optional().describe("Moderation status. Requires moderate_comments to set."),
        date: z.string().optional().describe("ISO 8601 date to backdate the comment."),
      },
      handler: async ({ site_id, ...fields }) => {
        const client = site(site_id);
        client.assertWritable("create_comment");
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
        const res = await client.post<any>("/wp/v2/comments", body);
        audit({ site: client.site.id, tool: "create_comment", action: "create", target: res.data.id, outcome: "ok", detail: `post=${fields.post}` });
        return ok({ created: true, ...shapeComment(res.data) });
      },
    }),

    defineTool({
      name: "update_comment",
      title: "Update a comment",
      description: "Update a comment's text, author details or moderation status. Setting status to \"approve\" publishes a held comment; \"spam\" marks it as spam; \"trash\" hides it recoverably; \"unspam\" and \"untrash\" restore it to its previous status.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("The comment ID."),
        content: z.string().optional().describe("The body text."),
        status: z.enum(["approve", "hold", "spam", "unspam", "trash", "untrash"]).optional().describe("Moderation status or action."),
        author_name: z.string().optional().describe("Commenter display name."),
        author_email: z.string().optional().describe("Commenter email address."),
        author_url: z.string().optional().describe("Commenter website URL."),
        parent: z.number().int().optional().describe("Parent ID, or 0 for none."),
        date: z.string().optional().describe("ISO 8601 date."),
      },
      handler: async ({ site_id, id, ...fields }) => {
        const client = site(site_id);
        client.assertWritable("update_comment");
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
        if (Object.keys(body).length === 0) throw new Error("No fields to update were supplied.");
        const trash = body.status === "trash";
        if (trash) delete body.status;
        let data: any;
        if (Object.keys(body).length) data = (await client.post<any>(`/wp/v2/comments/${id}`, body)).data;
        if (trash) data = await trashComment(client, id);
        const changed = [...Object.keys(body), ...(trash ? ["status"] : [])];
        audit({ site: client.site.id, tool: "update_comment", action: trash ? "update+trash" : "update", target: id, outcome: "ok", detail: changed.join(",") });
        return ok({ updated: true, changed_fields: changed, ...shapeComment(data) });
      },
    }),

    defineTool({
      name: "delete_comment",
      title: "Delete a comment",
      destructive: true,
      description: "Delete a comment. It goes to the trash by default and is recoverable; force: true removes it permanently and requires confirm: true.",
      schema: {
        site_id: siteIdSchema,
        id: z.number().int().describe("The comment ID."),
        force: z.boolean().optional().default(false).describe("Delete permanently rather than trashing. Requires confirm: true."),
        confirm: z.boolean().optional().default(false).describe("Required for permanent deletion."),
      },
      handler: async ({ site_id, id, force, confirm }) => {
        const client = site(site_id);
        client.assertWritable("delete_comment");
        if (force && !confirm) {
          const current = await client.get<any>(`/wp/v2/comments/${id}`, { context: "edit" });
          return ok({ deleted: false, requires_confirmation: true, comment: shapeComment(current.data) },
            "Permanent deletion is irreversible, so nothing was removed. Re-run with force: true AND confirm: true, or drop `force` to trash it recoverably.");
        }
        const data = force ? (await client.del<any>(`/wp/v2/comments/${id}`, { force: true })).data : await trashComment(client, id);
        audit({ site: client.site.id, tool: "delete_comment", action: force ? "permanent delete" : "trash", target: id, outcome: "ok" });
        return ok({ deleted: true, permanent: Boolean(force), id, previous: data?.previous ? shapeComment(data.previous) : undefined });
      },
    }),

    defineTool({
      name: "moderate_comments",
      title: "Bulk moderate comments",
      description:
        "Approve, hold, spam, trash — or unspam/untrash — several comments in one call; the practical way to clear a moderation queue. Reports per-comment outcomes rather than failing the whole batch on one error.",
      schema: {
        site_id: siteIdSchema,
        ids: z.array(z.number().int()).min(1).max(100).describe("Comment IDs to act on."),
        action: z.enum(["approve", "hold", "spam", "unspam", "trash", "untrash"]).describe("What to do with each. unspam/untrash restore the comment's previous status."),
      },
      handler: async ({ site_id, ids, action }) => {
        const client = site(site_id);
        client.assertWritable("moderate_comments");
        const results: any[] = [];
        for (const id of ids) {
          try {
            if (action === "trash") {
              const data = await trashComment(client, id);
              results.push({ id, ok: true, status: data?.status ?? "trash" });
            } else {
              const res = await client.post<any>(`/wp/v2/comments/${id}`, { status: action });
              results.push({ id, ok: true, status: res.data.status });
            }
          } catch (e: any) {
            results.push({ id, ok: false, error: e.message });
          }
        }
        const succeeded = results.filter((r) => r.ok).length;
        audit({ site: client.site.id, tool: "moderate_comments", action, target: ids.join(","), outcome: "ok", detail: `${succeeded}/${ids.length}` });
        return ok({ action, requested: ids.length, succeeded, failed: ids.length - succeeded, results });
      },
    }),
  ];
}
