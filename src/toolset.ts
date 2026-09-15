import type { ToolContext, ToolSpec } from "./lib/tooling.js";

import { siteTools } from "./tools/sites.js";
import { contentTools } from "./tools/content.js";
import { taxonomyTools } from "./tools/taxonomy.js";
import { mediaTools } from "./tools/media.js";
import { userTools } from "./tools/users.js";
import { commentTools } from "./tools/comments.js";
import { pluginTools } from "./tools/plugins.js";
import { themeTools } from "./tools/themes.js";
import { appearanceTools } from "./tools/appearance.js";
import { siteConfigTools } from "./tools/site.js";
import { powerTools } from "./tools/power.js";
import { bulkTools } from "./tools/bulk.js";
import { skillTools } from "./tools/skills.js";
import { opsTools } from "./tools/ops.js";
import { devTools } from "./tools/devtools.js";
import { profilerTools } from "./tools/profiler.js";
import { themeDevTools } from "./tools/themedev.js";
import { growthTools } from "./tools/growth.js";
import { pluginControlTools } from "./tools/plugin-control.js";

export const VERSION = "2.0.0";

export const INSTRUCTIONS = `wpxmcp manages self-hosted WordPress sites over the REST API.

Start of every substantive task:
  1. load_skill with a description of what you are about to do. Playbooks cover publishing,
     Gutenberg markup, page builders, themes and design, theme.json, SEO, accessibility,
     WooCommerce, plugin settings, launch and migration, site-down incidents, troubleshooting,
     security, performance, developer introspection and fleet maintenance. Page-builder content
     (Elementor, Divi, Beaver Builder, Bricks, Breakdance) lives in builder-specific storage —
     editing it as ordinary HTML corrupts the layout, so load that skill before touching it.
  2. With several sites configured, pass site_id. list_sites shows the ids.

Finding things:
  - find_content_by_url resolves any front-end URL to the content behind it. Use it whenever
    a person hands you a link.
  - discover_content_types / discover_taxonomies before assuming a type exists.
  - discover_rest_routes before calling rest_api. Never invent a route.
  - inspect_plugin shows how to control an installed plugin: its REST routes, abilities,
    settings and admin screens.

Editing:
  - Read before you write. update_content's \`edits\` applies targeted find/replace; an edit
    matching nothing fails loudly.
  - New content is a draft unless you pass status: "publish". Deletes go to the trash.
  - Destructive and bulk operations preview first and return a confirm_token to echo back.

Themes: never edit a live theme. create_draft_theme → edit files → get_preview_url →
publish_draft_theme. diff_global_styles and validate_theme_json before and after design work.

Diagnosing: tail_error_log for errors, profile_url for slow or wrong pages (queries, template,
assets), security_audit for exposure, backup_status before anything risky.

Verification: get_page_html fetches what a visitor actually receives — the only proof a change
reached the front end. If it has not, purge_cache and check again.

Tools for SQL, WP-CLI, theme files, logs, cache, profiling, plugin settings and admin screens
need the wpxmcp companion plugin. test_site reports whether it is installed.`;

/**
 * The complete toolset, shared by the stdio and Workers entry points so the two
 * deployments can never drift apart.
 */
export function buildToolset(ctx: ToolContext): Array<ToolSpec<any>> {
  const tools = [
    ...siteTools(ctx),
    ...contentTools(ctx),
    ...taxonomyTools(ctx),
    ...mediaTools(ctx),
    ...userTools(ctx),
    ...commentTools(ctx),
    ...pluginTools(ctx),
    ...themeTools(ctx),
    ...appearanceTools(ctx),
    ...siteConfigTools(ctx),
    ...powerTools(ctx),
    ...bulkTools(ctx),
    ...skillTools(ctx),
    ...opsTools(ctx),
    ...devTools(ctx),
    ...profilerTools(ctx),
    ...themeDevTools(ctx),
    ...growthTools(ctx),
    ...pluginControlTools(ctx),
  ];

  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
  }
  return tools;
}
