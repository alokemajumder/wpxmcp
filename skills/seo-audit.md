---
name: seo-audit
title: Auditing and fixing SEO
description: How to detect the active SEO plugin, find missing metadata and alt text, and fix it in bulk.
keywords: seo, yoast, rank math, aioseo, seopress, meta description, alt text, audit, title tag, schema, sitemap, rank, ranking, google, search engine, traffic, visibility, found on google, seo score
---

## 1. Detect the plugin first

Different plugins store metadata under different meta keys. Run `list_plugins` and look for `wordpress-seo` (Yoast), `seo-by-rank-math`, `all-in-one-seo-pack`, or `wp-seopress`. `get_content_summary` also reports which plugin's fields it found on a given item.

| Plugin | Title key | Description key |
| --- | --- | --- |
| Yoast | `_yoast_wpseo_title` | `_yoast_wpseo_metadesc` |
| Rank Math | `rank_math_title` | `rank_math_description` |
| AIOSEO | `_aioseo_title` | `_aioseo_description` |
| SEOPress | `_seopress_titles_title` | `_seopress_titles_desc` |

AIOSEO also mirrors data into its own table, so prefer its REST namespace or an ability over raw meta writes where one exists.

## 2. Find the problems

```
audit_content   type: "post",  limit: 200   → missing meta, thin content, duplicate titles, missing alt text, h1 problems
audit_media     check_unused: true          → images with no alt text, and orphaned attachments
get_page_html   mode: "summary"             → what the rendered page actually emits: title, meta description, canonical, OG tags, h1 count
```

`get_page_html` is the one that tells the truth. A plugin can be configured correctly and still emit nothing if a template overrides it.

## 3. Fix

Write metadata through the content tools, using the right key for the detected plugin:

```jsonc
update_content: {
  id: 42,
  meta: { "_yoast_wpseo_metadesc": "A specific, 150-character description of this page." }
}
```

If the key is not registered with `show_in_rest`, that write is silently ignored — use `set_content_meta` instead, which writes any key through the companion plugin.

Alt text is a media-library fix, not a content fix:

```jsonc
update_media: { id: 88, alt_text: "A red bicycle leaning against a brick wall" }
```

## 4. What actually matters

Fix in this order, because this is the order of impact:

1. **Missing or duplicate title tags.** Every page needs one, and it must be distinct.
2. **Missing meta descriptions** on pages that get traffic. Aim for 140–160 characters, written for a human deciding whether to click.
3. **Missing alt text.** Accessibility first; search benefit is a side effect. Describe what the image shows, not "image of".
4. **Thin content** on pages meant to rank.
5. **Multiple h1 elements.** One per page. The theme usually renders it from the title, so an `<h1>` inside the body is a duplicate.
6. **Broken internal links** after a slug change. Changing a slug on published content breaks every existing link unless you add a redirect.

## What not to do

- Do not write keyword-stuffed descriptions. They read badly and no longer help.
- Do not change slugs on published, indexed content without a redirect plugin in place.
- Do not bulk-rewrite titles without reviewing the plan `bulk_update_content` prints — it previews before it writes for exactly this reason.
