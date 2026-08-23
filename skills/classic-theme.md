---
name: classic-theme
title: Building classic PHP themes
description: How to author classic PHP theme templates with Tailwind, using the draft workflow so the live site is never broken.
keywords: theme, classic theme, php, template, tailwind, header, footer, functions.php, theme builder, design, style
---

## Why classic templates

Classic PHP templates styled with Tailwind utilities produce cleaner, more predictable output than generated block markup. The result is readable, diffable, and reviewable by a human. Use this for anything you are building from scratch.

## The workflow — never edit a live theme

```
create_draft_theme        →  an isolated copy; the live site is untouched
write_theme_file / edit_theme_file  →  build in the draft
get_preview_url           →  a private tokenised URL only you see
get_page_html             →  verify the rendered output
publish_draft_theme       →  goes live, previous theme backed up automatically
```

`create_classic_theme` scaffolds a complete starter (header, footer, index, single, page, archive, search, 404, comments, `template-parts/`, `theme.css`, Tailwind wiring) in one call. Start there rather than writing a theme from an empty directory.

## One source of truth for design

Every color, font, radius and spacing value lives in `theme.css` as a CSS custom property. `functions.php` maps those onto Tailwind, so templates use semantic classes:

```php
<div class="rounded-theme border border-border-token bg-surface-alt p-6 text-ink">
  <h2 class="text-2xl font-semibold">…</h2>
  <p class="mt-2 text-ink-muted">…</p>
</div>
```

**Never hardcode `#1d4ed8` or `rounded-lg` in a template.** Restyling then means editing one file, and the site stays coherent.

## Template hierarchy — the parts worth remembering

| Request | Template |
| --- | --- |
| Blog listing / fallback | `index.php` |
| Single post | `single.php`, or `single-{posttype}.php` |
| Single page | `page.php`, or `page-{slug}.php` |
| Category / tag / CPT archive | `archive.php`, `category.php`, `archive-{posttype}.php` |
| Search results | `search.php` |
| Not found | `404.php` |

Fragments go in `template-parts/` and are pulled in with `get_template_part( 'template-parts/card' )`.

## Non-negotiables

1. **Escape everything on output.** `esc_html()` for text, `esc_url()` for URLs, `esc_attr()` for attributes, `wp_kses_post()` for editor HTML. Never echo a variable raw.
2. **Prefix every function** with the theme slug. `mytheme_setup()`, not `setup()` — an unprefixed function fatals the site when something else declares the same name.
3. **Enqueue, do not inline.** Use `wp_enqueue_style` / `wp_enqueue_script` in a `wp_enqueue_scripts` action. Hardcoded `<link>` tags break caching plugins and child themes.
4. **`wp_head()` and `wp_footer()` are mandatory.** Omitting them breaks the admin bar, plugins, and half the ecosystem.
5. **Content belongs in the database, not in templates.** Anything an editor should be able to change goes in a post, a menu, a widget, or a registered field.

## Keep it editable afterwards

As you build, register the fields the client will need with `register_fields`. They render as native meta boxes in wp-admin and are exposed to REST automatically, so the site stays maintainable by a human who does not write PHP. See the `editable-fields` skill.

## Verify before publishing

```
get_preview_url  → the draft's private URL
get_page_html    → mode "summary" reports headings, meta tags, alt-text coverage
```

Then `publish_draft_theme` with `confirm: true`. The previous theme is backed up, so a bad publish is one `activate_theme` away from being undone.
