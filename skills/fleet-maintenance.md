---
name: fleet-maintenance
title: Agency maintenance rounds and content reporting
description: Use for recurring maintenance across many client sites (updates, health, backups, reports) and for the reports content teams ask for — content inventories, editorial calendars, link health across a site.
keywords: fleet, agency, maintenance, maintenance round, monthly maintenance, all sites, every site, all my sites, client sites, multiple sites, portfolio, care plan, retainer, maintenance report, client report, content inventory, content audit spreadsheet, content calendar, editorial calendar, publishing cadence, stale drafts
---

## When this applies

Several sites are configured (`list_sites`) and the task is a round across them, or a team wants inventory, calendar or link-health reporting for one site.

## Rules

1. Report first, change second. `fleet_report` is read-only; decide per site what to do.
2. Per site: `backup_status` before updates, one plugin update at a time, verify between updates.
3. Do not "fix" staging findings (noindex, plain HTTP) that are intentional; the report already downgrades them to `info` for non-production environments.
4. Nothing on a site marked `writable: false` changes; report it instead.
5. Link suggestions are suggestions. Read both pages before adding a link; never bulk-insert links.

## Procedure

1. `fleet_report` (all sites, worst first; each site isolated). Read `headline` first. Re-check one site later with `fleet_report` with `site_ids: ["{id}"]`.
2. For each site with critical or warning issues, with `site_id` set:
   1. `test_site` if unreachable or 401.
   2. `backup_status`; stop and flag if there is no recent backup.
   3. `site_info` for pending updates; `run_wp_cli` with `command: "plugin update {slug}"` one at a time, then `get_page_html` with `url: "/"` and one key page. Themes: `command: "theme update {stylesheet}"`. Core updates are not available through tools; list them for the owner.
   4. `security_audit` with `max_lookups: 60`; act on critical/high (see `security-hardening`).
   5. `seo_site_check`; fix `fail` items only when they are clearly unintended.
   6. `check_links` with `type: "post"` and `limit: 20` for broken links in recent content.
   7. `get_audit_log` with `limit: 50` for the change list in the client report.
3. Content reporting (one site):
   - `content_inventory` with `types: ["post", "page"]` and `format: "csv"` (follow `next_cursor`); lighter rows with `fields: ["id", "url", "title", "words", "modified"]`.
   - `content_calendar` with `weeks_back: 12`, `weeks_ahead: 8` and `target_per_week: 2`: scheduled posts per week, cadence, stale drafts, `gaps`.
   - `internal_link_report` with `limit: 300`: orphans, dead ends and suggestions (menu and widget links are not counted).

## Verify

`fleet_report` with `site_ids` for the sites you changed shows the resolved issues gone and no new critical ones; each updated site's homepage returns 200 in `get_page_html`.

## Report back

One section per site: status before/after, updates applied (name and version), findings left open with reason, backup age, and anything needing the client (core updates, paid plugin licenses, host issues). Keep a fleet summary table at the top: site, severity, top issue, action.

## Reference: fleet_report severities

| Severity | Typical cause | First move |
| --- | --- | --- |
| critical | Unreachable, credentials rejected (401), homepage 5xx, 5+ plugin updates, Site Health critical, production noindexed | `test_site` on that site |
| warning | Core/theme/plugin updates, no HTTPS, slow REST index (> 3 s), homepage 4xx, WP_DEBUG on in production | This round |
| info | Companion plugin missing, no credentials, non-production quirks | Note in the report |

Update counts, PHP version and Site Health need the companion plugin. `check_links` costs one or two requests per URL (cap 150 per call); keep `max_links` modest on Cloudflare Workers. `content_inventory` SEO columns only fill from Yoast's REST output; use `get_seo_meta` per item otherwise.
