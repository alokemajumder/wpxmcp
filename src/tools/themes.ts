import { z } from "zod";
import { defineTool, ok, siteIdSchema, stripHtml, trimText, type ToolContext } from "../lib/tooling.js";
import { applyEdits, type EditOp } from "../lib/content-utils.js";
import { audit } from "../lib/safety.js";
import type { WordPressClient } from "../lib/client.js";
import { classicThemeScaffold } from "../lib/theme-scaffold.js";

async function helper(client: WordPressClient, action: string): Promise<string> {
  const ns = client.site.helperNamespace ?? "wpxmcp/v1";
  if (!(await client.hasHelperPlugin())) {
    throw new Error(
      `"${action}" needs the wpxmcp companion plugin, which is not active on "${client.site.id}". It exposes the ${ns} namespace for theme file access, WP-CLI emulation, SQL and page HTML — things core REST simply does not offer. Install wp-plugin/wpxmcp-helper from this repo (zip the folder, upload it under Plugins → Add New → Upload, activate), then run test_site to confirm.`
    );
  }
  return ns;
}

function shapeTheme(t: any) {
  return {
    stylesheet: t.stylesheet,
    template: t.template,
    name: stripHtml(String(t.name?.rendered ?? t.name?.raw ?? t.name ?? "")),
    status: t.status,
    version: t.version,
    author: stripHtml(String(t.author?.rendered ?? t.author ?? "")),
    description: stripHtml(String(t.description?.rendered ?? t.description ?? "")).slice(0, 400),
    is_block_theme: t.is_block_theme,
    parent: t.parent ?? t.template !== t.stylesheet ? t.template : undefined,
    theme_supports: t.theme_supports ? Object.keys(t.theme_supports).filter((k) => t.theme_supports[k]) : undefined,
    screenshot: t.screenshot,
  };
}

export function themeTools(ctx: ToolContext) {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    defineTool({
      name: "list_themes",
      title: "List themes",
      readOnly: true,
      description: "List every theme installed on the site, showing which is active, which are block (full-site-editing) themes, and their versions and parents.",
      schema: {
        site_id: siteIdSchema,
        status: z.enum(["active", "inactive", "all"]).optional().default("all").describe("Filter by status."),
      },
      handler: async ({ site_id, status }) => {
        const client = site(site_id);
        const res = await client.get<any[]>("/wp/v2/themes", { status: status === "all" ? undefined : status, context: "edit" });
        const themes = res.data.map(shapeTheme);
        const active = themes.find((t) => t.status === "active");
        return ok({
          site: client.site.id,
          active_theme: active?.stylesheet ?? null,
          active_is_block_theme: active?.is_block_theme ?? null,
          count: themes.length,
          themes,
        });
      },
    }),

    defineTool({
      name: "get_theme",
      title: "Get a theme",
      readOnly: true,
      description: "Get details about one installed theme, including what it declares support for and whether it is a block theme (which changes how you build pages and templates).",
      schema: { site_id: siteIdSchema, stylesheet: z.string().describe("Theme directory name, e.g. \"twentytwentyfour\".") },
      handler: async ({ site_id, stylesheet }) => {
        const client = site(site_id);
        const res = await client.get<any>(`/wp/v2/themes/${stylesheet}`, { context: "edit" });
        return ok({ ...shapeTheme(res.data), theme_supports: res.data.theme_supports });
      },
    }),

    defineTool({
      name: "activate_theme",
      title: "Activate a theme",
      destructive: true,
      description:
        "Switch the site's active theme. This changes the entire front-end appearance immediately, and widget/menu assignments do not always carry across. Requires confirm: true. If you are iterating on a theme you are building, use the draft workflow and publish_draft_theme instead.",
      schema: {
        site_id: siteIdSchema,
        stylesheet: z.string().describe("Theme directory name to activate."),
        confirm: z.boolean().optional().default(false).describe("Required — this changes the live site's appearance for every visitor."),
      },
      handler: async ({ site_id, stylesheet, confirm }) => {
        const client = site(site_id);
        client.assertWritable("activate_theme");
        const ns = await helper(client, "activate_theme");
        if (!confirm) {
          const themes = await client.get<any[]>("/wp/v2/themes", { context: "edit" });
          const current = themes.data.find((t: any) => t.status === "active");
          const target = themes.data.find((t: any) => t.stylesheet === stylesheet);
          if (!target) throw new Error(`No theme with stylesheet "${stylesheet}" is installed. Run list_themes.`);
          return ok({
            activated: false, requires_confirmation: true,
            current_theme: current ? shapeTheme(current) : null,
            would_activate: shapeTheme(target),
          }, "Switching themes changes the live front end immediately, and menu/widget placements may not carry over. Nothing changed — re-run with confirm: true to proceed.");
        }
        const res = await client.post<any>(`/${ns}/themes/activate`, { stylesheet });
        audit({ site: client.site.id, tool: "activate_theme", action: "activate", target: stylesheet, outcome: "ok" });
        return ok({ activated: true, ...res.data });
      },
    }),

    defineTool({
      name: "install_theme",
      title: "Install a theme",
      description: "Install a theme from the WordPress.org repository by slug. Does not activate it — use activate_theme, or the draft workflow, afterwards.",
      schema: {
        site_id: siteIdSchema,
        slug: z.string().describe("WordPress.org theme slug, e.g. \"twentytwentyfive\"."),
      },
      handler: async ({ site_id, slug }) => {
        const client = site(site_id);
        client.assertWritable("install_theme");
        const ns = await helper(client, "install_theme");
        const res = await client.post<any>(`/${ns}/themes/install`, { slug });
        audit({ site: client.site.id, tool: "install_theme", action: "install", target: slug, outcome: "ok" });
        return ok({ installed: true, ...res.data });
      },
    }),

    /* ------------------------------------------------------------------ *
     * Draft theme workflow
     * ------------------------------------------------------------------ */

    defineTool({
      name: "create_draft_theme",
      title: "Create a draft theme",
      description:
        "Clone an installed theme into an isolated draft copy that you can edit freely without touching the live site. Every theme edit should go through a draft: write files, preview them on a private tokenised URL, then publish_draft_theme when you are happy (which backs up the previous theme first). Omit `from_theme` to clone the currently active theme.",
      schema: {
        site_id: siteIdSchema,
        from_theme: z.string().optional().describe("Stylesheet to clone. Defaults to the active theme."),
        draft_name: z.string().optional().describe("Human-readable name for the draft. Defaults to \"<theme> (draft)\"."),
      },
      handler: async ({ site_id, from_theme, draft_name }) => {
        const client = site(site_id);
        client.assertWritable("create_draft_theme");
        const ns = await helper(client, "create_draft_theme");
        const res = await client.post<any>(`/${ns}/themes/draft`, { from_theme, draft_name });
        audit({ site: client.site.id, tool: "create_draft_theme", action: "create draft", target: res.data?.draft_stylesheet, outcome: "ok" });
        return ok(res.data, `Draft created. Edit it with write_theme_file / edit_theme_file using theme: "${res.data?.draft_stylesheet}", preview it with get_preview_url, then publish with publish_draft_theme. The live site is untouched until you publish.`);
      },
    }),

    defineTool({
      name: "create_classic_theme",
      title: "Scaffold a classic theme",
      description:
        "Scaffold a complete classic PHP theme styled with Tailwind, as a draft. Classic templates with utility classes are far more reliable to generate and to review than nested block markup — the output is readable, diffable and predictable. The scaffold includes style.css, functions.php, header/footer, index, single, page, archive, 404, search, comments, a theme.css holding the design tokens (colors, fonts, radii) that every template reuses, and a Tailwind CDN setup wired to those tokens.",
      schema: {
        site_id: siteIdSchema,
        name: z.string().describe("Theme display name, e.g. \"Northwind\"."),
        slug: z.string().optional().describe("Theme directory name. Derived from the name if omitted."),
        description: z.string().optional().describe("Theme description for style.css."),
        author: z.string().optional().default("wpxmcp").describe("User ID of the author."),
        tokens: z.object({
          primary: z.string().optional().describe("Primary brand color as a hex value, e.g. \"#1d4ed8\"."),
          accent: z.string().optional().describe("Accent color hex."),
          ink: z.string().optional().describe("Body text color hex."),
          surface: z.string().optional().describe("Page background hex."),
          font_sans: z.string().optional().describe("Sans-serif font stack."),
          font_serif: z.string().optional().describe("Serif font stack, used for headings if set."),
          radius: z.string().optional().describe("Base border radius, e.g. \"0.75rem\"."),
        }).optional().describe("Design tokens written into theme.css as CSS custom properties and reused across every template."),
        as_draft: z.boolean().optional().default(true).describe("Create it as an editable draft rather than a directly installed theme. Keep true."),
      },
      handler: async (args) => {
        const client = site(args.site_id);
        client.assertWritable("create_classic_theme");
        const ns = await helper(client, "create_classic_theme");
        const slug = (args.slug ?? args.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const files = classicThemeScaffold({
          name: args.name,
          slug,
          description: args.description ?? `${args.name}, a classic theme built with wpxmcp.`,
          author: args.author ?? "wpxmcp",
          tokens: args.tokens ?? {},
        });
        const res = await client.post<any>(`/${ns}/themes/scaffold`, { slug, name: args.name, files, as_draft: args.as_draft });
        audit({ site: client.site.id, tool: "create_classic_theme", action: "scaffold", target: slug, outcome: "ok", detail: `${Object.keys(files).length} files` });
        return ok(
          { created: true, slug: res.data?.stylesheet ?? slug, files_written: Object.keys(files), ...res.data },
          "Scaffold written. All design tokens live in theme.css — change them there rather than hardcoding colors in templates. Preview with get_preview_url, then publish_draft_theme when it looks right."
        );
      },
    }),

    defineTool({
      name: "list_theme_files",
      title: "List theme files",
      readOnly: true,
      description: "List the files in a theme (or theme draft) with sizes, so you can see the template structure before reading or editing anything.",
      schema: {
        site_id: siteIdSchema,
        theme: z.string().optional().describe("Theme stylesheet or draft id. Defaults to the active theme."),
        subdir: z.string().optional().describe("Restrict the listing to this subdirectory, e.g. \"template-parts\"."),
      },
      handler: async ({ site_id, theme, subdir }) => {
        const client = site(site_id);
        const ns = await helper(client, "list_theme_files");
        const res = await client.get<any>(`/${ns}/themes/files`, { theme, subdir });
        return ok(res.data);
      },
    }),

    defineTool({
      name: "read_theme_file",
      title: "Read a theme file",
      readOnly: true,
      description: "Read the contents of one theme file. Always read before editing — write_theme_file replaces the whole file, and edit_theme_file needs exact text to match.",
      schema: {
        site_id: siteIdSchema,
        path: z.string().describe("Path relative to the theme root, e.g. \"functions.php\" or \"template-parts/hero.php\"."),
        theme: z.string().optional().describe("Theme stylesheet or draft id. Defaults to the active theme."),
        max_chars: z.number().int().optional().default(80000).describe("Truncate very large files at this many characters."),
      },
      handler: async ({ site_id, path, theme, max_chars }) => {
        const client = site(site_id);
        const ns = await helper(client, "read_theme_file");
        const res = await client.get<any>(`/${ns}/themes/file`, { theme, path });
        return ok({
          theme: res.data.theme,
          path: res.data.path,
          bytes: res.data.bytes,
          modified: res.data.modified,
          content: trimText(res.data.content, max_chars),
        });
      },
    }),

    defineTool({
      name: "write_theme_file",
      title: "Write a theme file",
      description:
        "Create or overwrite a theme file, replacing its entire contents. Refuses to write to a live active theme by default — work in a draft (create_draft_theme) so the site stays untouched until you publish. PHP is syntax-checked before it is saved, so a parse error is reported rather than fataling the site.",
      schema: {
        site_id: siteIdSchema,
        path: z.string().describe("Path relative to the theme root, e.g. \"template-parts/hero.php\". Parent directories are created as needed."),
        content: z.string().describe("Full file contents."),
        theme: z.string().optional().describe("Theme stylesheet or draft id. Defaults to the active draft if there is one."),
        allow_live_theme: z.boolean().optional().default(false).describe("Permit writing directly into the live active theme. Strongly discouraged — use a draft."),
      },
      handler: async ({ site_id, path, content, theme, allow_live_theme }) => {
        const client = site(site_id);
        client.assertWritable("write_theme_file");
        const ns = await helper(client, "write_theme_file");
        const res = await client.post<any>(`/${ns}/themes/file`, { theme, path, content, allow_live: allow_live_theme });
        audit({ site: client.site.id, tool: "write_theme_file", action: "write", target: `${res.data?.theme}/${path}`, outcome: "ok", detail: `${content.length} bytes` });
        return ok({ written: true, ...res.data });
      },
    }),

    defineTool({
      name: "edit_theme_file",
      title: "Edit a theme file",
      description:
        "Make targeted find/replace edits inside a theme file, leaving the rest untouched. Safer than write_theme_file for changing one function or block of markup. An edit that matches nothing fails loudly rather than silently writing nothing.",
      schema: {
        site_id: siteIdSchema,
        path: z.string().describe("Path relative to the theme root."),
        edits: z.array(z.object({
          find: z.string().describe("Exact text to find. Read the file first."),
          replace: z.string().describe("Replacement text. Empty string deletes the match."),
          regex: z.boolean().optional().describe("Treat `find` as a regular expression."),
          all: z.boolean().optional().describe("Replace every occurrence rather than requiring a unique match."),
          required: z.boolean().optional().describe("Fail if this edit matches nothing. Default true."),
        })).min(1).describe("Edits applied in order."),
        theme: z.string().optional().describe("Theme stylesheet or draft id."),
        allow_live_theme: z.boolean().optional().default(false).describe("Permit editing the live active theme directly. Use a draft instead."),
      },
      handler: async ({ site_id, path, edits, theme, allow_live_theme }) => {
        const client = site(site_id);
        client.assertWritable("edit_theme_file");
        const ns = await helper(client, "edit_theme_file");
        const current = await client.get<any>(`/${ns}/themes/file`, { theme, path });
        const result = applyEdits(current.data.content, edits as EditOp[]);
        if (!result.changed) {
          return ok({ edited: false, path, report: result }, "The edits produced no change, so the file was not rewritten.");
        }
        const res = await client.post<any>(`/${ns}/themes/file`, { theme, path, content: result.content, allow_live: allow_live_theme });
        audit({ site: client.site.id, tool: "edit_theme_file", action: "edit", target: `${res.data?.theme}/${path}`, outcome: "ok", detail: `${result.applied.length} edits` });
        return ok({ edited: true, path, applied: result.applied, skipped: result.skipped, ...res.data });
      },
    }),

    defineTool({
      name: "delete_theme_file",
      title: "Delete a theme file",
      destructive: true,
      description: "Delete a file from a theme draft. Refuses to touch a live active theme unless explicitly allowed. Deleting a required template (index.php, style.css) breaks the theme.",
      schema: {
        site_id: siteIdSchema,
        path: z.string().describe("Path relative to the theme root."),
        theme: z.string().optional().describe("Theme stylesheet or draft id."),
        allow_live_theme: z.boolean().optional().default(false).describe("Permit acting on the live active theme. Use a draft instead."),
        confirm: z.boolean().optional().default(false).describe("Required — the file is removed from the server."),
      },
      handler: async ({ site_id, path, theme, allow_live_theme, confirm }) => {
        const client = site(site_id);
        client.assertWritable("delete_theme_file");
        const ns = await helper(client, "delete_theme_file");
        if (!confirm) {
          const current = await client.get<any>(`/${ns}/themes/file`, { theme, path }).catch(() => null);
          return ok({ deleted: false, requires_confirmation: true, path, bytes: current?.data?.bytes ?? "unknown" },
            "Nothing was deleted. Re-run with confirm: true to remove this file.");
        }
        const res = await client.request<any>(`/${ns}/themes/file`, { method: "DELETE", query: { theme, path, allow_live: allow_live_theme } });
        audit({ site: client.site.id, tool: "delete_theme_file", action: "delete", target: path, outcome: "ok" });
        return ok({ deleted: true, ...res.data });
      },
    }),

    defineTool({
      name: "get_preview_url",
      title: "Get a theme preview URL",
      readOnly: true,
      description:
        "Get a tokenised private URL that renders the site using a draft theme, without affecting what anyone else sees. Share it or open it to check your work before publishing. The token expires, so fetch a fresh URL if it stops working.",
      schema: {
        site_id: siteIdSchema,
        theme: z.string().optional().describe("Draft theme id to preview. Defaults to the most recent draft."),
        path: z.string().optional().default("/").describe("Which page to preview, e.g. \"/about/\"."),
      },
      handler: async ({ site_id, theme, path }) => {
        const client = site(site_id);
        const ns = await helper(client, "get_preview_url");
        const res = await client.get<any>(`/${ns}/themes/preview-url`, { theme, path });
        return ok(res.data, "Open this URL to see the draft theme. Only requests carrying this token render the draft; ordinary visitors keep seeing the live theme.");
      },
    }),

    defineTool({
      name: "publish_draft_theme",
      title: "Publish a draft theme",
      destructive: true,
      description:
        "Promote a draft theme to the live site. The currently active theme is backed up first, so the change is reversible. This is the one step that changes what visitors see — everything before it is sandboxed. Requires confirm: true.",
      schema: {
        site_id: siteIdSchema,
        theme: z.string().optional().describe("Draft theme id to publish. Defaults to the most recent draft."),
        confirm: z.boolean().optional().default(false).describe("Required — this changes the live site."),
      },
      handler: async ({ site_id, theme, confirm }) => {
        const client = site(site_id);
        client.assertWritable("publish_draft_theme");
        const ns = await helper(client, "publish_draft_theme");
        if (!confirm) {
          const info = await client.get<any>(`/${ns}/themes/drafts`).catch(() => ({ data: null } as any));
          return ok({ published: false, requires_confirmation: true, drafts: info.data },
            "Publishing replaces the live theme for every visitor. Nothing changed — preview it first with get_preview_url, then re-run with confirm: true. The previous theme is backed up automatically at that point.");
        }
        const res = await client.post<any>(`/${ns}/themes/publish`, { theme });
        audit({ site: client.site.id, tool: "publish_draft_theme", action: "publish", target: theme ?? "(latest draft)", outcome: "ok", detail: `backup=${res.data?.backup}` });
        return ok({ published: true, ...res.data }, `The previous theme was backed up${res.data?.backup ? ` as "${res.data.backup}"` : ""}, so this can be rolled back with activate_theme.`);
      },
    }),

    defineTool({
      name: "delete_draft_theme",
      title: "Delete a draft theme",
      destructive: true,
      description: "Discard a draft theme and its files. The live site is unaffected — this only removes the sandbox copy.",
      schema: {
        site_id: siteIdSchema,
        theme: z.string().describe("Draft theme id to discard."),
        confirm: z.boolean().optional().default(false).describe("Required — draft files are removed permanently."),
      },
      handler: async ({ site_id, theme, confirm }) => {
        const client = site(site_id);
        client.assertWritable("delete_draft_theme");
        const ns = await helper(client, "delete_draft_theme");
        if (!confirm) {
          return ok({ deleted: false, requires_confirmation: true, theme },
            "Nothing was deleted. Re-run with confirm: true to discard this draft and its unpublished changes.");
        }
        const res = await client.request<any>(`/${ns}/themes/draft`, { method: "DELETE", query: { theme } });
        audit({ site: client.site.id, tool: "delete_draft_theme", action: "delete draft", target: theme, outcome: "ok" });
        return ok({ deleted: true, ...res.data });
      },
    }),

    defineTool({
      name: "list_draft_themes",
      title: "List draft themes",
      readOnly: true,
      description: "List the theme drafts that exist on the site, with what each was cloned from and when it was last touched.",
      schema: { site_id: siteIdSchema },
      handler: async ({ site_id }) => {
        const client = site(site_id);
        const ns = await helper(client, "list_draft_themes");
        const res = await client.get<any>(`/${ns}/themes/drafts`);
        return ok(res.data);
      },
    }),
  ];
}
