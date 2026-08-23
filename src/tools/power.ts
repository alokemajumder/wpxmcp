import { z } from "zod";
import { defineTool, ok, siteIdSchema, trimText, type ToolContext } from "../lib/tooling.js";
import { audit, inspectSql, enforceRowLimit, inspectCliCommand, CLI_ALLOWLIST, issueConfirmation, consumeConfirmation, fingerprintOp } from "../lib/safety.js";
import type { WordPressClient } from "../lib/client.js";

async function requireHelper(client: WordPressClient, tool: string): Promise<string> {
  const ns = client.site.helperNamespace ?? "wpxmcp/v1";
  if (!(await client.hasHelperPlugin())) {
    throw new Error(
      `"${tool}" needs the wpxmcp companion plugin, which is not active on "${client.site.id}". Core WordPress exposes no REST route for this. Install wp-plugin/wpxmcp-helper from this repo: zip the folder, upload it under Plugins → Add New → Upload Plugin, activate it, then run test_site to confirm the ${ns} namespace appears.`
    );
  }
  return ns;
}

const FIELD_TYPES = [
  "text", "textarea", "wysiwyg", "number", "email", "url", "date",
  "select", "checkbox", "radio", "color", "image", "gallery", "repeater",
] as const;

export function powerTools(ctx: ToolContext) {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    /* ------------------------- WP-CLI ------------------------- */
    defineTool({
      name: "list_cli_commands",
      title: "List allowed WP-CLI commands",
      readOnly: true,
      description:
        "List every WP-CLI command run_wp_cli will accept. The allowlist is default-deny: anything not listed here is refused, no matter how it is phrased. Each entry says whether it writes.",
      schema: {
        filter: z.string().optional().describe("Show only commands containing this substring, e.g. \"plugin\"."),
      },
      handler: async ({ filter }) => {
        const entries = Object.entries(CLI_ALLOWLIST)
          .filter(([cmd]) => !filter || cmd.includes(filter))
          .map(([command, meta]) => ({ command, writes: meta.write, description: meta.description }));
        return ok({
          policy: "default-deny allowlist — commands are emulated in PHP by the companion plugin, so no WP-CLI binary or shell access is required on the host",
          count: entries.length,
          commands: entries,
        });
      },
    }),

    defineTool({
      name: "run_wp_cli",
      title: "Run a WP-CLI command",
      description:
        "Run a WP-CLI command against the site. Commands are emulated in PHP by the companion plugin — no WP-CLI binary or SSH access is needed on the host. Only allowlisted commands run (see list_cli_commands); everything else is refused. Writing commands need an Administrator account, and `search-replace` always previews as a dry run before it will touch anything.",
      schema: {
        site_id: siteIdSchema,
        command: z.string().describe("The command without the leading \"wp\", e.g. \"plugin list --status=active\" or \"option get blogname\"."),
        format: z.enum(["json", "table", "csv", "count", "ids"]).optional().default("json").describe("Output format the command should produce where it supports one."),
        confirm_token: z.string().optional().describe("Token from a previous dry-run preview, required for destructive commands such as search-replace."),
      },
      handler: async ({ site_id, command, format, confirm_token }) => {
        const client = site(site_id);
        const verdict = inspectCliCommand(command);
        if (!verdict.allowed) {
          audit({ site: client.site.id, tool: "run_wp_cli", action: command, outcome: "refused", detail: verdict.reason });
          return ok({ ran: false, refused: true, command, reason: verdict.reason },
            "The command was refused by the allowlist and nothing ran.");
        }
        if (verdict.write) client.assertWritable(`run_wp_cli ${verdict.matched}`);
        const ns = await requireHelper(client, "run_wp_cli");

        // search-replace rewrites content across the database — always preview first.
        const needsConfirmation = verdict.matched === "search-replace" && !/--dry-run\b/.test(command);
        const fingerprint = fingerprintOp(["wp_cli", client.site.id, command]);

        if (needsConfirmation && !confirm_token) {
          const dry = await client.post<any>(`/${ns}/cli`, { command: `${command} --dry-run`, format });
          const token = issueConfirmation(client.site.id, `wp ${command}`, fingerprint);
          audit({ site: client.site.id, tool: "run_wp_cli", action: command, outcome: "dry-run" });
          return ok({
            ran: false, dry_run: true, command, preview: dry.data, confirm_token: token,
          }, "This is a dry run — nothing was changed. Review the replacement count above, then re-run the identical command with this confirm_token to apply it. The token is valid for 10 minutes and only for these exact arguments.");
        }
        if (needsConfirmation && confirm_token) {
          const check = consumeConfirmation(confirm_token, fingerprint);
          if (!check.valid) return ok({ ran: false, refused: true, reason: check.reason }, "The confirmation was not accepted, so nothing ran.");
        }

        const res = await client.post<any>(`/${ns}/cli`, { command, format });
        audit({ site: client.site.id, tool: "run_wp_cli", action: command, outcome: "ok", detail: verdict.matched });
        return ok({
          ran: true, command, matched_allowlist_entry: verdict.matched,
          exit_code: res.data?.exit_code ?? 0,
          stdout: trimText(res.data?.stdout ?? res.data?.output ?? "", 30000),
          stderr: res.data?.stderr || undefined,
          data: res.data?.data,
        });
      },
    }),

    /* --------------------------- SQL --------------------------- */
    defineTool({
      name: "execute_sql_query",
      title: "Run a database query",
      description:
        "Run a SQL query against the WordPress database through the companion plugin. SELECT/SHOW/DESCRIBE/EXPLAIN run immediately with an enforced row limit. Anything that mutates data is blocked unless you pass allow_mutation: true, and even then it first returns a preview and a confirm_token that you must echo back — stacked statements are always refused. Reach for this only when the REST API and WP-CLI cannot get at the data: raw SQL bypasses WordPress hooks, so caches are not invalidated and plugin logic does not run.",
      schema: {
        site_id: siteIdSchema,
        query: z.string().describe("A single SQL statement. Use the site's real table prefix — get it from site_info if you are unsure it is wp_."),
        max_rows: z.number().int().min(1).max(1000).optional().default(200).describe("Row ceiling. A LIMIT is appended automatically to unbounded SELECTs."),
        allow_mutation: z.boolean().optional().default(false).describe("Permit a data-changing statement. Still requires a confirm_token from the preview."),
        confirm_token: z.string().optional().describe("Token returned by the preview, required to actually run a mutating statement."),
      },
      handler: async ({ site_id, query, max_rows, allow_mutation, confirm_token }) => {
        const client = site(site_id);
        const verdict = inspectSql(query, allow_mutation);

        if (!verdict.allowed) {
          audit({ site: client.site.id, tool: "execute_sql_query", action: "blocked", outcome: "refused", detail: verdict.reason });
          return ok({ ran: false, refused: true, reason: verdict.reason, statement: verdict.normalized },
            "The query was blocked before it reached the database.");
        }

        const ns = await requireHelper(client, "execute_sql_query");

        if (verdict.mutating) {
          client.assertWritable("execute_sql_query (mutating)");
          const fingerprint = fingerprintOp(["sql", client.site.id, verdict.normalized]);
          if (!confirm_token) {
            let preview: any = null;
            const selectEquivalent = toSelectPreview(verdict.normalized);
            if (selectEquivalent) {
              try {
                const res = await client.post<any>(`/${ns}/sql`, { query: enforceRowLimit(selectEquivalent, 20).query, readonly: true });
                preview = res.data;
              } catch (e: any) { preview = { preview_error: e.message }; }
            }
            const token = issueConfirmation(client.site.id, verdict.normalized, fingerprint);
            audit({ site: client.site.id, tool: "execute_sql_query", action: "mutation preview", outcome: "dry-run", detail: verdict.normalized.slice(0, 200) });
            return ok({
              ran: false, requires_confirmation: true, statement: verdict.normalized,
              rows_that_would_be_affected: preview, confirm_token: token,
            }, "Nothing was executed. Above are the rows this statement targets, as far as they could be previewed. Re-run the identical query with this confirm_token to execute it. Raw SQL skips WordPress hooks, so remember to flush caches afterwards.");
          }
          const check = consumeConfirmation(confirm_token, fingerprint);
          if (!check.valid) return ok({ ran: false, refused: true, reason: check.reason }, "The confirmation was not accepted, so nothing ran.");
        }

        const limited = verdict.mutating ? { query: verdict.normalized, applied: false } : enforceRowLimit(verdict.normalized, max_rows);
        const res = await client.post<any>(`/${ns}/sql`, { query: limited.query, readonly: !verdict.mutating, max_rows });
        audit({ site: client.site.id, tool: "execute_sql_query", action: verdict.mutating ? "mutation" : "select", outcome: "ok", detail: verdict.normalized.slice(0, 200) });

        return ok({
          ran: true, mutating: verdict.mutating,
          statement: limited.query,
          row_limit_applied: limited.applied || undefined,
          rows_returned: Array.isArray(res.data?.rows) ? res.data.rows.length : undefined,
          rows_affected: res.data?.rows_affected,
          columns: res.data?.columns,
          rows: res.data?.rows,
        }, limited.applied ? `A LIMIT ${max_rows} was appended to keep the result manageable — raise max_rows if you need more.` : undefined);
      },
    }),

    /* ------------------------ Abilities ------------------------ */
    defineTool({
      name: "discover_abilities",
      title: "Discover plugin abilities",
      readOnly: true,
      description:
        "List the abilities registered on the site through the WordPress Abilities API — capabilities that plugins such as WPForms, AIOSEO or SeedProd expose for programmatic use. Running a plugin's own ability is always safer than writing to its tables directly, because the plugin's validation, hooks and cache invalidation still run.",
      schema: {
        site_id: siteIdSchema,
        search: z.string().optional().describe("Filter abilities by name or description."),
      },
      handler: async ({ site_id, search }) => {
        const client = site(site_id);
        const discovery = await client.discovery(true);
        const abilityNs = discovery.namespaces.find((n) => n.startsWith("wp-abilities") || n.startsWith("abilities"));

        if (!abilityNs) {
          const ns = client.site.helperNamespace ?? "wpxmcp/v1";
          if (await client.hasHelperPlugin()) {
            const res = await client.get<any>(`/${ns}/abilities`, { search }).catch(() => null);
            if (res) return ok({ site: client.site.id, source: "companion plugin bridge", abilities: res.data });
          }
          return ok({ site: client.site.id, abilities: [], abilities_api_present: false },
            "This site does not expose the Abilities API — no plugin has registered abilities, or the plugins predate it. Use the plugin's own REST namespace (discover_rest_routes) or run_wp_cli instead.");
        }

        const res = await client.get<any>(`/${abilityNs}/abilities`, { search });
        const list = Array.isArray(res.data) ? res.data : res.data?.abilities ?? [];
        return ok({
          site: client.site.id, namespace: abilityNs, count: list.length,
          abilities: list.map((a: any) => ({
            name: a.name ?? a.id, label: a.label ?? a.title,
            description: String(a.description ?? "").slice(0, 300),
            category: a.category, input_schema: a.input_schema ?? a.inputSchema,
          })),
        }, "Call one with run_ability. Check its input_schema first so the arguments match.");
      },
    }),

    defineTool({
      name: "get_ability_info",
      title: "Get ability details",
      readOnly: true,
      description: "Get the full definition of one ability, including its input and output schemas, so you can call it correctly the first time.",
      schema: {
        site_id: siteIdSchema,
        name: z.string().describe("Ability name, as returned by discover_abilities."),
      },
      handler: async ({ site_id, name }) => {
        const client = site(site_id);
        const discovery = await client.discovery();
        const abilityNs = discovery.namespaces.find((n) => n.startsWith("wp-abilities") || n.startsWith("abilities"));
        if (!abilityNs) throw new Error("This site does not expose the Abilities API. Run discover_abilities for alternatives.");
        const res = await client.get<any>(`/${abilityNs}/abilities/${encodeURIComponent(name)}`);
        return ok(res.data);
      },
    }),

    defineTool({
      name: "run_ability",
      title: "Run a plugin ability",
      description:
        "Execute an ability registered through the WordPress Abilities API. This is the preferred way to write data owned by a plugin — the plugin's own validation, hooks and cache invalidation run, which raw SQL would bypass. Check get_ability_info for the input schema first.",
      schema: {
        site_id: siteIdSchema,
        name: z.string().describe("Ability name from discover_abilities."),
        input: z.record(z.any()).optional().describe("Arguments matching the ability's input_schema."),
      },
      handler: async ({ site_id, name, input }) => {
        const client = site(site_id);
        client.assertWritable(`run_ability ${name}`);
        const discovery = await client.discovery();
        const abilityNs = discovery.namespaces.find((n) => n.startsWith("wp-abilities") || n.startsWith("abilities"));
        if (!abilityNs) throw new Error("This site does not expose the Abilities API.");
        const res = await client.post<any>(`/${abilityNs}/abilities/${encodeURIComponent(name)}/run`, { input: input ?? {} });
        audit({ site: client.site.id, tool: "run_ability", action: name, outcome: "ok" });
        return ok({ ran: true, ability: name, result: res.data });
      },
    }),

    /* ------------------------- Snippets ------------------------- */
    defineTool({
      name: "code_snippet",
      title: "Manage code snippets",
      description:
        "Add PHP, CSS or JavaScript to the site as a managed snippet rather than by editing theme files — so it survives theme updates and can be switched off without touching code. New snippets are always created DISABLED: you activate them in wp-admin after reading the code. PHP snippets are syntax-checked before they are saved, so a parse error is reported rather than fataling the site.",
      schema: {
        site_id: siteIdSchema,
        action: z.enum(["list", "get", "create", "update", "delete"]).describe("What to do."),
        id: z.union([z.number().int(), z.string()]).optional().describe("Snippet id, for get/update/delete."),
        title: z.string().optional().describe("Snippet name, for create/update."),
        code: z.string().optional().describe("The snippet body. For PHP, omit the opening <?php tag."),
        language: z.enum(["php", "css", "js", "html"]).optional().describe("Snippet language, for create."),
        location: z.enum(["everywhere", "frontend", "admin", "header", "footer"]).optional().default("everywhere")
          .describe("Where it runs. CSS and JS snippets usually want header or footer."),
        description: z.string().optional().describe("Why this snippet exists — worth writing, since someone will find it later."),
        confirm: z.boolean().optional().default(false).describe("Required for delete."),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        const ns = await requireHelper(client, "code_snippet");

        if (args.action === "list") {
          const res = await client.get<any>(`/${ns}/snippets`);
          return ok(res.data);
        }
        if (args.action === "get") {
          if (!args.id) throw new Error("`id` is required for get.");
          const res = await client.get<any>(`/${ns}/snippets/${args.id}`);
          return ok(res.data);
        }

        client.assertWritable(`code_snippet ${args.action}`);

        if (args.action === "create") {
          if (!args.code || !args.title) throw new Error("`title` and `code` are required to create a snippet.");
          const res = await client.post<any>(`/${ns}/snippets`, {
            title: args.title, code: args.code, language: args.language ?? "php",
            location: args.location, description: args.description, active: false,
          });
          audit({ site: client.site.id, tool: "code_snippet", action: "create", target: res.data?.id, outcome: "ok", detail: args.title });
          return ok({ created: true, ...res.data },
            "The snippet was saved DISABLED and is not running. Review it in wp-admin and activate it there — code that executes on a live site should be read by a human first.");
        }
        if (args.action === "update") {
          if (!args.id) throw new Error("`id` is required for update.");
          const body: Record<string, unknown> = {};
          for (const k of ["title", "code", "location", "description"] as const) if (args[k] !== undefined) body[k] = args[k];
          const res = await client.post<any>(`/${ns}/snippets/${args.id}`, body);
          audit({ site: client.site.id, tool: "code_snippet", action: "update", target: args.id, outcome: "ok" });
          return ok({ updated: true, ...res.data });
        }

        if (!args.id) throw new Error("`id` is required for delete.");
        if (!args.confirm) {
          const current = await client.get<any>(`/${ns}/snippets/${args.id}`);
          return ok({ deleted: false, requires_confirmation: true, snippet: current.data },
            "Nothing was deleted. Re-run with confirm: true to remove this snippet.");
        }
        const res = await client.request<any>(`/${ns}/snippets/${args.id}`, { method: "DELETE" });
        audit({ site: client.site.id, tool: "code_snippet", action: "delete", target: args.id, outcome: "ok" });
        return ok({ deleted: true, ...res.data });
      },
    }),

    /* ---------------------- Editable fields ---------------------- */
    defineTool({
      name: "register_fields",
      title: "Register editable fields",
      description:
        "Register custom fields that appear as native meta boxes in wp-admin (or as a settings page for site-wide options), and are automatically exposed to the REST API so they can be read and written afterwards. Use this when building a theme so the site stays editable by humans without touching code. Values are stored as ordinary post meta or options, so the data survives even if this tooling is removed. Thirteen field types are supported: text, textarea, wysiwyg, number, email, url, date, select, checkbox, radio, color, image, gallery, repeater.",
      schema: {
        site_id: siteIdSchema,
        group_key: z.string().describe("Unique key for this field group, e.g. \"homepage_hero\"."),
        title: z.string().describe("Group title shown above the meta box."),
        context: z.enum(["post_meta", "options"]).optional().default("post_meta")
          .describe("post_meta: a meta box on content. options: a site-wide settings page."),
        post_types: z.array(z.string()).optional().describe("Which content types get the meta box, e.g. [\"page\"]. Required for post_meta."),
        position: z.enum(["normal", "side", "advanced"]).optional().default("normal").describe("Where the meta box sits in the editor."),
        description: z.string().optional().describe("Help text shown at the top of the group."),
        fields: z.array(z.object({
          key: z.string().describe("Meta key / option name. Stick to lowercase with underscores."),
          label: z.string().describe("Label shown to the editor."),
          type: z.enum(FIELD_TYPES).describe("Field type."),
          description: z.string().optional().describe("Help text beneath the field."),
          default: z.any().optional(),
          required: z.boolean().optional(),
          placeholder: z.string().optional(),
          choices: z.array(z.object({ value: z.string(), label: z.string() })).optional()
            .describe("Options for select, radio and checkbox fields."),
          min: z.number().optional().describe("Minimum, for number fields."),
          max: z.number().optional().describe("Maximum, for number fields."),
          sub_fields: z.array(z.any()).optional().describe("Field definitions repeated per row, for a repeater."),
        })).min(1).describe("The fields in this group, in display order."),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        client.assertWritable("register_fields");
        const ns = await requireHelper(client, "register_fields");
        if (args.context === "post_meta" && !args.post_types?.length) {
          throw new Error("`post_types` is required when context is \"post_meta\" — say which content types should show this meta box.");
        }
        const res = await client.post<any>(`/${ns}/fields`, args);
        audit({ site: client.site.id, tool: "register_fields", action: "register", target: args.group_key, outcome: "ok", detail: `${args.fields.length} fields` });
        return ok({ registered: true, ...res.data },
          "The fields now render in wp-admin and are exposed to the REST API, so get_content/update_content can read and write them through `meta`. Values are stored as standard post meta or options.");
      },
    }),

    defineTool({
      name: "list_field_groups",
      title: "List registered field groups",
      readOnly: true,
      description: "List the editable field groups registered on the site, with their fields and where each appears. Check here before registering a group so you extend an existing one rather than duplicating it.",
      schema: { site_id: siteIdSchema },
      handler: async ({ site_id }) => {
        const client = site(site_id);
        const ns = await requireHelper(client, "list_field_groups");
        const res = await client.get<any>(`/${ns}/fields`);
        return ok(res.data);
      },
    }),

    defineTool({
      name: "delete_field_group",
      title: "Delete a field group",
      destructive: true,
      description: "Remove a registered field group. The stored values are left in place, so the data is not lost and the group can be re-registered to expose it again.",
      schema: {
        site_id: siteIdSchema,
        group_key: z.string().describe("The group key to remove."),
        confirm: z.boolean().optional().default(false).describe("Required."),
      },
      handler: async ({ site_id, group_key, confirm }) => {
        const client = site(site_id);
        client.assertWritable("delete_field_group");
        const ns = await requireHelper(client, "delete_field_group");
        if (!confirm) {
          return ok({ deleted: false, requires_confirmation: true, group_key },
            "Nothing was removed. Re-run with confirm: true. Field values in the database are kept either way — only the admin UI and REST exposure go away.");
        }
        const res = await client.request<any>(`/${ns}/fields/${encodeURIComponent(group_key)}`, { method: "DELETE" });
        audit({ site: client.site.id, tool: "delete_field_group", action: "delete", target: group_key, outcome: "ok" });
        return ok({ deleted: true, ...res.data });
      },
    }),

    defineTool({
      name: "get_options",
      title: "Read site options",
      readOnly: true,
      description: "Read values from the WordPress options table by name — where plugins and themes keep their configuration. Autoloaded options are also where a bloated database often hides.",
      schema: {
        site_id: siteIdSchema,
        names: z.array(z.string()).optional().describe("Option names to read. Omit with `search` to browse."),
        search: z.string().optional().describe("Find option names containing this substring."),
        limit: z.number().int().min(1).max(200).optional().default(50).describe("How many options to return when browsing."),
      },
      handler: async ({ site_id, names, search, limit }) => {
        const client = site(site_id);
        const ns = await requireHelper(client, "get_options");
        const res = await client.get<any>(`/${ns}/options`, { names: names?.join(","), search, limit });
        return ok(res.data);
      },
    }),

    defineTool({
      name: "set_option",
      title: "Write a site option",
      description:
        "Write a value to the WordPress options table. Options drive plugin and theme behaviour, and a wrong value can break the site — read the current value first with get_options, and prefer a plugin's own settings screen or ability where one exists.",
      schema: {
        site_id: siteIdSchema,
        name: z.string().describe("Option name."),
        value: z.any().describe("New value. Arrays and objects are serialised the way WordPress expects."),
        autoload: z.boolean().optional().describe("Whether to load this option on every page request. Leave unset to keep the current behaviour; large values should not autoload."),
      },
      handler: async ({ site_id, name, value, autoload }) => {
        const client = site(site_id);
        client.assertWritable("set_option");
        const ns = await requireHelper(client, "set_option");
        const before = await client.get<any>(`/${ns}/options`, { names: name }).catch(() => null);
        const res = await client.post<any>(`/${ns}/options`, { name, value, autoload });
        audit({ site: client.site.id, tool: "set_option", action: "write", target: name, outcome: "ok" });
        return ok({ updated: true, name, previous_value: before?.data?.options?.[name], new_value: res.data?.value });
      },
    }),
  ];
}

/** Best-effort SELECT preview of what an UPDATE/DELETE would touch. */
function toSelectPreview(statement: string): string | null {
  const lower = statement.toLowerCase();
  const deleteMatch = /^delete\s+from\s+(\S+)(\s+where\s+[\s\S]+)?$/i.exec(statement.trim());
  if (deleteMatch) return `SELECT * FROM ${deleteMatch[1]}${deleteMatch[2] ?? ""}`;
  const updateMatch = /^update\s+(\S+)\s+set\s+[\s\S]+?(\s+where\s+[\s\S]+)?$/i.exec(statement.trim());
  if (updateMatch) return `SELECT * FROM ${updateMatch[1]}${updateMatch[2] ?? ""}`;
  if (lower.startsWith("insert")) return null;
  return null;
}
