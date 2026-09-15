---
name: performance
title: Finding why a page is slow
description: Use when a page or the whole site is slow, or to find which plugin or theme adds queries, external HTTP calls, PHP warnings or memory — profiling a URL like Query Monitor does.
keywords: performance, slow, slow site, slow page, slow homepage, slowing, speed, speed up, faster, load time, ttfb, query monitor, profile, profiler, too many queries, duplicate queries, slow queries, n+1, memory, object cache, redis, which plugin is slow, pagespeed, core web vitals, autoload
---

## When this applies

"The site is slow", "which plugin slows the homepage", high TTFB, or checking a fix. Needs the companion plugin. Front-end weight (images, render-blocking CSS, Core Web Vitals) needs a browser tool; say so.

## Rules

1. Attribute before acting. Deactivating plugins "to see if it helps" on a live site is a last resort, done one at a time with the owner's consent.
2. Profile anonymously (the default): that is what visitors and caches see. Use `as_logged_in: true` only for logged-in complaints.
3. Compare like with like: same URL, same mode, before and after. Differences of a few ms are noise; look for step changes.
4. A persistent object cache hides repeated queries but does not fix them; name the component responsible.
5. Do not delete options or tables to "speed up" the site; autoload cleanup follows `wp-developer` with its preview step.

## Procedure

1. `profile_url` with `url: "/"`, then one post, one page and one archive. If the result says `profiled: false` with state `unused`, a page cache answered: that page is fast for visitors; profile a URL that is not cached, or ask whether the complaint is about logged-in users.
2. Read `headline_findings` first, then the section it names.
3. `timing.ttfb_ms` far above `timing.server_ms` means network, TLS or a proxy, not WordPress.
4. `queries.by_component` and each slow query's `component` (`core`, `plugin:{slug}`, `theme:{slug}`) name the owner; duplicate groups with high counts are N+1 loops, and their `callers` name the function.
5. `http` lists outbound calls made while rendering; each blocks every uncached view.
6. Heavy PHP with few queries: `profile_url` with `url` and `sections: ["hooks"]` shows which hooks fire thousands of times.
7. Site-wide overhead: `inspect_options` (autoloaded bytes vs the 800 KB Site Health threshold) and `site_info` (PHP version, object cache).
8. After a fix (plugin setting, update, replacement, cache enabled): `purge_cache`, then `profile_url` on the same URL.

## Verify

A second `profile_url` on the same URL shows the step change (query count, total ms, http calls). `get_page_html` with `url` confirms the page still renders correctly.

## Report back

Name the slow component with evidence (counts, ms, caller), the recommended fix and its trade-off, and before/after numbers if a change was made. State what was not measured (browser rendering, images, CDN).

## Reference: signals

| Signal | Usually means | Next step |
| --- | --- | --- |
| `queries.count` > 100 | N+1 loop (related posts, per-product meta, menus) | Highest-count duplicate group → its `callers` |
| One query tens of ms+ | Unindexed `meta_query` / `orderby meta_value`, `LIKE '%…%'`, large `SQL_CALC_FOUND_ROWS` | Fix in the named component; taxonomy or custom table for meta filters |
| Outbound HTTP on a front-end page | License checks, remote APIs, fonts fetched in PHP | Cache in a transient or move to cron |
| `wp-cron.php` in http | WP-Cron spawning on page load | Normal; busy sites set `DISABLE_WP_CRON` plus a system cron |
| High `server_ms`, few queries | Builders, heavy `the_content` filters, huge menus | `sections: ["hooks"]` |
| PHP warnings/deprecations | Outdated plugin/theme code | Update; each costs time when logging is on |
| `object_cache.persistent: false`, many queries | No Redis/Memcached | Recommend one where the host offers it |
| Status 301/302 | Only the redirect was profiled | Profile the `redirect_to` destination |

Limits: bootstrap work before plugins load is only totaled (`not_profiled_before_plugins_loaded`); with `SAVEQUERIES` forced false, queries are counted but not timed; asset sizes are uncompressed local file sizes.
