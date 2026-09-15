---
name: content-publishing
title: Writing, scheduling and publishing posts
description: Use when creating a blog post, article or page for publication — draft, featured image, categories and tags, excerpt, SEO title and description, internal links, scheduling and going live.
keywords: blog post, new post, write a post, write an article, article, publish a post, publish a blog post, schedule, schedule a post, scheduled post, publish date, featured image, excerpt, categories, tags, draft, editorial, newsletter post, announcement, press release
---

## When this applies

A new piece of content is being prepared for publication, or a draft is being finished and published or scheduled. Editing one phrase on an existing page: `everyday-tasks`.

## Rules

1. Content is created as a draft. Publish or schedule only when the person has said to, and say which it will be.
2. Search before creating: `search_site` with `query` for the title or topic, so you do not publish a duplicate.
3. Scheduling uses `status: "future"` with `date` in the site's timezone (`get_site_settings` → `timezone`); a past date with `status: "publish"` backdates instead. Scheduled posts rely on WP-Cron, which only runs when the site gets traffic.
4. Match the editor: block markup (load `gutenberg`) unless the Classic Editor plugin is active, then plain HTML.
5. Every image gets real alt text. Never hotlink stock images; upload them with attribution.
6. Changing the slug of a published item breaks existing links; do it only before publishing.

## Procedure

1. Structure: `discover_taxonomies` with `for_type: "post"`, `list_terms` with `taxonomy: "category"` (reuse existing terms; avoid leaving only "Uncategorized"), `list_plugins` with `search: "classic"`.
2. Draft: `create_content` with `type`, `title`, `content`, `excerpt`, `slug`, `terms: {"categories": ["News"], "tags": ["launch"]}` (names are created if missing). One H1 comes from the title, so body headings start at H2.
3. Featured image: `create_media` with `file_path` or `url`, `alt_text` and `set_as_featured_for: {post id}`. From stock: `search_stock_photos` with `query`, then `create_media` with the result's `download_url` as `url` and its `attribution`.
4. Internal links: `internal_link_report` with `types: ["post", "page"]` for related items; add one or two natural links with `update_content` with `id` and `edits`, and link to the new post from an older related post once it is live.
5. SEO: `set_seo_meta` with `id`, `title` and `description` (140–160 characters) returns a preview; repeat with `confirm_token`. It refuses when no SEO plugin is active; say so rather than writing meta keys.
6. Review with the person: `get_content_summary` with `id` (title, excerpt, terms, word count, SEO fields).
7. Go live when told: `update_content` with `id` and `status: "publish"`, or `status: "future"` and `date: "2026-10-01T09:00:00"`.

## Verify

- Before publishing: `get_content` with `id` and `raw: false` shows rendered output. `get_page_html` cannot see drafts or scheduled posts (visitors get a 404).
- After publishing: `get_page_html` with `url: "{permalink}"` and `mode: "summary"` (title, description, one H1, image alt coverage); `get_seo_meta` with `id` compares stored and rendered SEO values; `check_links` with `ids: [{id}]`.
- Scheduled: `content_calendar` lists it under its week. If the time passes and it is still `future`, WP-Cron did not run (see `troubleshooting`).
- If the live page shows the old version or 404s, `purge_cache` with `scope: "url"` and `url`.

## Report back

Title, status (draft, scheduled for a date and timezone, or live with its URL), categories and tags, featured image and SEO description. For drafts, say it is not visible to visitors yet and how to preview it in wp-admin.
