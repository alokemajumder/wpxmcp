---
name: page-builders
title: Working with page builders
description: How to edit Elementor, Divi, Beaver Builder, Bricks, Breakdance and SeedProd content without corrupting the layout.
keywords: elementor, divi, beaver builder, bricks, breakdance, seedprod, kadence, page builder, wpbakery, oxygen, layout
---

## Read this before touching builder content

Page builders do **not** store layouts in `post_content`. They store a structured document in post meta, and `post_content` holds generated output that is regenerated from that meta. Editing `post_content` therefore either does nothing, or is silently overwritten the next time the builder saves.

**Check first.** Read the meta with `get_content_meta` and look for:

| Meta key | Builder |
| --- | --- |
| `_elementor_data`, `_elementor_edit_mode` | Elementor |
| `_et_pb_use_builder`, `_et_pb_old_content` | Divi |
| `_fl_builder_data`, `_fl_builder_enabled` | Beaver Builder |
| `_bricks_page_content_2` | Bricks |
| `_breakdance_data` | Breakdance |
| `_seedprod_page` | SeedProd |
| `_wpb_vc_js_status` | WPBakery |
| `ct_builder_shortcodes` | Oxygen |

If none are present, it is ordinary Gutenberg or classic content — load the `gutenberg` skill instead.

## The general rule

Write through the builder's own save path, never around it. In order of preference:

1. **An ability** — `discover_abilities`, then `run_ability`. The plugin's own validation and cache invalidation run.
2. **The plugin's REST namespace** — `discover_rest_routes` with the builder's namespace. Never guess a route.
3. **WP-CLI** — `run_wp_cli`, if the builder registers commands.
4. **Meta writes plus a cache flush** — the last resort, described below.

## Editing the structured document

When you must write meta directly:

1. `get_content_meta` with `include_protected: true` to read the current document.
2. Parse it. Elementor's `_elementor_data` is a JSON string of nested element objects; Beaver Builder's is a serialised PHP object; Bricks stores JSON.
3. Change **only** the value you are targeting, leaving every id, `elType`, `widgetType` and settings key intact. Builders key off element ids — invent one and the element disappears from the editor.
4. Write it back with `set_content_meta`.
5. **Flush the builder's CSS cache.** This is the step people forget, and it is why the change "doesn't show":
   - Elementor: `run_wp_cli "option delete elementor_css_print_method"` then regenerate, or delete the `_elementor_css` meta on that post.
   - Divi: `run_wp_cli "option delete et_pb_static_css_file"`, or clear `wp-content/et-cache`.
   - Beaver Builder / Bricks / Breakdance: each keeps a per-post cached CSS file; clearing the post's builder cache meta forces a rebuild.
6. Verify with `get_page_html` that the front end actually changed.

## Kadence and GeneratePress

These are *not* in the above category. Kadence Blocks content is real Gutenberg markup — use the `gutenberg` skill, and set global colors through `update_global_styles`. GeneratePress Elements are a custom post type (`gp_elements`) you can manage with the normal content tools.

## Safest path of all

For a new page, do not fight the builder: build it as a classic template or clean Gutenberg content instead, unless the client specifically needs to keep editing it in that builder. If they do, and no ability or REST route exists, say so plainly rather than writing meta blind.
