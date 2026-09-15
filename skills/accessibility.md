---
name: accessibility
title: Accessibility audit and fixes
description: Use when checking or improving accessibility (WCAG, ADA, screen readers, keyboard users) — alt text, headings, contrast, link text, form labels — and deciding whether each fix belongs in content, the theme or global styles.
keywords: accessibility, accessible, a11y, wcag, ada, ada compliance, section 508, eaa, screen reader, blind users, keyboard navigation, alt text, missing alt text, color contrast, contrast ratio, heading order, form labels, link text, read more links, aria
---

## When this applies

An accessibility review, a complaint from a user of assistive technology, or a compliance request. Contrast inside a block theme's theme.json during theme development: `theme-json` covers the file edits.

## Rules

1. Automated checks find a subset of problems. Never tell anyone the site "is compliant"; say which checks pass and what needs manual testing (keyboard, screen reader, zoom, captions).
2. Fix at the source. An issue that repeats on every page lives in the theme (template, part, global styles), not in each post.
3. Alt text describes the image's purpose in context; decorative images get empty alt (`alt=""`), not "image". Never use the filename.
4. Do not "fix" contrast by making text lighter or thinner; darken the text or change the background token.
5. Theme changes go through a draft (classic) or a previewed global-styles change (block); content fixes use `update_content` with `edits`.

## Procedure

1. Sample: `check_accessibility` with `url` for the homepage, one post, one page, one archive and any form page. Note issues repeated on every URL (theme) versus one URL (content).
2. Images: `audit_media` with `limit: 200` lists images without alt text; `update_media` with `id` and `alt_text`. Alt stored in the library applies to future insertions; images already inside posts carry their own `alt` in the block markup, so also fix those with `update_content` with `edits`.
3. Route each remaining issue:

| Issue (rule) | Usually lives in | Fix with |
| --- | --- | --- |
| `image-alt` in a post | content | `update_content` with `edits` on the `<img alt="">` |
| `single-h1`, `heading-order` in body | content | change heading levels via `edits` (body starts at H2) |
| `single-h1` on every page | theme: site title as H1, or a template adding one | block theme: `get_template` with `kind: "template_part"`; classic: `header.php` in a draft |
| `color-contrast` on every page | global styles / palette | block: `validate_theme_json`, then `update_global_styles`; classic: theme tokens (`design`) |
| `color-contrast` in one block | content color classes | change the block's `textColor`/`backgroundColor` via `edits` |
| `link-text-generic` ("read more") | template (Read More block, excerpt link) or content | give the link a descriptive label or visually hidden text |
| `link-name`, `button-name` | icon-only links in header/footer/social blocks | add a text label or `aria-label` in the part or template |
| `form-label` | form plugin or search block | enable the plugin's label setting; keep the Search block label (hide it visually instead of deleting) |
| `html-lang`, `meta-viewport` | theme header | classic `header.php` (`language_attributes()`, no `user-scalable=no`) |
| `frame-title`, `media-autoplay` | content embeds | add `title` to the iframe; remove autoplay |
| `duplicate-id` | template or content | rename one id and any `aria-*`/`for` pointing at it |

4. `purge_cache` with `scope: "all"` after theme-level fixes.

## Verify

- Re-run `check_accessibility` with the same URLs (for a draft theme, pass `preview_token` from `get_preview_url`); counts should drop, with none new.
- Block themes: `validate_theme_json` reports no contrast errors for the theme, user styles or variations.

## Report back

Summarize by severity with counts before and after, which fixes were theme-wide versus per-page, and what still needs a human: keyboard-only walk-through, screen-reader test, captions and transcripts, PDFs, third-party widgets. Avoid legal conclusions.

## Reference

- WCAG 2.2 AA contrast: 4.5:1 normal text; 3:1 for large text (24px, or about 18.7px bold) and for UI components and focus indicators.
- `check_accessibility` reads server HTML only: content injected by JavaScript, computed CSS, focus order and hover states are not evaluated.
