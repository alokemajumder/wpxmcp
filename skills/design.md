---
name: design
title: Changing a site's look (colors, fonts, spacing)
description: Use when changing how the site looks — colors, fonts, spacing, buttons, header or footer styling — or restyling a theme, so the change lands in the layer that actually controls it.
keywords: design, look, restyle, redesign, color, colour, colors, brand colors, palette, font, fonts, typography, spacing, button style, header color, footer color, background color, dark mode, style, aesthetic, polish, modern look, customizer, additional css
---

## When this applies

Visual changes to an existing site or a theme being built. Theme development inside theme.json files: `theme-json`. Building a classic theme: `classic-theme`. Builder pages: `page-builders`.

## Rules

1. Find the layer that owns the value before changing it. Styling written in the wrong layer is overridden (a block theme's user styles beat theme.json; a builder kit beats the theme).
2. Change tokens, not instances: a palette entry, a CSS custom property or a Customizer setting, never a hex value pasted into many blocks or templates.
3. Read current values first and keep them in the report so the change can be reverted.
4. Keep text contrast at 4.5:1 (3:1 for large text and UI controls). A brand color that fails goes on backgrounds, with a darker shade for text.
5. Sitewide style changes are live immediately on block themes. Say so before applying, or use a draft theme.

## Procedure

1. `get_theme` with `stylesheet: "{active theme}"` (from `list_themes` with `status: "active"`): block theme or classic, parent theme.
2. Route by owner:
   - **Block theme, quick change**: `get_global_styles` with `include_theme_defaults: true`, then `update_global_styles` with `settings` or `styles` and `merge: true` (arrays such as the palette are still replaced whole, so send the full palette). Try `list_style_variations` first; a shipped variation may already be the look requested (`apply_style_variation` previews before applying).
   - **Block theme, header/footer styling**: the header is a template part. `get_template` with `id: "{theme}//header"` and `kind: "template_part"`, change the group block's color attributes, `update_template` with `kind: "template_part"`.
   - **wpxmcp classic scaffold** (has `theme.css`): edit the custom properties in `theme.css` in a draft (`create_draft_theme`, `edit_theme_file` with `path: "theme.css"`).
   - **Other classic themes**: `get_theme_mods`; change a key with `set_theme_mod` with `key` and `value`. Astra, GeneratePress and Kadence keep global colors in options (`astra-settings`, `generate_settings`, `kadence_global_palette`): read with `get_options`, and prefer the Customizer for writes because those themes regenerate CSS on save.
   - **Elementor sites**: global colors and fonts are the Elementor Kit; follow `page-builders`.
   - **Extra CSS only**: block themes accept `update_global_styles` with `styles: {"css": "…"}` and `merge: true`; on classic themes `code_snippet` with `action: "create"`, `language: "css"`, `location: "header"` (created disabled; the owner activates it).
3. `validate_theme_json` (block themes) to catch contrast failures in the new palette.
4. `purge_cache` with `scope: "all"`.

## Verify

- `get_page_html` with `url: "/"` and `mode: "html"`: the new value appears as a preset variable, class or inline style.
- `check_accessibility` with `url` and `rules: ["color-contrast"]` on the homepage and one inner page.

## Report back

Say which layer you changed and why that one, the old and new values, and whether it is already live. Mention that design judgment (does it look right) needs a human look in a browser; tools only see the HTML.

## Reference: design defaults that hold up

- One idea per site, stated in a sentence ("editorial and quiet"), and every choice checked against it.
- Type: at most two families; a modular scale (1.2–1.333); body 16–19px, line-height 1.5–1.75, line length 60–75 characters; headings line-height 1.1–1.25. `clamp()` for fluid heading sizes.
- Color: one neutral family and one accent used for interactive elements. Derive grays from the ink color (`color-mix(in srgb, var(--color-ink) 65%, var(--color-surface))`) rather than unrelated grays.
- Space: one scale (4px or 8px base); generous section spacing (`clamp(3rem, 8vw, 6rem)`); related items close, unrelated far apart.
- Detail: soft large shadows (`0 8px 24px rgb(0 0 0 / 0.06)`); transitions 150–250ms on `transform`/`opacity`; consistent image aspect ratios with `object-fit: cover`.
- Never remove focus outlines without a visible replacement; honor `prefers-reduced-motion`; test with a long title, a missing image and an eight-item menu.
