import { z } from "zod";
import { defineTool, ok, siteIdSchema, stripHtml, unwrap, trimText, type ToolContext, type ToolSpec } from "../lib/tooling.js";
import { audit, issueConfirmation, consumeConfirmation, fingerprintOp } from "../lib/safety.js";
import type { WordPressClient } from "../lib/client.js";
import { routeId, deepMerge } from "./appearance.js";
import { themeStylesheet } from "./themes.js";
import { resolveSiteUrl, isSameSite } from "./site.js";
import {
  jsonDiff, lintThemeJson, paletteMap, parseJsonText, summarizeVariation, variationKind,
  type DiffEntry, type LintIssue,
} from "../lib/themedev-json.js";
import { checkAccessibility, A11Y_RULES, type A11yIssue } from "../lib/themedev-html.js";
import { readCapped } from "../lib/http-utils.js";

/** Largest page check_accessibility will read. */
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

interface ActiveTheme {
  stylesheet: string;
  template: string;
  name: string;
  isBlockTheme: boolean;
  userStylesId?: string;
}

async function activeTheme(client: WordPressClient): Promise<ActiveTheme> {
  const res = await client.get<any[]>("/wp/v2/themes", { status: "active", context: "edit" });
  const t = res.data?.[0];
  if (!t) throw new Error("Could not determine the active theme — the account may lack the switch_themes/edit_theme_options capability needed to read /wp/v2/themes.");
  const href: string | undefined = t._links?.["wp:user-global-styles"]?.[0]?.href;
  const id = href ? /\/global-styles\/(\d+)/.exec(href)?.[1] ?? href.split("/").pop() : undefined;
  return {
    stylesheet: t.stylesheet,
    template: t.template,
    name: stripHtml(String(t.name?.rendered ?? t.name?.raw ?? t.name ?? t.stylesheet)),
    isBlockTheme: Boolean(t.is_block_theme),
    userStylesId: id && /^\d+$/.test(id) ? id : undefined,
  };
}

function requireBlockTheme(theme: ActiveTheme, tool: string): string {
  if (!theme.isBlockTheme || !theme.userStylesId) {
    throw new Error(`${tool} works on block themes, but the active theme "${theme.stylesheet}" is a classic theme with no global styles. Its design tokens live in style.css — use read_theme_file.`);
  }
  return theme.userStylesId;
}

async function baseStyles(client: WordPressClient, stylesheet: string) {
  return (await client.get<any>(`/wp/v2/global-styles/themes/${themeStylesheet(stylesheet)}`, { context: "edit" })).data ?? {};
}

async function userStyles(client: WordPressClient, id: string) {
  return (await client.get<any>(`/wp/v2/global-styles/${id}`, { context: "edit" })).data ?? {};
}

function shapeTemplate(t: any, kind: "template" | "template_part") {
  return {
    id: t.id,
    kind,
    slug: t.slug,
    title: stripHtml(unwrap(t.title)),
    area: t.area,
    source: t.source,
    has_theme_file: t.has_theme_file,
    modified: t.modified,
    wp_id: t.wp_id,
    author: t.author_text ?? t.author,
  };
}

/** Keeps a diff readable: long values are summarised rather than dumped. */
function compactDiff(entries: DiffEntry[], limit: number) {
  const shorten = (v: unknown) => {
    if (v === undefined) return undefined;
    const s = JSON.stringify(v);
    return s && s.length > 300 ? `${s.slice(0, 300)}…` : v;
  };
  return entries.slice(0, limit).map((e) => ({ path: e.path, change: e.change, theme: shorten(e.base), current: shorten(e.value) }));
}


/**
 * Fetches a page on the configured site the same way get_page_html does: the
 * target must resolve onto the site, and each redirect hop is re-checked with
 * isSameSite so a page cannot bounce the request to another host.
 */
async function fetchSitePage(client: WordPressClient, url: string, previewToken?: string) {
  let start: URL;
  try {
    start = resolveSiteUrl(client.site.url, url);
  } catch (e: any) {
    throw e;
  }
  if (previewToken) start.searchParams.set("wpxmcp_preview", previewToken);
  const timeoutMs = client.site.timeoutMs ?? 60_000;
  let current = start;
  let hops = 0;
  let res: Response;
  try {
    for (;;) {
      res = await fetch(current, {
        headers: { "User-Agent": "wpxmcp/2.0 (accessibility check)", Accept: "text/html", ...(client.site.headers ?? {}) },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      const next = new URL(location, current);
      await res.body?.cancel().catch(() => undefined);
      if (!isSameSite(client.site.url, next)) {
        throw new Error(`${current} redirects to ${next}, which is not on the configured site, so it was not followed.`);
      }
      if (hops >= MAX_REDIRECTS) throw new Error(`Stopped after ${MAX_REDIRECTS} redirects from ${start} — the site is probably in a redirect loop.`);
      current = next;
      hops++;
    }
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new Error(`Fetching ${current} timed out after ${timeoutMs}ms.`);
    if (e instanceof Error && /redirect/.test(e.message)) throw e;
    throw new Error(`Could not fetch ${current}: ${e?.cause?.code ?? e?.message ?? String(e)}.`);
  }
  const body = await readCapped(res!, MAX_PAGE_BYTES);
  return { requested: start.toString(), finalUrl: current.toString(), status: res!.status, contentType: res!.headers.get("content-type"), ...body };
}

/** Picks one variation from the REST list by index, or by title (+ kind when titles repeat across full/colour/typography sets). */
export function pickVariation(variations: any[], selector: { index?: number; title?: string; kind?: string }): { index: number; variation: any } {
  if (selector.index !== undefined) {
    const v = variations[selector.index];
    if (!v) throw new Error(`There is no variation at index ${selector.index}; the theme has ${variations.length} (0–${variations.length - 1}). Run list_style_variations.`);
    return { index: selector.index, variation: v };
  }
  if (!selector.title) throw new Error("Name the variation with `title` (optionally with `kind`) or `index` — run list_style_variations to see them.");
  const want = selector.title.trim().toLowerCase();
  const matches = variations
    .map((variation, index) => ({ variation, index }))
    .filter(({ variation }) => String(variation.title ?? "").toLowerCase() === want || String(variation.slug ?? "").toLowerCase() === want)
    .filter(({ variation }) => !selector.kind || variationKind(variation) === selector.kind);
  if (matches.length === 0) {
    const titles = [...new Set(variations.map((v) => `${v.title} (${variationKind(v)})`))].join(", ");
    throw new Error(`No style variation titled "${selector.title}"${selector.kind ? ` of kind ${selector.kind}` : ""}. Available: ${titles}.`);
  }
  if (matches.length > 1) {
    throw new Error(`"${selector.title}" matches ${matches.length} variations (${matches.map((m) => `index ${m.index}: ${variationKind(m.variation)}`).join(", ")}). Pass kind or index to choose one.`);
  }
  return matches[0];
}

/** The user global-styles record a variation would produce. Partials merge into what is there; full variations replace it. */
export function proposeVariationStyles(current: { settings?: any; styles?: any }, variation: any, mode: "replace" | "merge") {
  const vSettings = variation?.settings ?? {};
  const vStyles = variation?.styles ?? {};
  if (mode === "replace") return { settings: vSettings, styles: vStyles };
  return {
    settings: deepMerge(current.settings ?? {}, vSettings) as Record<string, unknown>,
    styles: deepMerge(current.styles ?? {}, vStyles) as Record<string, unknown>,
  };
}

export function themeDevTools(ctx: ToolContext): Array<ToolSpec<any>> {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    defineTool({
      name: "diff_global_styles",
      title: "Diff global styles against theme.json",
      readOnly: true,
      description:
        "Show exactly what the Site Editor has overridden in a block theme: a JSON-path diff of the user's global-styles customisations against the theme's own theme.json values (palette entries are matched by slug), plus every template and template part whose source is \"custom\" — edited in the Site Editor and therefore no longer following the theme's files. Use it before editing theme.json (a user override silently wins over file changes) or before shipping a theme update.",
      schema: {
        site_id: siteIdSchema,
        include_unchanged: z.boolean().optional().default(false).describe("Also list user values that merely restate the theme's value — harmless, but they pin the value so later theme.json changes will not show through."),
        max_entries: z.number().int().min(1).max(2000).optional().default(300).describe("Cap on diff entries returned."),
      },
      handler: async ({ site_id, include_unchanged, max_entries }) => {
        const client = site(site_id);
        const theme = await activeTheme(client);
        const id = requireBlockTheme(theme, "diff_global_styles");
        const [base, user] = await Promise.all([baseStyles(client, theme.stylesheet), userStyles(client, id)]);

        const settingsDiff = jsonDiff(base.settings ?? {}, user.settings ?? {}, { includeUnchanged: include_unchanged, path: "settings" });
        const stylesDiff = jsonDiff(base.styles ?? {}, user.styles ?? {}, { includeUnchanged: include_unchanged, path: "styles" });
        const all = [...settingsDiff, ...stylesDiff];

        const customized: any[] = [];
        const templateErrors: string[] = [];
        for (const [kind, route] of [["template", "/wp/v2/templates"], ["template_part", "/wp/v2/template-parts"]] as const) {
          try {
            const res = await client.get<any[]>(route, { context: "edit", per_page: 100 });
            for (const t of res.data ?? []) if (t.source === "custom") customized.push(shapeTemplate(t, kind));
          } catch (e: any) {
            templateErrors.push(`${kind}s: ${e.message}`);
          }
        }
        customized.sort((a, b) => String(b.modified ?? "").localeCompare(String(a.modified ?? "")));

        const counts = { added: 0, changed: 0, unchanged: 0 } as Record<string, number>;
        for (const e of all) counts[e.change] = (counts[e.change] ?? 0) + 1;

        return ok({
          site: client.site.id,
          theme: theme.stylesheet,
          global_styles_id: Number(id),
          overrides: { total: all.length, ...counts, truncated: all.length > max_entries ? all.length - max_entries : undefined },
          diff: compactDiff(all, max_entries),
          customized_templates: customized.map((t) => ({
            ...t,
            note: t.has_theme_file === false ? "Created in the Site Editor — no theme file exists, so resetting would delete it." : "Diverges from the theme file; reset_template_customization reverts it.",
          })),
          template_lookup_errors: templateErrors.length ? templateErrors : undefined,
          undo: `Every global-styles save is kept as a revision: GET /wp/v2/global-styles/${id}/revisions (via rest_api).`,
        }, all.length === 0 && customized.length === 0
          ? "No Site Editor customisations: the site renders exactly what the theme's files define."
          : "`theme` is the theme.json value (with core defaults merged in), `current` the user override that wins over it.");
      },
    }),

    defineTool({
      name: "reset_template_customization",
      title: "Reset a customised template",
      destructive: true,
      description:
        "Revert a template or template part that was edited in the Site Editor back to the theme's file, by deleting the database copy (DELETE /wp/v2/templates/{id}?force=true). Only works on items whose source is \"custom\" — find them with diff_global_styles. Without confirm_token it is a dry run that shows what would be lost; if the item was created in the Site Editor and has no theme file, deleting removes it entirely, and the preview says so.",
      schema: {
        site_id: siteIdSchema,
        id: z.string().describe("Template id as \"theme//slug\", e.g. \"twentytwentyfive//single\"."),
        kind: z.enum(["template", "template_part"]).optional().default("template").describe("Whether the id names a template or a template part."),
        confirm_token: z.string().optional().describe("Token from this tool's dry-run preview. Omit to preview."),
      },
      handler: async ({ site_id, id, kind, confirm_token }) => {
        const client = site(site_id);
        client.assertWritable("reset_template_customization");
        const route = kind === "template" ? "/wp/v2/templates" : "/wp/v2/template-parts";
        const cleanId = routeId(id, "template id");
        let current: any;
        try {
          current = (await client.get<any>(`${route}/${cleanId}`, { context: "edit" })).data;
        } catch (e: any) {
          const other = kind === "template" ? "template_part" : "template";
          throw new Error(`Could not read ${kind} "${cleanId}": ${String(e.message).replace(/\.+$/, "")}. If it is a ${other.replace("_", " ")}, pass kind: "${other}". diff_global_styles lists customised items with their kind.`);
        }
        if (current.source !== "custom") {
          audit({ site: client.site.id, tool: "reset_template_customization", action: "reset", target: cleanId, outcome: "refused", detail: `source=${current.source}` });
          return ok({ reset: false, refused: true, id: cleanId, source: current.source },
            `Nothing to reset: "${cleanId}" has source "${current.source}", meaning it already renders straight from the theme's file. Only Site Editor customisations (source "custom") can be reverted.`);
        }

        const content = unwrap(current.content);
        const fingerprint = fingerprintOp(["reset_template", client.site.id, kind, cleanId, current.wp_id, current.modified]);
        const deletesEntirely = current.has_theme_file === false;

        if (!confirm_token) {
          const token = await issueConfirmation(client.site.id, `reset ${kind} ${cleanId}`, fingerprint);
          audit({ site: client.site.id, tool: "reset_template_customization", action: "reset", target: cleanId, outcome: "dry-run" });
          return ok({
            reset: false,
            dry_run: true,
            template: shapeTemplate(current, kind),
            outcome: deletesEntirely
              ? "DELETE — this item exists only in the database (no theme file), so it would be removed entirely and anything assigned to it falls back to the template hierarchy."
              : "REVERT — the database copy is deleted and the theme's file takes over again.",
            customized_content_chars: content.length,
            customized_content_preview: trimText(content, 1200),
            confirm_token: token,
          }, "Dry run — nothing changed. Save customized_content_preview (or get_template) if you might want the edit back: a template reset is not kept as a revision. Re-run with this confirm_token within 10 minutes to proceed.");
        }

        const check = await consumeConfirmation(confirm_token, fingerprint);
        if (!check.valid) return ok({ reset: false, refused: true, reason: check.reason }, "The confirmation was not accepted, so nothing changed.");

        await client.del(`${route}/${cleanId}`, { force: true });
        let after: any = null;
        try {
          after = (await client.get<any>(`${route}/${cleanId}`, { context: "edit" })).data;
        } catch {
          /* a Site Editor-only template is gone entirely */
        }
        audit({ site: client.site.id, tool: "reset_template_customization", action: deletesEntirely ? "delete" : "reset", target: cleanId, outcome: "ok" });
        return ok({
          reset: true,
          id: cleanId,
          kind,
          now: after ? { source: after.source, has_theme_file: after.has_theme_file } : "deleted (no theme file existed)",
        }, after?.source === "theme" ? "Reverted: the template renders from the theme's file again." : undefined);
      },
    }),

    defineTool({
      name: "list_style_variations",
      title: "List style variations",
      readOnly: true,
      description:
        "List the active block theme's style variations (styles/*.json, plus the colour-only and typography-only partials themes ship since WordPress 6.6) with each one's palette, font families and font sizes, so you can pick one without reading the JSON. Titles can repeat across kinds (a full \"Evening\" and a colour-only \"Evening\"), so each entry carries its index and kind.",
      schema: {
        site_id: siteIdSchema,
        kind: z.enum(["full", "color", "typography"]).optional().describe("Only list variations of this kind."),
      },
      handler: async ({ site_id, kind }) => {
        const client = site(site_id);
        const theme = await activeTheme(client);
        const id = requireBlockTheme(theme, "list_style_variations");
        const res = await client.get<any[]>(`/wp/v2/global-styles/themes/${themeStylesheet(theme.stylesheet)}/variations`, { context: "edit" });
        const variations = Array.isArray(res.data) ? res.data : [];
        const user = await userStyles(client, id).catch(() => null);

        const summaries = variations.map((v, i) => {
          const s = summarizeVariation(v, i);
          // A variation "looks applied" when every value it sets matches the user record.
          // Block style variation overrides are ignored: WordPress strips them from the user record on save.
          const pending = user
            ? jsonDiff({ settings: user.settings ?? {}, styles: user.styles ?? {} }, { settings: v.settings ?? {}, styles: v.styles ?? {} })
              .filter((e) => !/\.variations\[/.test(e.path)).length
            : null;
          return { ...s, looks_applied: pending === 0 ? true : undefined };
        }).filter((s) => !kind || s.kind === kind);

        return ok({
          site: client.site.id,
          theme: theme.stylesheet,
          count: summaries.length,
          variations: summaries,
        }, variations.length === 0
          ? "This theme ships no style variations (no styles/*.json files)."
          : "Apply one with apply_style_variation (title + kind, or index). It previews the change first.");
      },
    }),

    defineTool({
      name: "apply_style_variation",
      title: "Apply a style variation",
      destructive: true,
      description:
        "Apply one of the active theme's style variations to the site's global styles — what choosing it in Site Editor → Styles does. Without confirm_token it is a dry run showing the JSON-path diff between the current user styles and the result. A full variation replaces the user's global-styles customisations; a colour or typography partial is merged into them. The previous state is kept as a global-styles revision (GET /wp/v2/global-styles/{id}/revisions), which is how to undo.",
      schema: {
        site_id: siteIdSchema,
        title: z.string().optional().describe("Variation title or slug from list_style_variations, e.g. \"Evening\"."),
        kind: z.enum(["full", "color", "typography"]).optional().describe("Disambiguates a title shared by a full variation and a partial."),
        index: z.number().int().min(0).optional().describe("Variation index from list_style_variations — an alternative to title."),
        mode: z.enum(["auto", "replace", "merge"]).optional().default("auto").describe("auto: full variations replace the user styles, partials merge into them (Site Editor behaviour). replace: overwrite all user customisations. merge: deep-merge the variation over the current customisations."),
        confirm_token: z.string().optional().describe("Token from this tool's dry-run preview. Omit to preview."),
      },
      handler: async ({ site_id, title, kind, index, mode, confirm_token }) => {
        const client = site(site_id);
        client.assertWritable("apply_style_variation");
        const theme = await activeTheme(client);
        const id = requireBlockTheme(theme, "apply_style_variation");
        const res = await client.get<any[]>(`/wp/v2/global-styles/themes/${themeStylesheet(theme.stylesheet)}/variations`, { context: "edit" });
        const variations = Array.isArray(res.data) ? res.data : [];
        if (!variations.length) throw new Error(`The active theme "${theme.stylesheet}" ships no style variations.`);
        const picked = pickVariation(variations, { index, title, kind });
        const vKind = variationKind(picked.variation);
        const effectiveMode = mode === "auto" ? (vKind === "full" ? "replace" : "merge") : mode;

        const current = await userStyles(client, id);
        const currentState = { settings: current.settings ?? {}, styles: current.styles ?? {} };
        const proposed = proposeVariationStyles(currentState, picked.variation, effectiveMode);
        const diff = jsonDiff(currentState, proposed, { reportRemoved: true });
        const fingerprint = fingerprintOp(["apply_style_variation", client.site.id, id, picked.index, picked.variation.title, effectiveMode, fingerprintOp([currentState]), fingerprintOp([proposed])]);

        if (!confirm_token) {
          const token = diff.length ? await issueConfirmation(client.site.id, `apply variation ${picked.variation.title}`, fingerprint) : undefined;
          audit({ site: client.site.id, tool: "apply_style_variation", action: "apply", target: String(picked.variation.title), outcome: "dry-run" });
          return ok({
            applied: false,
            dry_run: true,
            variation: { index: picked.index, title: picked.variation.title, kind: vKind },
            mode: effectiveMode,
            global_styles_id: Number(id),
            change_count: diff.length,
            diff: diff.slice(0, 300).map((e) => ({ path: e.path, change: e.change, from: e.base, to: e.value })),
            diff_truncated: diff.length > 300 ? diff.length - 300 : undefined,
            confirm_token: token,
            undo: `GET /wp/v2/global-styles/${id}/revisions lists earlier states; restore one by POSTing its settings and styles back to /wp/v2/global-styles/${id}.`,
          }, diff.length
            ? `Dry run — nothing changed. ${effectiveMode === "replace" ? "Replace mode discards every current Site Editor style customisation (the \"removed\" entries). " : ""}Re-run with the same arguments and this confirm_token within 10 minutes to apply.`
            : "The site's global styles already match this variation, so there is nothing to apply.");
        }

        const check = await consumeConfirmation(confirm_token, fingerprint);
        if (!check.valid) return ok({ applied: false, refused: true, reason: check.reason }, "The confirmation was not accepted, so nothing changed. If the styles were edited since the preview, preview again.");

        const saved = await client.post<any>(`/wp/v2/global-styles/${id}`, { settings: proposed.settings, styles: proposed.styles });
        audit({ site: client.site.id, tool: "apply_style_variation", action: "apply", target: String(picked.variation.title), outcome: "ok", detail: `${vKind}/${effectiveMode}` });
        // WordPress filters what a user record may hold (e.g. per-block style-variation overrides), so report what it kept.
        const stored = await userStyles(client, id).catch(() => saved.data ?? {});
        const dropped = jsonDiff({ settings: stored.settings ?? {}, styles: stored.styles ?? {} }, proposed)
          .filter((e) => e.change === "added")
          .map((e) => e.path);
        let revisions: number | undefined;
        try {
          const rev = await client.get<any[]>(`/wp/v2/global-styles/${id}/revisions`, { per_page: 1 });
          revisions = rev.total ?? undefined;
        } catch { /* revisions are informational */ }
        return ok({
          applied: true,
          variation: { index: picked.index, title: picked.variation.title, kind: vKind },
          mode: effectiveMode,
          global_styles_id: Number(id),
          changes: diff.length,
          revision_count: revisions,
          saved_top_level: { settings: Object.keys(stored.settings ?? {}), styles: Object.keys(stored.styles ?? {}) },
          not_stored_by_wordpress: dropped.length ? { count: dropped.length, paths: dropped.slice(0, 50) } : undefined,
        }, `Applied.${dropped.length ? " WordPress declined to store some values (listed in not_stored_by_wordpress) — typically per-block style-variation overrides, which the theme's own section styles already provide." : ""} To undo, list GET /wp/v2/global-styles/${id}/revisions with rest_api and write the previous revision's settings/styles back with update_global_styles.`);
      },
    }),

    defineTool({
      name: "list_block_patterns",
      title: "List block patterns",
      readOnly: true,
      description:
        "List the block patterns registered on the site — from core, the active theme's patterns/ folder, plugins and the pattern directory — with their categories, filterable by category and search text. Use it to reuse an existing pattern's markup instead of hand-writing layout. Pattern content is omitted by default because it is large; set include_content for truncated markup.",
      schema: {
        site_id: siteIdSchema,
        category: z.string().optional().describe("Only patterns in this category slug, e.g. \"header\", \"call-to-action\", \"banner\"."),
        search: z.string().optional().describe("Case-insensitive match against the pattern name, title, description and keywords."),
        source: z.string().optional().describe("Only patterns from this source, e.g. \"theme\", \"core\", \"plugin\", \"pattern-directory/theme\"."),
        include_content: z.boolean().optional().default(false).describe("Include each pattern's block markup, truncated to content_max_chars."),
        content_max_chars: z.number().int().min(100).max(20000).optional().default(1500).describe("Truncation length per pattern when include_content is true."),
        limit: z.number().int().min(1).max(500).optional().default(100).describe("Maximum patterns to return."),
      },
      handler: async ({ site_id, category, search, source, include_content, content_max_chars, limit }) => {
        const client = site(site_id);
        const [patternsRes, categoriesRes] = await Promise.all([
          client.get<any[]>("/wp/v2/block-patterns/patterns"),
          client.get<any[]>("/wp/v2/block-patterns/categories").catch(() => ({ data: [] as any[] })),
        ]);
        const all = Array.isArray(patternsRes.data) ? patternsRes.data : [];
        const q = search?.trim().toLowerCase();
        const filtered = all.filter((p: any) => {
          if (category && !(p.categories ?? []).includes(category)) return false;
          if (source && p.source !== source) return false;
          if (q) {
            const hay = [p.name, p.title, p.description, ...(p.keywords ?? [])].join(" ").toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });

        const counts = new Map<string, number>();
        for (const p of all) for (const c of p.categories ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
        const categories = (Array.isArray(categoriesRes.data) ? categoriesRes.data : []).map((c: any) => ({
          name: c.name, label: c.label, pattern_count: counts.get(c.name) ?? 0,
        }));
        if (category && !categories.some((c) => c.name === category) && !counts.has(category)) {
          throw new Error(`No pattern category "${category}". Categories: ${categories.map((c) => c.name).join(", ")}.`);
        }

        return ok({
          site: client.site.id,
          total: all.length,
          matched: filtered.length,
          returned: Math.min(filtered.length, limit),
          categories,
          patterns: filtered.slice(0, limit).map((p: any) => ({
            name: p.name,
            title: p.title,
            description: p.description ? String(p.description).slice(0, 200) : undefined,
            categories: p.categories ?? [],
            keywords: p.keywords?.length ? p.keywords : undefined,
            source: p.source,
            block_types: p.block_types?.length ? p.block_types : undefined,
            template_types: p.template_types?.length ? p.template_types : undefined,
            post_types: p.post_types?.length ? p.post_types : undefined,
            inserter: p.inserter === false ? false : undefined,
            viewport_width: p.viewport_width || undefined,
            content_chars: typeof p.content === "string" ? p.content.length : undefined,
            content: include_content ? trimText(p.content ?? "", content_max_chars) : undefined,
          })),
        }, "Insert a pattern in markup with <!-- wp:pattern {\"slug\":\"<name>\"} /--> (it stays linked to the theme's file), or paste its content to detach it.");
      },
    }),

    defineTool({
      name: "validate_theme_json",
      title: "Validate theme.json",
      readOnly: true,
      description:
        "Lint a block theme's theme.json and its style variations: version, duplicate palette/font-size/spacing/shadow slugs, invalid colour values, font families whose fontFace has no src, customTemplates/templateParts naming templates that do not exist, deprecated v1 keys and blocks, and WCAG contrast of the text/background pairs the styles actually use (root, link, button, headings, blocks and block style variations — resolved through the palette). Returns {valid, errors[], warnings[]} with JSON paths. Checks the active theme by default; pass theme_json to lint a draft file's text before writing it. Reading the raw file (for version and deprecated keys) needs the companion plugin; without it the merged REST data is linted.",
      schema: {
        site_id: siteIdSchema,
        theme: z.string().optional().describe("Theme stylesheet (directory) whose theme.json to read, e.g. a draft theme id. Defaults to the active theme. Global-styles data and variations are only available for the active theme; other themes need the companion plugin."),
        theme_json: z.string().optional().describe("Raw theme.json text to lint instead of reading one from the site — useful before write_theme_file. Template names are still checked against the active theme."),
        include_variations: z.boolean().optional().default(true).describe("Also lint each style variation, including the contrast of its palette over the theme's styles."),
        include_user_styles: z.boolean().optional().default(true).describe("Also check contrast with the site's Site Editor customisations layered on top (active theme only)."),
      },
      handler: async ({ site_id, theme, theme_json, include_variations, include_user_styles }) => {
        const client = site(site_id);
        const errors: LintIssue[] = [];
        const warnings: LintIssue[] = [];
        const sources: string[] = [];
        const notes: string[] = [];
        const merge = (r: { errors: LintIssue[]; warnings: LintIssue[] }) => { errors.push(...r.errors); warnings.push(...r.warnings); };

        const active = await activeTheme(client);
        const target = theme ? themeStylesheet(theme) : active.stylesheet;
        const isActive = target === active.stylesheet;

        // Template slugs the theme can resolve, for customTemplates/templateParts checks.
        let templateSlugs: string[] | undefined;
        let templatePartSlugs: string[] | undefined;
        if (isActive && active.isBlockTheme) {
          try {
            const [t, p] = await Promise.all([
              client.get<any[]>("/wp/v2/templates", { context: "edit", per_page: 100 }),
              client.get<any[]>("/wp/v2/template-parts", { context: "edit", per_page: 100 }),
            ]);
            templateSlugs = (t.data ?? []).map((x: any) => x.slug);
            templatePartSlugs = (p.data ?? []).map((x: any) => x.slug);
          } catch (e: any) {
            notes.push(`Template existence was not checked: ${e.message}`);
          }
        }

        let raw: any = null;
        if (theme_json !== undefined) {
          const parsed = parseJsonText(theme_json);
          if (parsed.error) {
            return ok({ valid: false, errors: [{ path: "(root)", rule: "json-syntax", message: parsed.error }], warnings: [], sources: ["theme_json argument"] });
          }
          raw = parsed.value;
          sources.push("theme_json argument");
        } else if (await client.hasHelperPlugin()) {
          const ns = client.site.helperNamespace ?? "wpxmcp/v1";
          const candidates = [target];
          if (isActive && active.template && active.template !== active.stylesheet) candidates.push(active.template);
          for (const candidate of candidates) {
            try {
              const file = await client.get<any>(`/${ns}/themes/file`, { theme: candidate, path: "theme.json" });
              const parsed = parseJsonText(String(file.data?.content ?? ""));
              if (parsed.error) {
                errors.push({ path: `${candidate}/theme.json`, rule: "json-syntax", message: `theme.json does not parse, so WordPress ignores it entirely: ${parsed.error}` });
              } else raw = parsed.value;
              sources.push(`${candidate}/theme.json (file)`);
              if (candidate !== target) notes.push(`"${target}" has no theme.json of its own; linted the parent theme's.`);
              break;
            } catch {
              /* try the parent */
            }
          }
          if (!raw && !errors.length) notes.push(`No theme.json file could be read for "${target}".`);
        } else {
          notes.push("The companion plugin is not active, so the raw theme.json file could not be read: version, deprecated keys and the file's exact customTemplates/templateParts were not checked. The merged REST data was linted instead.");
        }

        let basePalette: Record<string, string> = {};
        let base: any = null;
        if (isActive && active.isBlockTheme && theme_json === undefined) {
          try {
            base = await baseStyles(client, target);
            sources.push(`/wp/v2/global-styles/themes/${target} (merged with core defaults)`);
            // Core's default palette is always emitted as CSS variables, so references to it resolve.
            basePalette = paletteMap({ default: base.settings?.color?.palette?.default });
          } catch (e: any) {
            notes.push(`Global styles could not be read: ${e.message}`);
          }
        }

        if (raw && base) {
          // Structure from the file; contrast from the merged data, which also holds section styles
          // registered from styles/blocks/*.json that the file alone does not show.
          merge(lintThemeJson(raw, { expectVersion: true, templateSlugs, templatePartSlugs, skipContrast: true }));
          merge(lintThemeJson({ styles: base.styles }, { basePalette: paletteMap(base.settings?.color?.palette) }));
        } else if (raw) {
          merge(lintThemeJson(raw, { expectVersion: true, templateSlugs, templatePartSlugs, basePalette }));
        } else if (base) {
          merge(lintThemeJson({ settings: base.settings, styles: base.styles }, { templateSlugs, templatePartSlugs }));
        } else if (!errors.length) {
          if (!isActive) throw new Error(`Could not read theme.json for "${target}". Non-active themes can only be read through the companion plugin (read_theme_file), or pass the file's text as theme_json.`);
          if (!active.isBlockTheme) {
            return ok({ valid: true, errors: [], warnings: [], sources, notes: [...notes, `"${target}" is a classic theme without theme.json support in use; nothing to lint.`] });
          }
        }

        const themePalette = base ? paletteMap(base.settings?.color?.palette) : paletteMap(raw?.settings?.color?.palette, { ...basePalette });
        const themeStyles = base?.styles ?? raw?.styles ?? {};

        if (include_user_styles && isActive && active.userStylesId && theme_json === undefined) {
          try {
            const user = await userStyles(client, active.userStylesId);
            if (Object.keys(user.styles ?? {}).length || Object.keys(user.settings ?? {}).length) {
              const effective = {
                settings: { color: { palette: paletteMap(user.settings?.color?.palette, { ...themePalette }) } },
                styles: deepMerge(themeStyles, user.styles ?? {}),
              };
              const palette = effective.settings.color.palette;
              const r = lintThemeJson({ styles: effective.styles }, { pathPrefix: "user_global_styles", basePalette: palette });
              // Only report contrast problems that the user layer introduces or keeps.
              merge({ errors: r.errors.filter((i) => i.rule === "color-contrast"), warnings: r.warnings.filter((i) => i.rule === "color-contrast") });
              sources.push(`/wp/v2/global-styles/${active.userStylesId} (Site Editor customisations)`);
            }
          } catch (e: any) {
            notes.push(`User global styles could not be checked: ${e.message}`);
          }
        }

        let variationCount = 0;
        if (include_variations && isActive && active.isBlockTheme && theme_json === undefined) {
          try {
            const res = await client.get<any[]>(`/wp/v2/global-styles/themes/${target}/variations`, { context: "edit" });
            const variations = Array.isArray(res.data) ? res.data : [];
            variationCount = variations.length;
            variations.forEach((v, i) => {
              const prefix = `variations[${i}:${JSON.stringify(`${v.title} (${variationKind(v)})`).slice(1, -1)}]`;
              const structural = lintThemeJson({ ...v, styles: undefined }, { pathPrefix: prefix, expectVersion: true, skipContrast: true });
              merge(structural);
              // Contrast as it would render: the variation's palette and styles over the theme's.
              const palette = paletteMap(v.settings?.color?.palette, { ...themePalette });
              const styles = deepMerge(themeStyles, v.styles ?? {});
              const contrast = lintThemeJson({ styles }, { pathPrefix: prefix, basePalette: palette });
              merge({ errors: contrast.errors, warnings: contrast.warnings });
            });
            if (variations.length) sources.push(`${variations.length} style variations`);
          } catch (e: any) {
            notes.push(`Style variations could not be read: ${e.message}`);
          }
        }

        // The same contrast pair can surface from the base, user and variation passes. A layered
        // pass only reports what differs from the theme's own result at the same styles path.
        const dedupe = (list: LintIssue[]) => {
          const seen = new Set<string>();
          return list.filter((i) => {
            const at = i.path.indexOf("styles");
            const key = `${i.rule === "color-contrast" && at >= 0 ? i.path.slice(at) : i.path}|${i.rule}|${i.message}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        };
        const finalErrors = dedupe(errors);
        const finalWarnings = dedupe(warnings);

        return ok({
          valid: finalErrors.length === 0,
          theme: target,
          error_count: finalErrors.length,
          warning_count: finalWarnings.length,
          errors: finalErrors.slice(0, 200),
          warnings: finalWarnings.slice(0, 200),
          variations_checked: variationCount || undefined,
          sources,
          notes: notes.length ? notes : undefined,
        }, finalErrors.length
          ? "Contrast below 3:1 is reported as an error (it fails even for large text); 3–4.5:1 as a warning."
          : undefined);
      },
    }),

    defineTool({
      name: "check_accessibility",
      title: "Check a page's accessibility",
      readOnly: true,
      description:
        "Fetch a page on the configured site and run deterministic accessibility checks on its server-rendered HTML: html lang, page title, a single h1 and no skipped heading levels, images without alt (alt=\"\" is treated as decorative), links and buttons with no accessible name, generic link text (\"read more\", \"click here\"), form controls without labels, duplicate ids, iframes without title, autoplaying media, a viewport that disables zoom, and WCAG contrast of block colour classes (has-{slug}-color / has-{slug}-background-color and inline colours) resolved against the theme palette. Each issue has a WCAG reference, severity, snippet and fix. Works on draft-theme preview URLs from get_preview_url. It does not run JavaScript or compute CSS, so it complements rather than replaces a browser audit.",
      schema: {
        site_id: siteIdSchema,
        url: z.string().optional().default("/").describe("Path or full same-site URL, e.g. \"/about/\", or a preview URL from get_preview_url (its query parameters are kept)."),
        preview_token: z.string().optional().describe("Token from get_preview_url, to check a draft theme when passing a plain path."),
        rules: z.array(z.enum(A11Y_RULES)).optional().describe("Only run these rules. Omit for all."),
        max_issues: z.number().int().min(1).max(1000).optional().default(100).describe("Cap on issues listed; counts always cover every issue found."),
      },
      handler: async ({ site_id, url, preview_token, rules, max_issues }) => {
        const client = site(site_id);
        const page = await fetchSitePage(client, url, preview_token);
        if (page.contentType && !/html/i.test(page.contentType)) {
          throw new Error(`${page.finalUrl} returned ${page.contentType}, not HTML.`);
        }

        // Fallback palette and root colours from global styles; the page's own CSS variables take precedence.
        let palette: Record<string, string> = {};
        let rootText: string | undefined;
        let rootBackground: string | undefined;
        try {
          const theme = await activeTheme(client);
          if (theme.isBlockTheme && theme.userStylesId) {
            const [base, user] = await Promise.all([baseStyles(client, theme.stylesheet), userStyles(client, theme.userStylesId).catch(() => ({}))]);
            palette = paletteMap((user as any).settings?.color?.palette, paletteMap(base.settings?.color?.palette));
            rootText = (user as any).styles?.color?.text ?? base.styles?.color?.text;
            rootBackground = (user as any).styles?.color?.background ?? base.styles?.color?.background;
          }
        } catch {
          /* the page's inline CSS usually carries the palette anyway */
        }

        const report = checkAccessibility(page.text, { palette, rootText, rootBackground, rules });
        const bySeverity: Record<string, number> = {};
        const byRule: Record<string, number> = {};
        for (const i of report.issues) {
          bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;
          byRule[i.rule] = (byRule[i.rule] ?? 0) + 1;
        }
        const order = { critical: 0, serious: 1, moderate: 2, minor: 3 } as const;
        const issues: A11yIssue[] = [...report.issues].sort((a, b) => order[a.severity] - order[b.severity]);

        return ok({
          url: page.requested,
          final_url: page.finalUrl,
          status: page.status,
          body_truncated_at_bytes: page.truncated ? MAX_PAGE_BYTES : undefined,
          issue_count: report.issues.length,
          counts: { by_severity: bySeverity, by_rule: byRule },
          issues: issues.slice(0, max_issues).map((i) => ({ rule: i.rule, wcag: i.wcag, severity: i.severity, message: i.message, snippet: i.snippet, fix: i.fix })),
          issues_truncated: issues.length > max_issues ? issues.length - max_issues : undefined,
          stats: { ...report.stats, headings: report.stats.headings.slice(0, 40) },
        }, page.status >= 400
          ? `The page returned HTTP ${page.status}; the checks ran on that response.`
          : report.issues.length === 0
            ? "No issues found by the static checks. Keyboard focus order, focus visibility, and JavaScript-rendered content still need a manual or browser-based check."
            : undefined);
      },
    }),
  ];
}
