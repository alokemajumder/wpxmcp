---
name: wp-developer
title: Developer introspection and database hygiene
description: Use for developer questions about a running site — which plugin adds a hook, post type, REST route, shortcode or cron event — and for autoloaded options, transients, database bloat and guarded cleanup.
keywords: developer, introspection, hook, hooks, add_action, add_filter, save_post, the_content, which plugin, who registered, where does this come from, post type, custom post type, register_post_type, taxonomy, register_meta, shortcode, rest route, rest routes, public endpoint, permission_callback, cron, wp-cron, cron events, autoload, autoloaded options, alloptions, transients, options table, database size, table sizes, orphaned tables, orphaned postmeta, revisions, capabilities, image sizes
---

## When this applies

"Where does this behavior come from?", auditing what plugins register, or reducing options/database weight. Needs the companion plugin. Page-level query and timing questions: `performance`.

## Rules

1. `inspect_registry`, `inspect_options` and `inspect_database` are read-only and safe on production. `cleanup_options` writes: preview, show the owner, then confirm.
2. Owners are inferred from names and file paths: say "appears to belong to", not "belongs to".
3. Registry data reflects a REST request. Callbacks added only on admin screens, `wp_enqueue_scripts` or inside templates do not appear; use `profile_url` with `sections: ["hooks"]` for a real page.
4. Prefer `set_autoload_off` over `delete_options`; deleting an option a plugin still uses resets that plugin.
5. No tool drops tables or deletes orphaned rows. That is `execute_sql_query` territory (preview plus `confirm_token`), only after a backup and explicit approval, and never where a WordPress API path exists.
6. Do not edit plugin code on a live site; report findings.

## Procedure

1. Hooks: `inspect_registry` with `kind: "hooks"` lists the busiest hooks; with `filter: "save_post"` (an exact hook name) every callback with priority, `file:line` and owner. A partial name lists matching hook names instead. Closures appear as `{closure}` with file and line.
2. Content model: `inspect_registry` with `kind: "post_types"` or `kind: "taxonomies"` lists everything, including types with `show_in_rest` false (why "the API doesn't show my events"). `kind: "meta"` splits registered keys from frequent unregistered ones (underscore keys only when `filter` starts with `_`). `kind: "blocks"` shows dynamic blocks and `block.json` sources.
3. REST exposure: `inspect_registry` with `kind: "rest_routes"` and `filter: "{namespace}"`. `permission: "public"` (`__return_true`) and `permission: "missing"` routes are callable by anyone: read the callback at its `file:line` and report what they expose or change.
4. Other registries: `kind: "shortcodes"`, `kind: "cron"` (overdue = more than a minute late; orphan = no callback during REST, often a removed plugin), `kind: "image_sizes"`, `kind: "capabilities"` (role caps added/removed vs a fresh install), `kind: "scripts_styles"`, `kind: "menus_locations"`, `kind: "sidebars"`.
5. Options: `inspect_options` — autoload total vs 800 KB, largest autoloaded options with owner, owners inactive or not installed, transient counts, expired and orphaned timeout rows.
6. Cleanup: `cleanup_options` with `action: "delete_expired_transients"`, or `action: "set_autoload_off"` / `action: "delete_options"` with `names`; the dry run returns changes, bytes saved, refusals and a `confirm_token`; repeat the identical call with it. The token is bound to the preview: if an option changed meanwhile, preview again. Core, lock-out and wpxmcp options are refused.
7. Database: `inspect_database` — table sizes and owners, `possible_orphan_tables`, `orphaned_rows`, revisions per type, auto-drafts, trash and spam, `charset_issues` (non-utf8mb4). On SQLite, sizes and overhead are unavailable.
8. After cleanup: `purge_cache` with `scope: "all"` (clears the object cache too).

## Verify

Re-run `inspect_options` or `inspect_database` and compare totals; `get_page_html` with `url: "/"` still renders and `tail_error_log` with `since` set to the change time shows no new errors.

## Report back

Answer the question with evidence (`file:line`, owner, priority). For cleanup: bytes saved, what was changed, what was refused and why, and candidates left for a human decision (orphan tables, revision limits via `WP_POST_REVISIONS` in wp-config.php, `OPTIMIZE TABLE` off-peak on MySQL).
