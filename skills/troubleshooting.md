---
name: troubleshooting
title: Diagnosing problems and failed changes
description: Use when something is wrong but the site is up — a change is not showing, a tool call or REST request fails, the wrong page changed, scheduled posts did not publish — or a mistake needs undoing.
keywords: troubleshoot, troubleshooting, debug, broken, not working, not showing, changes not showing, still shows old, cache, caching, wrong page, error, rest error, rest_no_route, 401, 403, forbidden, failed, missed schedule, cron, undo, revert, mistake, something wrong
---

## When this applies

The site loads, but results are not what was expected. Error pages, white screens, 500s or lockouts: `site-down`. Slowness: `performance`.

## Rules

1. `test_site` first when any tool fails: it separates unreachable, unauthenticated, under-privileged and missing companion plugin.
2. Trust the front end, not the API response: confirm with `get_page_html`.
3. Find the cause before repeating a write. Re-sending the same change rarely fixes a cache or ownership problem and can duplicate content.
4. Never invent REST routes; `discover_rest_routes` shows what exists.
5. Undo with the narrowest tool (revision, status change, rollback theme) before reaching for backups.

## Procedure

**A change does not appear**
1. `find_content_by_url` with `url`: confirm you edited the item that renders there (id and type).
2. `purge_cache` with `scope: "url"` and `url`. Read `verification`: `hit` after purging means a CDN or host cache WordPress cannot reach; ask the owner to purge it there.
3. `get_content_meta` with `id`: a `builder_hint` means a page builder owns the layout (`page-builders`).
4. `get_template_for_url` with `url`: which template renders it, whether a child theme file wins, and whether a block template or part is `customized_in_database` (then the theme file is ignored; `diff_global_styles` lists all overrides).
5. Meta written through `update_content` `meta` is dropped silently when the key is not registered with `show_in_rest`; use `set_content_meta`.
6. Text inside a template part, widget or menu is not in the post: `get_template` with `kind: "template_part"`, `list_widgets`, `get_menu`.

**A tool or REST call fails**

| Response | Meaning | Next step |
| --- | --- | --- |
| `rest_no_route` | Route not registered (plugin inactive, wrong namespace, REST disabled by a security plugin) | `discover_rest_routes` with `search` |
| 401 / `rest_not_logged_in` | Credentials missing or rejected, or the Authorization header stripped | `test_site`; see `site-setup` |
| `rest_cookie_invalid_nonce` | The Authorization header never reached PHP, so WordPress fell back to cookie auth | Header passthrough (`site-setup`) |
| 403 / `rest_forbidden`, `rest_cannot_edit` | Role lacks the capability, or a security plugin blocks writes | `get_user` with `id: "me"` |
| HTML instead of JSON | WAF or security challenge page, or wrong REST prefix | Allowlist the server; check `restPrefix` |
| "companion plugin" required | Tool needs wpxmcp-helper | Install it (`site-setup`) |
| 500 | PHP fatal in that request | `tail_error_log` with `level: "error"` |

**Scheduled posts missed / cron jobs late**
`inspect_registry` with `kind: "cron"`: overdue events mean WP-Cron is not triggered (no traffic, `DISABLE_WP_CRON` without a system cron, failing loopback in `site_info` health). `run_wp_cli` with `command: "cron event run {hook}"` runs one scheduled hook now (a hook name is required; there is no `--due-now`); publish a missed post with `update_content` with `id` and `status: "publish"`.

**Undo**

| Mistake | Recovery |
| --- | --- |
| Bad content edit | `list_revisions` with `id` → `restore_revision` with `id` and `revision_id` |
| Trashed content | `update_content` with `id` and `status: "draft"` |
| Bad theme publish | `activate_theme` with `stylesheet: "{previous}"` and `confirm: true` |
| Bad plugin settings change (made with `update_plugin_settings`) | `restore_plugin_settings` with `option` |
| Bad global styles change | global-styles revisions via `rest_api` with `route: "/wp/v2/global-styles/{id}/revisions"` |
| Bad bulk update, search-replace, SQL, meta write | No automatic undo; restore from backup (`backup_status`) or reverse by hand |
| Permanently deleted anything | Backup only |

`get_audit_log` shows what this server changed, when, and on which target.

## Verify

The original symptom is gone as a visitor sees it: `get_page_html` with `url` and `mode: "text"` or `mode: "summary"`.

## Report back

State the cause you found (with evidence), the fix, and anything outside WordPress the owner must do (CDN purge, host settings). If you undid something, say exactly what was restored and what could not be.
