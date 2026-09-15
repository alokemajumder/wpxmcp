---
name: seo-audit
title: Auditing and fixing SEO
description: Use for search visibility work — site-wide SEO checks, meta titles and descriptions, noindex and canonical problems, sitemaps, broken and internal links — with Yoast, Rank Math, AIOSEO, SEOPress or The SEO Framework.
keywords: seo, search engine, google, ranking, rank better, found on google, traffic, meta description, meta descriptions, seo title, title tag, noindex, canonical, sitemap, robots.txt, yoast, rank math, aioseo, seopress, seo framework, schema, open graph, duplicate titles, broken links, internal links, orphan pages, search console, showing up on google, on google, not indexed, indexing
---

## When this applies

Improving how the site appears in search, or diagnosing why pages are not indexed. Launch-time indexing switches: `site-launch`. Image alt text for accessibility: `accessibility`.

## Rules

1. Site-wide blockers first. "Discourage search engines", a robots.txt that disallows `/`, or a noindexed homepage outweighs every per-page fix.
2. Write SEO fields through `set_seo_meta` (plugin's own route or keys, preview then `confirm_token`). Do not hand-write meta keys: AIOSEO ignores post meta (its data is in its own table) and robots values differ per plugin.
3. Without an active SEO plugin, core has no meta description, canonical override or per-item noindex; recommend a plugin instead of writing keys nothing reads.
4. Do not change slugs on published, indexed content without a redirect in place.
5. No keyword stuffing, no bulk-generated identical descriptions, no link insertion without reading both pages.
6. The rendered `<head>` is the truth. A correct stored value that does not render means a cache, a theme override, or a second SEO plugin.

## Procedure

1. `seo_site_check` — blog_public, robots.txt, sitemap, homepage head, permalinks, HTTPS and redirect, duplicate titles. Fix every `fail` first.
2. Content gaps: `audit_content` with `type: "post"` and `limit: 200` (then `type: "page"`) for missing SEO titles/descriptions, duplicate or missing H1, thin content, missing featured images and alt text. `content_inventory` with `format: "csv"` for a spreadsheet view.
3. One item in depth: `get_seo_meta` with `id` or `url` — detected plugin, stored overrides, what renders, mismatches.
4. Fix fields: `set_seo_meta` with `id`, `title`, `description` (and `canonical`, `noindex`, `focus_keyword` when needed); review the before → after preview, then repeat with `confirm_token`.
5. Links: `check_links` with `type: "post"` and `limit: 20` for 4xx/5xx, redirect chains, mixed content and links to drafts or trash (follow `next_cursor`). `internal_link_report` for orphans, dead ends and related pairs; add natural links with `update_content` with `edits`.
6. Titles in bulk (for example a site-wide `%%title%% | Brand` pattern) belong in the SEO plugin's settings, not in per-post overrides: `list_admin_pages` with `plugin: "wordpress-seo"` (or the active plugin) → `admin_page` with `url_or_page` → `submit_admin_form` with `page` and `changes` (preview, then `confirm_token`).
7. After changes: `purge_cache` with `scope: "url"` and `url` for each fixed page.

## Verify

- `get_seo_meta` with `id` shows no mismatch between stored and rendered values.
- `get_page_html` with `url` and `mode: "head"` shows one `<title>`, one meta description, the expected canonical and robots.
- Re-run `seo_site_check`: no `fail`.

## Report back

Lead with site-wide blockers and whether they are fixed. Then counts (descriptions added, links fixed, orphans linked) and what remains for a human: submitting the sitemap in Search Console, redirects for changed URLs, content rewrites for thin pages. Say that rankings respond over weeks, not immediately.

## Reference: where plugins store per-item fields (read-only knowledge)

| Plugin (slug) | Title / description keys | Robots |
| --- | --- | --- |
| Yoast (`wordpress-seo`) | `_yoast_wpseo_title`, `_yoast_wpseo_metadesc` | `_yoast_wpseo_meta-robots-noindex` `1` = noindex, `2` = index |
| Rank Math (`seo-by-rank-math`) | `rank_math_title`, `rank_math_description` | `rank_math_robots` array (`noindex`, `nofollow`) |
| AIOSEO (`all-in-one-seo-pack`) | `wp_aioseo_posts` table (post meta copies are not read) | same table |
| SEOPress (`wp-seopress`) | `_seopress_titles_title`, `_seopress_titles_desc` | `_seopress_robots_index` = `yes` means noindex |
| The SEO Framework (`autodescription`) | `_genesis_title`, `_genesis_description` | `_genesis_noindex` `1` |

Yoast and Rank Math titles accept template variables (`%%sitename%%`, `%sitename%`). Description length: about 140–160 characters; titles truncate past about 60.
