---
name: troubleshooting
title: Diagnosing WordPress problems
description: A systematic approach to REST failures, changes that do not appear, and broken sites.
keywords: error, debug, broken, not working, 500, white screen, fatal, cache, troubleshoot, fix, failing, down, slow, wrong, not showing
---

## Start here

`test_site` first, always. It separates "cannot reach the site", "cannot authenticate", "authenticated but under-privileged" and "the companion plugin is missing" — four problems with four different fixes that all look identical from a failed tool call.

Then `site_info` for versions, active plugins, and health checks.

## "I changed it but the site looks the same"

In order of likelihood:

1. **A caching layer.** Page cache (WP Rocket, LiteSpeed, WP Super Cache), object cache (Redis, Memcached), a host-level cache, or Cloudflare. Try `run_wp_cli "cache flush"`, and check `get_page_html` against the live URL rather than trusting the API response.
2. **You edited the wrong thing.** A page builder owns the content (see the `page-builders` skill), or a child theme is overriding the template you changed.
3. **The write silently no-opped.** A meta key not registered with `show_in_rest` is discarded by core REST without an error — use `set_content_meta`.
4. **You are looking at a different post.** `find_content_by_url` resolves the URL to the actual id.

## REST failures

| Response | Meaning |
| --- | --- |
| `rest_no_route` | The route does not exist. Run `discover_rest_routes` — do not guess routes. |
| `rest_cannot_edit` / `rest_forbidden` | The role is too low, or a security plugin is blocking writes. |
| `rest_cookie_invalid_nonce` | The `Authorization` header was stripped. See the `site-setup` skill. |
| HTML instead of JSON | A WAF or security plugin is serving a challenge page. |
| 500 | A PHP fatal. Check the error log; it is almost always a plugin or theme. |

## After a fatal error

1. `list_plugins` — what is active.
2. Deactivate the most recently updated plugin, check, repeat. `deactivate_plugin` works even when wp-admin does not, as long as REST responds.
3. If REST is down entirely, the site needs filesystem or database access — say so rather than guessing.
4. `run_wp_cli "core verify-checksums"` detects modified core files, which usually means a compromise.

## Before large changes

- Work on staging where one exists. Mark production `"writable": false` in the site config while you experiment.
- Every destructive tool previews first and requires a confirmation token. Read the preview — it exists so that a wrong filter is caught before 400 posts change.
- `get_audit_log` shows exactly what this server has changed, with timestamps.

## Undo

| Mistake | Recovery |
| --- | --- |
| Bad content edit | `list_revisions` → `restore_revision` |
| Trashed content | `update_content` with `status: "draft"` |
| Bad theme publish | `activate_theme` back to the automatic backup |
| Bad bulk update | No automatic undo — which is why it previews first |
| Permanently deleted anything | Restore from a backup. There is nothing else. |
