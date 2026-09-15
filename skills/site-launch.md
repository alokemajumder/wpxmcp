---
name: site-launch
title: Launching or migrating a site
description: Use when taking a site live, moving it to a new domain or to HTTPS, or finishing a migration from staging — go-live checklist, search-replace of URLs, indexing, permalinks, caches and redirects.
keywords: site launch, launch, go live, going live, go live checklist, launch checklist, pre-launch, migrate, migration, move site, new domain, change domain, domain change, staging to production, search replace, search-replace, replace urls, http to https, switch to https, ssl, discourage search engines, noindex, permalinks, redirects, https
---

## When this applies

A staging or new site becomes public, the domain or protocol changes, or a migrated copy needs its URLs fixed. Ongoing SEO work: `seo-audit`.

## Rules

1. `backup_status` first, and a fresh backup before search-replace. Search-replace has no undo.
2. `run_wp_cli` `search-replace` always previews: the first call is a dry run with a `confirm_token`; repeat the identical command with the token within 10 minutes to apply.
3. It covers `posts` (content, title, excerpt), `postmeta`, `options`, comment content and term names, up to 5,000 rows per column per run. It does **not** touch usermeta, termmeta, GUIDs or plugin tables, and serialized values are replaced safely.
4. Replacing the old URL in `options` also rewrites `home` and `siteurl`. Run it only when the new URL already serves this install (DNS and HTTPS working), or WordPress redirects everyone, including this connection, to a dead address. Afterwards update the site's `url` in the wpxmcp config.
5. Replace full origins (`https://old.example.com`), never a bare word or domain fragment that also occurs in email addresses or other hosts.
6. Never untick "Discourage search engines" on a staging copy; only on the production URL.

## Procedure

1. Baseline: `backup_status`, `site_info`, `seo_site_check`, `security_audit` with `include_vulnerabilities: true`.
2. URLs (migration or HTTPS): `run_wp_cli` with `command: "search-replace https://old.example.com https://new.example.com"` → read `rows_affected` and samples in the preview → repeat with `confirm_token`. Then a second pass for JSON-escaped copies used by page builders: `command: "search-replace https:\/\/old.example.com https:\/\/new.example.com"`. If the result says `incomplete`, run again. For http → https on the same host, replace `http://example.com` with `https://example.com`.
3. Indexing: `set_option` with `name: "blog_public"` and `value: 1`. Deactivate any coming-soon plugin: `list_plugins` with `search: "coming soon"`, then `deactivate_plugin`.
4. Permalinks: if plain (`get_options` with `names: ["permalink_structure"]` is empty), `set_option` with `name: "permalink_structure"` and `value: "/%postname%/"`, then `run_wp_cli` with `command: "rewrite flush"`. This changes every URL: only before launch, or with redirects.
5. Settings: `get_site_settings`, then `update_site_settings` with `title`, `description` or `timezone` as needed. The admin email must be changed in wp-admin, where WordPress emails the new address for confirmation.
6. Redirects for changed URLs: `discover_rest_routes` with `search: "redirection"` (Redirection plugin) or the SEO plugin's redirect manager; otherwise give the owner server rules. Never guess a redirect plugin's route.
7. Clean up staging leftovers: `list_users` (test accounts), `list_plugins` with `status: "inactive"`, `content_inventory` with `status: "draft"` for sample content.
8. `purge_cache` with `scope: "all"`.

## Verify

- `seo_site_check`: blog_public, robots.txt, sitemap, HTTPS redirect and permalinks all pass.
- `check_links` with `url: "/"` and `check_links` with `type: "page"`: no links to the old domain (mixed content or 404), no internal 404s.
- `get_page_html` with `url: "/"` and `mode: "head"`: canonical and Open Graph URLs use the new origin.
- `test_site` succeeds against the updated URL.

## Report back

Rows changed by each search-replace, settings changed, what is now indexable, and the human checklist that tools cannot do: DNS and SSL certificate, submitting the sitemap in Search Console, testing forms and email delivery, checkout if any, CDN purge, and uptime monitoring.
