---
name: everyday-tasks
title: Everyday site management for a site owner
description: Use for routine owner requests — change wording on a page, menus, homepage, images, comments, users, site title, plugin updates, undoing a change — done safely and explained in plain language.
keywords: change text, edit page, fix typo, update prices, menu, navigation, add to menu, homepage, front page, photo, image, picture, upload, alt text, comment, comments, spam, moderate, turn off comments, close comments, add user, new user, site title, tagline, logo, update plugins, plugin updates, undo, revert, restore, old version, owner, client, beginner, typo, fix a typo
---

## When this applies

The person owns or runs the site and describes outcomes ("the prices are wrong", "turn off comments"). New articles: `content-publishing`. Site down: `site-down`. Looks and colors: `design`.

## Rules

1. Confirm the target before writing: resolve links with `find_content_by_url`, names with `search_site`, and say which page you found.
2. Show, then change: quote the current value and the proposed one in one sentence for anything visitors see.
3. Change the smallest thing: `update_content` with `edits`, never a full-body rewrite. If an edit "does not appear", the wording differs from what they said: ask, do not guess.
4. Before updates, theme changes or anything bulk: `backup_status`, and say plainly if there is no recent backup.
5. Explain results in their terms ("comments are off on the 14 News posts"), not field names.
6. Trash, never permanently delete, unless they explicitly ask and understand it cannot be undone.

## Procedure

Pick the task; each ends with the Verify step.

- **Change wording**: `find_content_by_url` with `url` → `get_content` with `id` and `type` → `update_content` with `id`, `type` and `edits: [{"find": "…", "replace": "…"}]`. If `get_content_meta` with `id` shows a `builder_hint`, load `page-builders` instead.
- **Add a menu link**: `list_menus`; then `add_menu_item` with `menu_id`, `title`, `type: "post_type"`, `object: "page"`, `object_id`. If `list_menus` is empty on a block theme, the menu is a `wp_navigation` post: `list_content` with `type: "wp_navigation"` and `full_content: true`, then add `<!-- wp:navigation-link {"label":"About","type":"page","id":12,"url":"/about/","kind":"post-type"} /-->` with `update_content` with `type: "wp_navigation"` and `edits` (a `<!-- wp:page-list /-->` lists all pages automatically; replacing it switches to a hand-picked menu).
- **Change the homepage**: `get_site_settings`; `update_site_settings` with `show_on_front: "page"` and `page_on_front: {id}` (and `page_for_posts` for the blog). Confirm first; it changes what every visitor sees.
- **Add or replace an image**: `create_media` with `file_path` or `url` and `alt_text` describing what the image shows; `set_as_featured_for` for a featured image. Missing alt text across the library: `audit_media`, then `update_media` with `id` and `alt_text`.
- **Clear the comment queue**: `list_comments` with `status: "hold"`; summarize genuine vs spam; `moderate_comments` with `ids` and `action: "approve"` or `action: "spam"`.
- **Turn off comments**: on existing posts, `bulk_update_content` with `filter: {"before": "2026-01-01T00:00:00"}` and `changes: {"comment_status": "closed"}` (preview, then `confirm_token`). For new content, `update_site_settings` with `default_comment_status: "closed"`. To close posts automatically after N days, `set_option` with `name: "close_comments_for_old_posts"`, `value: 1` and `set_option` with `name: "close_comments_days_old"`, `value: 30`.
- **Site title, tagline, icon**: `update_site_settings` with `title`, `description` or `site_icon` (attachment id). Logo: `set_theme_mod` with `key: "custom_logo"` and `value: {attachment id}` on classic themes; block themes use the Site Logo block.
- **Add a person**: `list_roles`; `create_user` with `username`, `email`, a long random `password` and the lowest role that works (`roles: ["editor"]` for content, never administrator unless asked). Share the password out of band.
- **Update plugins**: `backup_status` → `site_info` (pending updates) → one at a time `run_wp_cli` with `command: "plugin update {slug}"` → check the homepage and one key page after each. WordPress core updates are not available through these tools: point the owner to Dashboard → Updates.
- **Change a plugin setting**: `inspect_plugin` with `plugin` (its settings, options and admin pages) → read with `get_plugin_settings` with `plugin` and `option`, or `admin_page` with `url_or_page` → write with `update_plugin_settings` with `plugin`, `option` and `changes`, or `submit_admin_form` with `page` and `changes` (both preview first, then `confirm_token`). Undo: `restore_plugin_settings` with `option`.
- **Undo a content change**: `list_revisions` with `id` → `restore_revision` with `id` and `revision_id` (the current version is saved as a revision first). Trashed item: `update_content` with `id` and `status: "draft"`.
- **"I changed it but nothing changed"**: `purge_cache` with `scope: "url"` and `url`; if still stale, load `troubleshooting`.

## Verify

`get_page_html` with `url` and `mode: "text"` (or `mode: "summary"` for images and titles) shows the change as a visitor sees it. Drafts are invisible to it; use `get_content` with `raw: false`.

## Report back

One or two sentences in plain language: what changed, where, whether it is live, and anything they must do (activate a snippet, check a draft, take a backup). Mention cache delays if `purge_cache` reported a CDN `hit`.
