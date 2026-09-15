---
name: page-builders
title: Editing page-builder content
description: Use before changing any page built with Elementor, Divi, Beaver Builder, Bricks, Breakdance, Oxygen, WPBakery or SeedProd, where the layout is not ordinary block content.
keywords: elementor, divi, divi 5, beaver builder, bricks, breakdance, oxygen, wpbakery, visual composer, seedprod, page builder, builder, theme builder, builder template, elementor kit, landing page, elementor page, divi page
---

## When this applies

The page was built in a visual builder, or `get_content_meta` returns a `builder_hint`. Kadence Blocks, GenerateBlocks, Spectra and Stackable are real Gutenberg blocks: use `gutenberg`.

## Rules

1. Identify the builder before writing anything. Where the layout lives differs per builder (table below); editing the wrong place does nothing or is overwritten on the next builder save.
2. Write through the builder's own path first: an ability (`discover_abilities`), then its REST namespace (`discover_rest_routes`), then direct edits. Never invent a route.
3. Meta writes are not revisioned. Before `set_content_meta`, keep the exact original value so it can be written back.
4. Change only the target value. Keep every element id, type, `elType`/`widgetType`/`name` and settings key; builders drop elements they cannot match.
5. Elementor's `_elementor_data` must be written back as a JSON **string**. Passing an object stores a PHP array and breaks the page.
6. Do not write `_fl_builder_data` (Beaver Builder), Oxygen classic shortcodes or SeedProd layouts through tools: the round trip loses PHP object types, invalidates Oxygen's shortcode signatures, or targets a column core REST cannot reach. Tell the owner to make that edit in the builder.
7. Never replace `post_content` of an Elementor, Beaver Builder, Bricks or Breakdance page; it is generated output.

## Procedure

1. `get_content_meta` with `id` and `include_protected: true`. Match the keys against the table. Values over 20,000 characters are truncated; request them by name with `keys: ["_elementor_data"]`.
2. `discover_abilities` with `search: "{builder name}"`; if one edits content, `get_ability_info` then `run_ability`. Otherwise `discover_rest_routes` with `search: "{builder slug}"`.
3. Edit by storage type:
   - **Shortcodes or block comments in `post_content`** (Divi 4, Divi 5, WPBakery): `get_content` with `id`, then `update_content` with `edits`, matching text inside the shortcode or JSON and leaving attributes untouched. In Divi 5 JSON, text is often HTML-escaped (`<` for `<`): match it exactly as stored.
   - **JSON/array in meta** (Elementor, Bricks, Breakdance): parse, change the one value, re-encode, then `set_content_meta` with `id` and `meta`. For Breakdance, `tree_json_string` is JSON inside JSON: decode and re-encode both levels.
4. Clear the builder's generated CSS so the front end rebuilds it:
   - Elementor: in the same `set_content_meta` call pass `"_elementor_css": null` and `"_elementor_element_cache": null` (null deletes the key; both regenerate on the next view).
   - Divi, Beaver Builder, Bricks (external CSS files mode), Breakdance: no tool clears their CSS files. Saving through WordPress usually regenerates Divi's; otherwise ask the owner to use the builder's "clear/regenerate CSS" setting.
5. `purge_cache` with `scope: "url"` and `url: "{page path}"`.

Global styles live elsewhere: Elementor's global colors and fonts are the Kit, a post whose id is in the `elementor_active_kit` option (`get_options` with `names: ["elementor_active_kit"]`), stored in its `_elementor_page_settings` meta. Theme-builder headers, footers and templates are posts of their own type (Elementor `elementor_library`, Divi `et_header_layout`/`et_body_layout`/`et_footer_layout`, Bricks `bricks_template`, Breakdance `breakdance_header`/`breakdance_footer`/`breakdance_template`); find them with `inspect_registry` with `kind: "post_types"` and `filter: "{builder}"`.

## Verify

- `get_page_html` with `url` and `mode: "text"` shows the new wording; `mode: "html"` shows styling classes.
- If the page is unchanged, read `verification` in the `purge_cache` result (a `hit` means a CDN still holds the old copy), then confirm the meta write with `get_content_meta` with `keys`.

## Report back

Name the builder, what changed, and where (meta key or content). State that meta edits have no revision history, and list any step the owner must do in the builder (CSS regeneration, Beaver Builder or Oxygen edits).

## Reference: where each builder keeps the layout

| Builder | Detect (meta) | Layout lives in |
| --- | --- | --- |
| Elementor | `_elementor_edit_mode` = `builder`, `_elementor_data` | `_elementor_data`: JSON string of nested elements (`id`, `elType`, `widgetType`, `settings`, `elements`) |
| Divi 4 | `_et_pb_use_builder` = `on` | `post_content` shortcodes `[et_pb_section]…`; `_et_pb_old_content` is only the pre-Divi backup |
| Divi 5 | `_et_pb_use_builder` = `on`, content starts with `<!-- wp:divi/` | `post_content` block comments in the `divi/` namespace, settings in the comment JSON |
| Beaver Builder | `_fl_builder_enabled` = `1` | `_fl_builder_data` (published) and `_fl_builder_draft`: serialized PHP objects |
| Bricks | `_bricks_editor_mode` = `bricks` | `_bricks_page_content_2`: array of elements (`id`, `name`, `parent`, `children`, `settings`) |
| Breakdance | `_breakdance_data` | JSON with a nested `tree_json_string` |
| Oxygen classic | `ct_builder_shortcodes` or `ct_builder_json` | Those keys; shortcodes are signed |
| WPBakery | `_wpb_vc_js_status` = `true` | `post_content` shortcodes `[vc_row]…`; design CSS in `_wpb_shortcodes_custom_css` |
| SeedProd | `_seedprod_page` | JSON in `post_content_filtered` (not in core REST) |
