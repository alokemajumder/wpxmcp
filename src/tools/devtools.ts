import { z } from "zod";
import { defineTool, ok, siteIdSchema, type ToolContext, type ToolSpec } from "../lib/tooling.js";
import { audit, consumeConfirmation, issueConfirmation } from "../lib/safety.js";
import {
  CLEANUP_ACTIONS, REGISTRY_HINTS, REGISTRY_KINDS, cleanupFingerprint, explainMissingRoute,
  normalizeOptionNames, previewHasChanges, requireHelperNamespace,
} from "../lib/devtools-core.js";
import { protectedOptionReason } from "./power.js";

/**
 * WordPress-developer introspection: what is registered, who registered it,
 * where the options table and database carry weight, and one guarded cleanup.
 * Everything reads through the companion plugin; nothing here touches the
 * filesystem, so it runs the same on Node and Workers.
 */
export function devTools(ctx: ToolContext): Array<ToolSpec<any>> {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    defineTool({
      name: "inspect_registry",
      title: "Inspect WordPress registries",
      readOnly: true,
      idempotent: true,
      description:
        "See what the running WordPress has registered and which plugin, theme or core file registered it — the questions a developer answers with var_dump. kind selects the registry: post_types and taxonomies (all of them, including ones hidden from REST, with rest_base, supports, rewrite and owner); meta (register_meta keys per object type plus the most frequent unregistered postmeta keys with an owner guess); blocks (block types with dynamic flag, attribute count, supports, block.json source, styles, variations, plus block patterns); shortcodes (callback file:line); rest_routes (methods, callback file:line, and routes whose permission_callback is __return_true flagged public); hooks (busiest hooks, or every callback on one hook with priority and file:line); cron (events with next run, schedule, overdue and orphan flags); image_sizes; menus_locations; sidebars; capabilities (each role's caps added/removed versus a fresh install); scripts_styles (handles registered during REST). Needs the companion plugin.",
      schema: {
        site_id: siteIdSchema,
        kind: z.enum(REGISTRY_KINDS).describe("Which registry to read. hooks and rest_routes are the usual starting points when debugging 'where does this behaviour come from'."),
        filter: z.string().max(200).optional().describe("Narrow the result. A case-insensitive substring on names for most kinds; a namespace such as \"wc/v3\" for rest_routes; an exact hook name such as \"the_content\" for hooks (lists its callbacks — a partial name lists matching hooks instead); for meta, start with \"_\" or pass \"protected\" to include underscore-prefixed keys."),
        limit: z.number().int().min(1).max(500).optional().default(100).describe("Maximum rows per list in the response. Every list also reports its untruncated total."),
      },
      handler: async ({ site_id, kind, filter, limit }) => {
        const client = site(site_id);
        const ns = await requireHelperNamespace(client, "inspect_registry");
        const res = await client.get<any>(`/${ns}/registry`, { kind, filter: filter || undefined, limit })
          .catch((e) => explainMissingRoute(e, "inspect_registry"));
        return ok({ site: client.site.id, ...res.data }, REGISTRY_HINTS[kind]);
      },
    }),

    defineTool({
      name: "inspect_options",
      title: "Inspect options and transients",
      readOnly: true,
      idempotent: true,
      description:
        "Report where the options table carries weight: total autoloaded bytes against Site Health's 800 KB warning, the largest autoloaded options with an owner guessed from installed plugin/theme slugs (flagging owners that are inactive or no longer installed), a per-owner rollup, and transient hygiene for both transients and site transients — count, bytes, expired rows, orphaned timeout rows and the largest entries. Honours WordPress 6.6 autoload values (on/auto-on/auto). Use it before cleanup_options to decide what to change. Needs the companion plugin.",
      schema: {
        site_id: siteIdSchema,
        limit: z.number().int().min(1).max(200).optional().default(25).describe("How many of the largest autoloaded options (and largest transients, up to 20) to list."),
      },
      handler: async ({ site_id, limit }) => {
        const client = site(site_id);
        const ns = await requireHelperNamespace(client, "inspect_options");
        const res = await client.get<any>(`/${ns}/options/report`, { limit })
          .catch((e) => explainMissingRoute(e, "inspect_options"));
        const status = res.data?.autoload?.status;
        return ok({ site: client.site.id, ...res.data },
          status === "warn"
            ? "Autoloaded options are over the Site Health threshold. Large options owned by inactive or missing plugins are the safest to address — preview with cleanup_options."
            : undefined);
      },
    }),

    defineTool({
      name: "cleanup_options",
      title: "Clean up options and transients",
      destructive: true,
      description:
        "Reduce options-table weight in one of three ways: delete_expired_transients (expired transients and site transients, plus timeout rows whose value is gone), set_autoload_off (stop loading named options on every request — they remain readable on demand), or delete_options (remove named options). Always two steps: the first call is a dry run that returns exactly what would change, the bytes saved, what was refused and a confirm_token; repeat the identical call with that token to apply it. Core WordPress options, wpxmcp's own state and lock-out options (siteurl, active_plugins, user roles, salts…) are refused. Deleting an option a plugin still uses resets that plugin's setting, so check owners in inspect_options first. Needs the companion plugin.",
      schema: {
        site_id: siteIdSchema,
        action: z.enum(CLEANUP_ACTIONS).describe("delete_expired_transients, set_autoload_off (needs names) or delete_options (needs names)."),
        names: z.array(z.string().min(1).max(191)).max(200).optional().describe("Option names for set_autoload_off or delete_options, exactly as listed by inspect_options. Ignored for delete_expired_transients."),
        confirm_token: z.string().optional().describe("Token from this tool's dry-run preview. Omit it to preview; pass it back with identical action and names to apply."),
      },
      handler: async ({ site_id, action, names, confirm_token }) => {
        const client = site(site_id);
        client.assertWritable(`cleanup_options ${action}`);

        const list = action === "delete_expired_transients" ? [] : normalizeOptionNames(names);
        if (action !== "delete_expired_transients" && list.length === 0) {
          throw new Error(`\`names\` is required for ${action}. Take them from inspect_options.`);
        }

        // Refuse the obvious ones before touching the site; the plugin re-checks
        // with its own (longer) list of core option names.
        const localRefusals = list
          .map((name) => ({ name, reason: protectedOptionReason(name) }))
          .filter((r): r is { name: string; reason: string } => Boolean(r.reason));
        const refusedNames = new Set(localRefusals.map((r) => r.name));
        const sendable = list.filter((n) => !refusedNames.has(n));

        if (action !== "delete_expired_transients" && sendable.length === 0) {
          audit({ site: client.site.id, tool: "cleanup_options", action, outcome: "refused", detail: list.join(", ").slice(0, 200) });
          return ok({ applied: false, refused: localRefusals }, "Every named option is protected, so nothing was sent to the site.");
        }

        const ns = await requireHelperNamespace(client, "cleanup_options");
        const previewRes = await client.post<any>(`/${ns}/options/cleanup`, { action, names: sendable, dry_run: true })
          .catch((e) => explainMissingRoute(e, "cleanup_options"));
        const preview = previewRes.data ?? {};
        if (localRefusals.length) preview.refused = [...localRefusals, ...(Array.isArray(preview.refused) ? preview.refused : [])];

        const fingerprint = cleanupFingerprint(client.site.id, action, list, preview);

        if (!previewHasChanges(action, preview)) {
          return ok({ applied: false, nothing_to_change: true, preview },
            "Nothing matches, so there is nothing to confirm — no token was issued.");
        }

        if (!confirm_token) {
          const token = await issueConfirmation(client.site.id, `cleanup_options ${action}`, fingerprint);
          audit({ site: client.site.id, tool: "cleanup_options", action, outcome: "dry-run", detail: `${preview.bytes_saved ?? 0} bytes; ${sendable.join(", ").slice(0, 160)}` });
          return ok({ applied: false, dry_run: true, preview, confirm_token: token },
            "This is a dry run — nothing changed. Review `changes`, `bytes_saved` and `refused`, then repeat the identical call with this confirm_token to apply it. The token is valid for 10 minutes and only while the preview stays the same.");
        }

        const check = await consumeConfirmation(confirm_token, fingerprint);
        if (!check.valid) {
          audit({ site: client.site.id, tool: "cleanup_options", action, outcome: "refused", detail: check.reason });
          return ok({ applied: false, refused: true, reason: check.reason, current_preview: preview },
            "The confirmation was not accepted, so nothing changed.");
        }

        // Apply only what the (re-validated) preview listed.
        const applyNames = action === "delete_expired_transients"
          ? []
          : (preview.changes as any[]).map((c) => String(c.name));
        const res = await client.post<any>(`/${ns}/options/cleanup`, { action, names: applyNames, dry_run: false });
        audit({ site: client.site.id, tool: "cleanup_options", action, outcome: "ok", detail: `${res.data?.bytes_saved ?? 0} bytes; ${applyNames.join(", ").slice(0, 160)}` });
        return ok({ applied: true, result: res.data },
          action === "set_autoload_off"
            ? "Autoload is off for these options. If a page-cache or object-cache plugin is active, flush it so the lighter alloptions is picked up."
            : undefined);
      },
    }),

    defineTool({
      name: "inspect_database",
      title: "Inspect the database",
      readOnly: true,
      idempotent: true,
      description:
        "A developer's view of the WordPress database: every table with engine, collation, approximate rows, data and index bytes and reclaimable overhead; which plugin each non-core table belongs to, with tables whose owner is inactive, not installed or unknown listed as possible orphans; orphaned rows (postmeta, commentmeta and usermeta without a parent, term relationships pointing nowhere); revisions per post type, auto-drafts, trashed posts and spam/trash comments; and tables not on utf8mb4. Counts are capped so a huge table cannot stall the query. Works on MySQL/MariaDB and on the SQLite integration (sizes are then unavailable and noted). Read-only. Needs the companion plugin.",
      schema: {
        site_id: siteIdSchema,
      },
      handler: async ({ site_id }) => {
        const client = site(site_id);
        const ns = await requireHelperNamespace(client, "inspect_database");
        const res = await client.get<any>(`/${ns}/database`).catch((e) => explainMissingRoute(e, "inspect_database"));
        return ok({ site: client.site.id, ...res.data });
      },
    }),
  ];
}
