---
name: classic-theme
title: Building or editing a classic PHP theme
description: Use when building a classic PHP theme (for example with Tailwind) or editing PHP template files, using the draft workflow so the live site never breaks.
keywords: classic theme, php theme, custom theme, build a theme, tailwind, php template, functions.php, header.php, footer.php, single.php, page template, template hierarchy, child theme, get_template_part, theme from scratch, starter theme
---

## When this applies

Creating a theme from scratch, or changing `.php` templates, `functions.php` or theme CSS of a classic (non-block) theme. Block themes: `theme-json`.

## Rules

1. Never write to the live theme. `write_theme_file` refuses by default; keep `allow_live_theme` false and work in a draft.
2. Escape all output: `esc_html()` text, `esc_attr()` attributes, `esc_url()` URLs, `wp_kses_post()` editor HTML.
3. Prefix every function, class, handle and option with the theme slug; an unprefixed name collides and fatals.
4. Enqueue assets in a `wp_enqueue_scripts` callback; call `wp_head()` before `</head>`, `wp_body_open()` after `<body>` and `wp_footer()` before `</body>`.
5. Content an editor should change goes in posts, menus, widgets or registered fields (`editable-fields`), not hardcoded in templates.
6. Before editing an existing theme's file, read it: `write_theme_file` replaces the whole file; `edit_theme_file` needs exact text.

## Procedure

1. New theme: `create_classic_theme` with `name` and `tokens` (`primary`, `accent`, `ink`, `surface`, `font_sans`, `font_serif`, `radius`). It creates a draft with header, footer, index, single, page, archive, search, 404, comments, `template-parts/`, `theme.css` tokens and Tailwind wiring.
   Existing theme: `create_draft_theme` (clones the active theme), then `list_theme_files` with `theme: "{draft id}"`.
2. Find the file that renders a URL: `get_template_for_url` with `url` returns the resolved file, whether a child theme supplies it, and the hierarchy tried. Create a more specific file to affect only that URL.
3. Edit: `read_theme_file` with `theme` and `path`, then `edit_theme_file` with `theme`, `path` and `edits` (or `write_theme_file` for new files). PHP is syntax-checked before saving.
4. Design tokens live in `theme.css` as custom properties mapped to Tailwind names in `functions.php`: `bg-surface`, `bg-surface-alt`, `text-ink`, `text-ink-muted`, `bg-primary`, `text-primary-contrast`, `border-border-token`, `rounded-theme`, `shadow-card`, `max-w-container`. Use these, not raw hex or arbitrary values.
5. Register the fields the client will edit: `register_fields` (see `editable-fields`).
6. `get_preview_url` with `theme: "{draft id}"` and `path`, then check pages with `get_page_html` with `url`, `mode: "summary"` and `preview_token`, and `check_accessibility` with `url` and `preview_token`.
7. `backup_status`, then `publish_draft_theme` with `confirm: true`. Theme mods (logo, menu locations) are copied to the draft if it has none.

## Verify

- `get_page_html` on the live URLs after publishing; `get_template_for_url` confirms the new theme's file renders.
- `tail_error_log` with `level: "warning"` and `since` set to the publish time shows no new warnings from the theme.

## Report back

Give the preview URL before publishing, and after publishing the backup name returned; rollback is `activate_theme` with `stylesheet: "{previous}"` and `confirm: true`. Note that the scaffold loads Tailwind's Play CDN script, which compiles CSS in the browser and is meant for development; recommend a compiled stylesheet for a high-traffic production site.

## Reference: template hierarchy (most specific first)

| Request | Candidates |
| --- | --- |
| Front page | `front-page.php` → `home.php` (if blog) / page templates → `index.php` |
| Blog posts index | `home.php` → `index.php` |
| Single post / CPT | `single-{post_type}-{slug}.php` → `single-{post_type}.php` → `single.php` → `singular.php` → `index.php` |
| Page | custom template → `page-{slug}.php` → `page-{id}.php` → `page.php` → `singular.php` → `index.php` |
| Category | `category-{slug}.php` → `category-{id}.php` → `category.php` → `archive.php` → `index.php` |
| Custom taxonomy | `taxonomy-{tax}-{term}.php` → `taxonomy-{tax}.php` → `taxonomy.php` → `archive.php` |
| CPT archive | `archive-{post_type}.php` → `archive.php` → `index.php` |
| Author / date | `author-{nicename}.php` → `author.php` / `date.php` → `archive.php` |
| Search, 404 | `search.php`, `404.php` → `index.php` |

Child theme files override the parent's file of the same name; `functions.php` of both load (child first). Fragments load with `get_template_part( 'template-parts/card' )`.
