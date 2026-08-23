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

export const VERSION = "1.0.0";

export const INSTRUCTIONS = `wpxmcp manages self-hosted WordPress sites over the REST API.

Start of every substantive task:
  1. load_skill with a description of what you are about to do. Playbooks cover Gutenberg
     markup, classic themes, page builders, SEO audits, editable fields and troubleshooting.
     Page-builder content (Elementor, Divi, Beaver Builder, Bricks, Breakdance) is stored in
     builder-specific meta — editing it as ordinary HTML corrupts the layout, so load that
     skill before touching such a post.
  2. With several sites configured, pass site_id. list_sites shows the ids; with one site it
     is optional.

Finding things:
  - find_content_by_url resolves any front-end URL to the content behind it, detecting custom
    post types from the URL shape. Reach for it whenever a human hands you a link.
  - discover_content_types / discover_taxonomies before assuming a type exists.
  - discover_rest_routes before calling rest_api. Never invent a route.

Editing:
  - Read content before editing it. update_content's \`edits\` applies targeted find/replace so
    a small change does not risk the rest of the document; an edit matching nothing fails loudly.
  - New content is created as a draft unless you explicitly pass status: "publish".
  - Deletes go to the trash unless force and confirm are both set.
  - Destructive and bulk operations preview first and return a confirm_token you must echo back.

Themes: never edit a live theme. create_draft_theme → write/edit files → get_preview_url →
publish_draft_theme, which backs up the previous theme automatically.

Verification: get_page_html fetches what a visitor actually receives, which is the only way to
confirm a change reached the front end. Caching layers are the usual reason it has not.

Some tools (SQL, WP-CLI, theme files, unregistered meta, options, theme mods, site health,
editable fields) need the wpxmcp companion plugin. test_site reports whether it is installed.`;

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
  ];

  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
  }
  return tools;
}
