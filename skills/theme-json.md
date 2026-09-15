---
name: theme-json
title: Developing a block theme (theme.json, templates, variations)
description: Use when developing or fixing a block theme's theme.json, style variations, templates or template parts, including edits that "do nothing" because the Site Editor overrides them.
keywords: theme.json, block theme, fse, full site editing, site editor, global styles, style variation, template part, block template, templates html, fontface, customtemplates, reset template, revert template, section styles, theme json version, validate theme.json, lint
---

## When this applies

A block theme (`list_themes` shows `is_block_theme`) and the task touches theme.json, `styles/*.json`, `templates/*.html`, `parts/*.html` or `patterns/`. For a quick color or font change on a live site, `design` is enough.

## Rules

1. Rendering is a merge: core defaults → theme `theme.json` (+ `styles/blocks/*.json`) → user layer (Site Editor → Styles, a `wp_global_styles` post). The user layer wins, so a file edit under an override changes nothing.
2. A template or part edited in the Site Editor is copied to the database (`source: "custom"`); the theme file is ignored from then on.
3. Site Editor data belongs to one theme stylesheet. `publish_draft_theme` activates the draft as a different theme, so the live site's user global styles and customized templates do **not** carry over. Fold what should survive into the draft's files before publishing.
4. Never edit the live theme's files: draft → preview → publish.
5. Lint before writing and after publishing. Keep `"version": 3`.

## Procedure

1. `diff_global_styles` lists every user override (JSON path vs theme value) and every template/part with `source: "custom"`. Decide per item: keep, fold into files, or reset.
2. `validate_theme_json` for the current state (errors, warnings, contrast).
3. `create_draft_theme`, then `read_theme_file` with `theme: "{draft id}"` and `path: "theme.json"`.
4. Lint the new text first: `validate_theme_json` with `theme_json: "{full file text}"`. Then `write_theme_file` or `edit_theme_file` with `theme: "{draft id}"`.
5. Templates: edit `templates/{slug}.html` / `parts/{slug}.html` in the draft with block markup (load `gutenberg`). Reuse layout from `list_block_patterns` with `source: "theme"`.
6. Style variations: `list_style_variations` (full, color and typography partials since 6.6; titles repeat across kinds). `apply_style_variation` with `title` and `kind` (or `index`) previews a diff; repeat with `confirm_token` to apply. A full variation replaces the user layer; partials merge.
7. Preview: `get_preview_url` with `path: "/"`, then `check_accessibility` with `url` set to that preview URL.
8. `backup_status`, then `publish_draft_theme` with `confirm: true`.
9. If live output still shows old values: `reset_template_customization` with `id: "{theme}//{slug}"` and `kind` (preview, then `confirm_token`), or remove the overriding key via `update_global_styles` (read first; without `merge: true` a partial object replaces the whole branch).

## Verify

- `get_template_for_url` with `url`: `block_template.source` and `customized_in_database` show which copy renders.
- `get_page_html` with `url` and `mode: "html"`: look for the preset variables (`--wp--preset--color--{slug}`) and classes you expect.
- `validate_theme_json` on the published theme reports `valid: true`.

## Report back

List overrides found and what you did with each (kept, folded, reset), the draft id and the backup name from `publish_draft_theme`. Say plainly that resetting a template discards Site Editor changes, and that undo for global styles is a revision (`rest_api` with `route: "/wp/v2/global-styles/{id}/revisions"`).

## Reference: theme.json rules that bite

- Missing `version` means v1 and a migration with different defaults. In v3 `defaultFontSizes` and `defaultSpacingSizes` default to true, which stops a theme preset from overriding a core preset with the same slug (`small`, `medium`, `large`, `x-large`): set them false or use distinct slugs.
- Slugs become `has-{slug}-color` classes and `--wp--preset--color--{slug}` variables. Renaming a slug orphans content that used it; duplicates overwrite silently.
- In `styles`, reference presets as `var:preset|color|contrast`; hard-coded hex values cannot be recolored by variations.
- `fontFace[].src` for theme files is `"file:./assets/fonts/name.woff2"`; a bare relative path produces no `@font-face`.
- `customTemplates[].name` must match `templates/{name}.html`; `templateParts[].name` must match `parts/{name}.html` with `area` `header`, `footer` or `uncategorized` (`navigation-overlay` on recent versions).
- v1 keys (`typography.customLineHeight`, `spacing.customPadding`) are ignored in v2+: use `typography.lineHeight`, `spacing.padding`.
- Duotone values must be literal colors, not CSS variables.
- `elements.link` and `elements.button` colors do not follow `styles.color.text`; set them in dark variations too.
- `<!-- wp:pattern {"slug":"theme/name"} /-->` keeps a template linked to `patterns/*.php`; pasting the pattern's markup detaches it.
- Contrast from `validate_theme_json`: below 3:1 is an error; 3–4.5:1 a warning, acceptable only for large text.
