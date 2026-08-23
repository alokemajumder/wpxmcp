import { z } from "zod";
import { defineTool, ok, siteIdSchema, stripHtml, unwrap, wordCount, type ToolContext } from "../lib/tooling.js";
import { applyEdits, extractSeo, type EditOp } from "../lib/content-utils.js";
import { audit, issueConfirmation, consumeConfirmation, fingerprintOp } from "../lib/safety.js";

export function bulkTools(ctx: ToolContext) {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    defineTool({
      name: "bulk_update_content",
      title: "Bulk update content",
      description:
        "Apply the same change to many items at once — set a status, reassign an author, add a category, or run a find/replace across bodies. Always previews first: the initial call reports exactly which items would change and how, and returns a confirm_token you must echo back to apply it. Nothing is written without that token.",
      schema: {
        site_id: siteIdSchema,
        type: z.string().optional().default("post").describe("Content type to operate on."),
        filter: z.object({
          ids: z.array(z.number().int()).optional().describe("Operate on exactly these IDs, ignoring the other filters."),
          search: z.string().optional().describe("Only items matching this search."),
          status: z.string().optional().describe("Only items with this status."),
          author: z.number().int().optional().describe("User ID of the author."),
          categories: z.array(z.number().int()).optional(),
          tags: z.array(z.number().int()).optional(),
          before: z.string().optional().describe("Only items published before this ISO date."),
          after: z.string().optional().describe("Only items published after this ISO date."),
        }).optional().describe("Which items to act on. Without any filter this would match everything, so a limit always applies."),
        limit: z.number().int().min(1).max(500).optional().default(50).describe("Hard ceiling on how many items can be touched in one call."),
        changes: z.object({
          status: z.enum(["publish", "draft", "pending", "private", "future", "trash"]).optional().describe("Filter by status."),
          author: z.number().int().optional().describe("User ID of the author."),
          comment_status: z.enum(["open", "closed"]).optional().describe("Whether comments are open on this item."),
          ping_status: z.enum(["open", "closed"]).optional().describe("Whether pingbacks and trackbacks are accepted."),
          template: z.string().optional(),
          add_categories: z.array(z.number().int()).optional().describe("Category IDs to add, keeping existing ones."),
          add_tags: z.array(z.number().int()).optional().describe("Tag IDs to add, keeping existing ones."),
          remove_categories: z.array(z.number().int()).optional(),
          meta: z.record(z.any()).optional().describe("Registered meta keys to set on every matched item."),
        }).optional().describe("Field changes applied to every matched item."),
        content_edits: z.array(z.object({
          find: z.string(),
          replace: z.string(),
          regex: z.boolean().optional(),
          all: z.boolean().optional(),
        })).optional().describe("Find/replace applied to each item's body. Items where nothing matches are skipped rather than failing the batch."),
        confirm_token: z.string().optional().describe("Token from the preview. Required to actually write."),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        client.assertWritable("bulk_update_content");
        const restBase = await client.restBaseForType(args.type);

        if (!args.changes && !args.content_edits?.length) {
          throw new Error("Nothing to do — supply `changes`, `content_edits`, or both.");
        }

        // Collect the target set.
        let items: any[] = [];
        if (args.filter?.ids?.length) {
          for (const id of args.filter.ids.slice(0, args.limit)) {
            try {
              const res = await client.get<any>(`/wp/v2/${restBase}/${id}`, { context: "edit" });
              items.push(res.data);
            } catch (e: any) {
              items.push({ id, __error: e.message });
            }
          }
        } else {
          const query: Record<string, unknown> = { context: "edit", per_page: 100, status: args.filter?.status ?? "any" };
          for (const key of ["search", "author", "categories", "tags", "before", "after"] as const) {
            if (args.filter?.[key] !== undefined) query[key] = args.filter[key];
          }
          items = await client.getAll<any>(`/wp/v2/${restBase}`, query, args.limit);
        }

        // Work out what each item would become.
        const plan: any[] = [];
        for (const item of items) {
          if (item.__error) { plan.push({ id: item.id, skipped: true, reason: item.__error }); continue; }
          const body: Record<string, unknown> = {};
          const notes: string[] = [];

          if (args.changes) {
            for (const key of ["status", "author", "comment_status", "ping_status", "template", "meta"] as const) {
              if (args.changes[key] !== undefined) body[key] = args.changes[key];
            }
            if (args.changes.add_categories?.length) {
              body.categories = [...new Set([...(item.categories ?? []), ...args.changes.add_categories])];
            }
            if (args.changes.remove_categories?.length) {
              const start = (body.categories as number[]) ?? item.categories ?? [];
              body.categories = start.filter((c: number) => !args.changes!.remove_categories!.includes(c));
            }
            if (args.changes.add_tags?.length) {
              body.tags = [...new Set([...(item.tags ?? []), ...args.changes.add_tags])];
            }
          }

          if (args.content_edits?.length) {
            const current = unwrap(item.content);
            const edits = args.content_edits.map((e) => ({ ...e, required: false })) as EditOp[];
            const result = applyEdits(current, edits);
            if (result.changed) {
              body.content = result.content;
              notes.push(`${result.applied.reduce((n, a) => n + a.occurrences, 0)} replacement(s) in the body`);
            } else if (!args.changes) {
              plan.push({ id: item.id, title: stripHtml(unwrap(item.title)), skipped: true, reason: "no content matched the find patterns" });
              continue;
            }
          }

          if (Object.keys(body).length === 0) {
            plan.push({ id: item.id, title: stripHtml(unwrap(item.title)), skipped: true, reason: "nothing would change" });
            continue;
          }
          plan.push({
            id: item.id,
            title: stripHtml(unwrap(item.title)),
            current_status: item.status,
            would_change: Object.keys(body),
            notes: notes.length ? notes : undefined,
            __body: body,
          });
        }

        const actionable = plan.filter((p) => !p.skipped);
        const fingerprint = fingerprintOp(["bulk", client.site.id, args.type, args.filter, args.changes, args.content_edits, args.limit]);

        if (!args.confirm_token) {
          const token = await issueConfirmation(client.site.id, `bulk update ${actionable.length} ${args.type}`, fingerprint);
          audit({ site: client.site.id, tool: "bulk_update_content", action: "preview", outcome: "dry-run", detail: `${actionable.length} items` });
          return ok({
            applied: false, dry_run: true,
            matched: plan.length, would_update: actionable.length, would_skip: plan.length - actionable.length,
            plan: plan.map(({ __body, ...rest }) => rest),
            confirm_token: token,
          }, `Nothing was written. ${actionable.length} item(s) would change. Review the plan, then re-run the identical call with this confirm_token to apply it. The token lasts 10 minutes and is bound to these exact arguments.`);
        }

        const check = await consumeConfirmation(args.confirm_token, fingerprint);
        if (!check.valid) return ok({ applied: false, refused: true, reason: check.reason }, "The confirmation was not accepted, so nothing was written.");

        const results: any[] = [];
        for (const entry of actionable) {
          try {
            await client.post(`/wp/v2/${restBase}/${entry.id}`, entry.__body);
            results.push({ id: entry.id, title: entry.title, ok: true, changed: entry.would_change });
          } catch (e: any) {
            results.push({ id: entry.id, title: entry.title, ok: false, error: e.message });
          }
        }
        const succeeded = results.filter((r) => r.ok).length;
        audit({ site: client.site.id, tool: "bulk_update_content", action: "apply", outcome: "ok", detail: `${succeeded}/${actionable.length}` });
        return ok({ applied: true, attempted: actionable.length, succeeded, failed: actionable.length - succeeded, results });
      },
    }),

    defineTool({
      name: "audit_content",
      title: "Audit content quality",
      readOnly: true,
      description:
        "Sweep a content type and report the problems worth fixing: missing SEO titles and descriptions, missing or duplicate H1s, thin content, missing featured images, missing excerpts, uncategorised posts, and images without alt text. Read-only — it names the issues and the IDs so you can fix them with bulk_update_content or update_content.",
      schema: {
        site_id: siteIdSchema,
        type: z.string().optional().default("post").describe("Content type to audit."),
        limit: z.number().int().min(1).max(500).optional().default(100).describe("How many items to examine."),
        status: z.string().optional().default("publish").describe("Which status to audit. Published content is usually what matters."),
        thin_content_words: z.number().int().optional().default(300).describe("Word count below which content is flagged as thin."),
      },
      handler: async ({ site_id, type, limit, status, thin_content_words }) => {
        const client = site(site_id);
        const restBase = await client.restBaseForType(type);
        const items = await client.getAll<any>(`/wp/v2/${restBase}`, { status, context: "edit" }, limit);

        const findings: any[] = [];
        const slugSeen = new Map<string, number[]>();
        const titleSeen = new Map<string, number[]>();

        for (const item of items) {
          const content = unwrap(item.content);
          const title = stripHtml(unwrap(item.title));
          const words = wordCount(content);
          const seo = extractSeo(item) as any;
          const issues: string[] = [];

          if (!title) issues.push("no title");
          if (words < thin_content_words) issues.push(`thin content (${words} words, threshold ${thin_content_words})`);
          if (!stripHtml(unwrap(item.excerpt)).trim()) issues.push("no hand-written excerpt");
          if (!item.featured_media) issues.push("no featured image");
          if (seo?.plugin && !seo.description && !seo.yoast_metadesc) issues.push("no SEO meta description");
          if (seo?.plugin && !seo.title && !seo.yoast_title) issues.push("no SEO title override");
          if (type === "post" && (!item.categories || item.categories.length === 0 || (item.categories.length === 1 && item.categories[0] === 1))) {
            issues.push("uncategorised (or only the default category)");
          }
          const h1s = (content.match(/<h1\b/gi) ?? []).length;
          if (h1s > 0) issues.push(`${h1s} h1 element(s) inside the body — the theme normally renders the only h1 from the title`);
          const imgs = content.match(/<img\b[^>]*>/gi) ?? [];
          const missingAlt = imgs.filter((t) => !/\balt\s*=\s*["'][^"']+["']/i.test(t)).length;
          if (missingAlt) issues.push(`${missingAlt} of ${imgs.length} inline images have no alt text`);
          if (title.length > 60) issues.push(`title is ${title.length} characters — search results usually truncate past ~60`);

          if (item.slug) {
            if (!slugSeen.has(item.slug)) slugSeen.set(item.slug, []);
            slugSeen.get(item.slug)!.push(item.id);
          }
          const titleKey = title.toLowerCase().trim();
          if (titleKey) {
            if (!titleSeen.has(titleKey)) titleSeen.set(titleKey, []);
            titleSeen.get(titleKey)!.push(item.id);
          }

          if (issues.length) {
            findings.push({ id: item.id, title, link: item.link, word_count: words, issues });
          }
        }

        const duplicateTitles = [...titleSeen.entries()].filter(([, ids]) => ids.length > 1).map(([title, ids]) => ({ title, ids }));

        const issueTally: Record<string, number> = {};
        for (const f of findings) for (const issue of f.issues) {
          const key = issue.replace(/\d+/g, "N");
          issueTally[key] = (issueTally[key] ?? 0) + 1;
        }

        return ok({
          site: client.site.id, type, examined: items.length, status,
          items_with_issues: findings.length,
          clean_items: items.length - findings.length,
          issue_summary: Object.entries(issueTally).sort((a, b) => b[1] - a[1]).map(([issue, count]) => ({ issue, count })),
          duplicate_titles: duplicateTitles.length ? duplicateTitles : undefined,
          findings,
        }, findings.length === 0 ? "No issues found in the examined items." : undefined);
      },
    }),

    defineTool({
      name: "audit_media",
      title: "Audit the media library",
      readOnly: true,
      description:
        "Audit the media library for images missing alt text and for attachments not referenced by any content. Alt text is the highest-value accessibility fix on most sites, and unused media is where disk usage quietly accumulates.",
      schema: {
        site_id: siteIdSchema,
        limit: z.number().int().min(1).max(1000).optional().default(200).describe("How many attachments to examine."),
        check_unused: z.boolean().optional().default(false).describe("Also check which attachments no content references. Slower — it scans content bodies."),
      },
      handler: async ({ site_id, limit, check_unused }) => {
        const client = site(site_id);
        const media = await client.getAll<any>("/wp/v2/media", { context: "edit" }, limit);
        const images = media.filter((m) => m.media_type === "image");
        const missingAlt = images.filter((m) => !String(m.alt_text ?? "").trim());

        const payload: any = {
          site: client.site.id,
          examined: media.length,
          images: images.length,
          images_missing_alt: missingAlt.length,
          missing_alt_items: missingAlt.slice(0, 100).map((m) => ({
            id: m.id, title: stripHtml(unwrap(m.title)), source_url: m.source_url, attached_to: m.post ?? null,
          })),
          total_bytes: media.reduce((sum, m) => sum + (m.media_details?.filesize ?? 0), 0),
        };

        if (check_unused) {
          const types = await client.postTypes();
          const bodies: string[] = [];
          const featured = new Set<number>();
          for (const t of Object.values<any>(types)) {
            if (["attachment", "wp_template", "wp_global_styles", "wp_font_family", "wp_font_face"].includes(t.slug)) continue;
            try {
              const posts = await client.getAll<any>(`/wp/v2/${t.rest_base}`, { context: "edit", status: "any" }, 300);
              for (const p of posts) {
                bodies.push(unwrap(p.content));
                if (p.featured_media) featured.add(p.featured_media);
              }
            } catch { /* type not readable */ }
          }
          const haystack = bodies.join("\n");
          const unused = media.filter((m) => {
            if (featured.has(m.id)) return false;
            const filename = String(m.source_url ?? "").split("/").pop() ?? "";
            const stem = filename.replace(/\.[^.]+$/, "").replace(/-\d+x\d+$/, "");
            return stem ? !haystack.includes(stem) && !haystack.includes(`wp-image-${m.id}`) : false;
          });
          payload.possibly_unused = unused.length;
          payload.possibly_unused_items = unused.slice(0, 100).map((m) => ({
            id: m.id, title: stripHtml(unwrap(m.title)), source_url: m.source_url,
            filesize: m.media_details?.filesize,
          }));
          payload.unused_caveat = "Heuristic only: it scans content bodies and featured images. Attachments used by page builders, widgets, theme options or CSS can look unused here — verify before deleting anything.";
        }

        return ok(payload);
      },
    }),
  ];
}
