---
name: site-down
title: Site down or locked out (incident response)
description: Use when the site is down or unusable — "There has been a critical error", white screen, HTTP 500, stuck "Briefly unavailable for scheduled maintenance", or the owner is locked out of wp-admin.
keywords: site down, website down, critical error, there has been a critical error, white screen, white screen of death, blank page, 500, 500 error, internal server error, fatal error, crashed, site crashed, not loading, maintenance mode, briefly unavailable, stuck in maintenance, locked out, cannot log in, can't log in, wp-admin not working, after update broke
---

## When this applies

Visitors or admins get an error page instead of the site. Wrong content or changes not showing: `troubleshooting`. Suspected hack: `security-hardening` after the site is back.

## Rules

1. Diagnose before changing: logs and recent changes first. One change at a time, each verified.
2. Deactivate, never delete. Deactivation keeps settings and data; deletion can drop a plugin's tables.
3. Record every change you make (plugin deactivated, theme switched) so it can be reversed and reported.
4. If REST itself fails (every tool errors, `test_site` cannot reach the API), the fix needs server access. Stop and hand over the steps below; do not guess.
5. Do not turn on `WP_DEBUG_DISPLAY` on a live site; the log already has the error.
6. Leave the owner's security plugins, 2FA and passwords alone unless they ask; offer the least invasive fix.

## Procedure

1. `test_site`: is REST reachable and authenticating? Then `get_page_html` with `url: "/"` and `mode: "summary"` for the visitor-facing status. A 503 with "Briefly unavailable" is maintenance mode (step 8).
2. `tail_error_log` with `level: "error"` and `lines: 500` (companion plugin). Read `last_fatal` (recorded even when logging is off), `by_source` and the newest `groups`: the file path names the plugin or theme.
3. Recent changes: `get_audit_log` with `limit: 20` (what this server did), `site_info` (versions, pending updates, PHP version; a host PHP upgrade often breaks old plugins).
4. Suspect is a plugin: `deactivate_plugin` with `plugin: "{folder}/{file without .php}"` (from `list_plugins` with `status: "active"`). Re-check with `get_page_html`.
5. Suspect is the theme: `list_themes`, then `activate_theme` with `stylesheet: "twentytwentyfive"` (or another installed default) and `confirm: true`. Warn first: classic-theme widgets and menus may need reassigning afterwards.
6. A settings change broke it (`get_audit_log` shows `update_plugin_settings`): `restore_plugin_settings` with `option`.
7. No clear source: deactivate recently updated plugins one at a time, checking after each, and reactivate the innocent ones.
8. Maintenance mode: `run_wp_cli` with `command: "maintenance-mode status"`. Core's `.maintenance` expires by itself after 10 minutes and blocks REST while active, so wait and retry, then `run_wp_cli` with `command: "maintenance-mode deactivate"`. If it persists, look for an active coming-soon/maintenance plugin (`list_plugins` with `search: "maintenance"`) or a page cache serving the old 503 (`purge_cache`).
9. Locked out while REST still works: wrong password → `update_user` with `id` and `password` (ends their sessions; share it privately). Lost administrator role → `update_user` with `id` and `roles: ["administrator"]` after confirming identity with the owner. Lockout or 2FA plugin blocking login → with consent, `deactivate_plugin` with that plugin, let them log in, reactivate.
10. Once the site loads: `purge_cache` with `scope: "all"` so cached error pages are cleared.

When REST is down, give the owner or host these steps: check the recovery-mode email WordPress sends to the admin address (its link opens wp-admin with the faulty plugin paused); via SFTP or the file manager, rename `wp-content/plugins/{slug}` to deactivate it; check the host's PHP error log; raise `WP_MEMORY_LIMIT` in wp-config.php for "Allowed memory size exhausted"; restore `.htaccess` to the WordPress default for 500s after a rewrite change.

## Verify

- `get_page_html` with `url: "/"` returns 200 for the homepage and one inner page; wp-admin login works for the owner.
- `tail_error_log` with `since` set to the fix time and `level: "error"` shows no new fatals.

## Report back

What broke (with the log line), what you changed (plugin deactivated, theme switched), what is now disabled for visitors because of it, and the permanent fix (update, replace, or contact the plugin author). Recommend a backup check with `backup_status` before re-enabling anything.
