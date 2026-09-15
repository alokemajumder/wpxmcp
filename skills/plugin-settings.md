---
name: plugin-settings
title: Operating plugin settings as an administrator
description: Use when changing or reading the configuration of an installed plugin (Yoast, Rank Math, WooCommerce, forms, caching) that lives on its wp-admin screens or in its options — discover how to control it, then change it through its REST route, its option, or its settings form.
keywords: plugin settings, plugin options, wp-admin, admin screen, settings page, settings form, yoast, rank math, aioseo, seo plugin, woocommerce settings, configure plugin, change plugin setting, options.php, admin menu, submit form, inspect plugin
---

## When this applies

The user asks for something set in a plugin: "change the Yoast title separator", "turn off Rank Math's sitemap", "what does this plugin let me configure", "find the WooCommerce tax screen". Needs the companion plugin and an administrator (a super admin on multisite). Installing, activating or updating plugins belongs to the plugin tools, not here.

## Rules

1. Start with `inspect_plugin`, and follow its `control_surface` order: an ability (`run_ability`), then the plugin's REST route (`discover_rest_routes`, `rest_api`), then its option (`update_plugin_settings`), then its wp-admin form (`submit_admin_form`).
2. Read before writing. Every write previews first. Show the user the diff and apply with the `confirm_token`.
3. Never hand-build an `options.php` POST. `options.php` blanks every option of the page's group that it is not sent. `submit_admin_form` resubmits the full field set.
   - Before posting, it compares the form against the group's registered options and refuses if any would be wiped (`would_wipe`). It also refuses if fewer controls were parsed than the HTML contains.
   - Do not pass `force_incomplete_form: true` unless a human has checked the form. It can wipe settings.
4. A setting with `registered_in: "wp-admin only"` may have no sanitizer during a REST write. If `sanitize_filter_ran` comes back false, re-save through the plugin's screen or undo.
5. Leave secrets masked. Use `reveal: true` or `allow_sensitive: true` only when the user explicitly needs that value changed.
6. Refusals are deliberate: protected options, off-site forms, file uploads, and the plugin, theme, user, export and update screens. Use the dedicated tools; do not work around them.

## Procedure

1. `inspect_plugin` with `plugin` (slug, `dir/file.php`, or name). Note `rest.routes`, `abilities`, `registered_settings`, `options`, `admin_pages`.
2. Find the screen: `list_admin_pages` with `plugin`.
3. See it as the admin: `admin_page` with `url_or_page`, for example `admin.php?page=wpseo_titles`. You get notices, links and forms with labels, values and options.
   - If a plugin screen returns no forms, it is built in JavaScript (Yoast and Rank Math are). Those screens save through the plugin's REST routes or its option, so use those.
4. Option path:
   1. `get_plugin_settings` with `plugin` lists its options. Add `option` to read one.
   2. `update_plugin_settings` with `plugin`, `option` and `changes` (deep-merge), or `value` (replace).
   3. Repeat with `confirm_token`.
5. Form path:
   1. `submit_admin_form` with `page`, `form_index` or `form_id`, and `changes`. Checkboxes take true/false; selects and radios take an option value.
   2. Repeat with `confirm_token`. The page is re-fetched for a fresh nonce, and the submit is refused if the form's other values changed since the preview.
6. To undo an option write: `restore_plugin_settings` with `option` (last five kept, optional `backup_index`).

## Verify

- Option writes:
  - `value_after_sanitize` holds what was stored.
  - A path listed in `sanitizer_adjusted` means the plugin rejected or normalised that value.
- Form submits:
  - `notices` should contain "Settings saved." (or the plugin's equivalent).
  - `values_after_save` shows your fields read back from the reloaded screen.
  - Any `collateral_changes` means fields you did not touch now differ. Investigate before moving on.
- For front-end effects (titles, meta, sitemaps), check the page with `get_page_html` in `head` mode.

## Report back

- Which plugin and setting you changed, and the path you used (REST, option or form).
- Before → after, and anything the plugin's sanitizer adjusted.
- The undo: `restore_plugin_settings` for an option, or the previous value for a form field.
- Anything refused, and the dedicated tool to use instead.

## Reference: how admin requests are authenticated

The companion plugin issues a random, single-use token. It lasts 120 seconds and is bound to one wp-admin path, query and method. A wp-admin request carrying the token runs as that administrator for that request only:

- No cookie is returned, and no Application Password is sent to wp-admin.
- The in-request session is destroyed at shutdown.
- Requests without a valid token behave exactly as before.

A read-only site refuses every write. Tokens issued, admin requests and settings writes are all recorded in the site's audit log.
