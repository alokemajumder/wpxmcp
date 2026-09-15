---
name: gutenberg
title: Writing Gutenberg block markup
description: Use when writing or editing block-editor content (post, page, template or pattern markup) so blocks stay valid in the editor.
keywords: gutenberg, block, blocks, block editor, block markup, wp:paragraph, invalid content, unexpected content, attempt recovery, columns, group block, reusable block, synced pattern, shortcode block
---

## When this applies

Writing new block markup for `create_content` / `update_content` / `update_template`, or editing existing block content. Not for page-builder posts (load `page-builders`) or classic-editor sites (plain HTML is fine there).

## Rules

1. Read before editing: `get_content` returns the raw stored markup, delimiters included. Never edit what you assume is there.
2. Change existing pages with `update_content` `edits` (find/replace), never by resending the whole body.
3. Every static block needs an opening and closing delimiter around exactly the HTML the block's save function produces. Only blocks with no saved HTML are self-closing: dynamic blocks (`<!-- wp:latest-posts /-->`, `<!-- wp:template-part {"slug":"header"} /-->`), synced patterns (`<!-- wp:block {"ref":123} /-->`), `<!-- wp:pattern {"slug":"theme/name"} /-->`. Writing `<!-- wp:separator /-->` with no `<hr>` is invalid.
4. Attribute JSON must be valid JSON with double quotes. Inside string values the editor escapes `--`, `<`, `>`, `&` and `"` as `--`, `<`, `>`, `&`, `"`; do the same, or the comment ends early.
5. Attributes and markup must agree: a color, alignment or width in the JSON needs its class or inline style in the HTML.
6. Do not guess third-party block names or attributes: `list_block_types` with `search: "…"` or `namespace: "…"` shows what is registered.
7. Invalid blocks still render on the front end; the damage appears when an editor opens the post and "Attempt recovery" rewrites or drops content. A clean front end is not proof of valid markup.

## Procedure

1. Check the editor: `list_plugins` with `search: "classic"`. With Classic Editor active, write plain HTML and stop here.
2. Check the content owner: `get_content_meta` with `id` (companion plugin; returns `builder_hint`). A builder hint means load `page-builders` instead.
3. Prefer existing layout: `list_block_patterns` with `search: "…"` and `include_content: true`, then adapt that markup rather than hand-writing sections.
4. For an existing post: `get_content` with `id`, then `update_content` with `edits: [{find, replace}]`. Include enough surrounding markup in `find` (for example `<p>Old text</p>`) that the match is unique and not inside an attribute.
5. For new content: `create_content` with `content` built from the shapes below; it is saved as a draft.

## Verify

- `get_content` with `id` and `raw: false` shows the rendered HTML (works for drafts, which visitors cannot see).
- For published content, `get_page_html` with `url` and `mode: "text"` confirms the words reached the page.
- If a block looks wrong, compare its markup with the same block in `list_block_patterns` output or an editor-saved post.

## Report back

Say which post (title, id, status) changed and that it is still a draft unless asked to publish. Mention any block you could not express validly (for example a plugin block with unknown attributes) instead of improvising it.

## Reference: core block shapes (WordPress 6.x–7.1)

```html
<!-- wp:paragraph --><p>Body text.</p><!-- /wp:paragraph -->
<!-- wp:heading --><h2 class="wp-block-heading">Level 2 is the default, so no attribute</h2><!-- /wp:heading -->
<!-- wp:heading {"level":3} --><h3 class="wp-block-heading">Level 3</h3><!-- /wp:heading -->
<!-- wp:list --><ul class="wp-block-list"><!-- wp:list-item --><li>One</li><!-- /wp:list-item --></ul><!-- /wp:list -->
<!-- wp:image {"id":42,"sizeSlug":"large","linkDestination":"none"} -->
<figure class="wp-block-image size-large"><img src="https://example.com/wp-content/uploads/2026/01/x.jpg" alt="Describe the image" class="wp-image-42"/></figure>
<!-- /wp:image -->
<!-- wp:quote --><blockquote class="wp-block-quote"><!-- wp:paragraph --><p>Quote.</p><!-- /wp:paragraph --><cite>Name</cite></blockquote><!-- /wp:quote -->
<!-- wp:buttons --><div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="/contact/">Get in touch</a></div><!-- /wp:button --></div><!-- /wp:buttons -->
<!-- wp:separator --><hr class="wp-block-separator has-alpha-channel-opacity"/><!-- /wp:separator -->
<!-- wp:spacer {"height":"48px"} --><div style="height:48px" aria-hidden="true" class="wp-block-spacer"></div><!-- /wp:spacer -->
<!-- wp:html --><div>Raw HTML, no wrapper added</div><!-- /wp:html -->
<!-- wp:shortcode -->[contact-form-7 id="12"]<!-- /wp:shortcode -->
```

Layout: `columns` may contain only `column` children, and each column wraps its own blocks.

```html
<!-- wp:group {"layout":{"type":"constrained"}} --><div class="wp-block-group">
<!-- wp:columns --><div class="wp-block-columns">
<!-- wp:column {"width":"60%"} --><div class="wp-block-column" style="flex-basis:60%"><!-- wp:paragraph --><p>Left</p><!-- /wp:paragraph --></div><!-- /wp:column -->
<!-- wp:column {"width":"40%"} --><div class="wp-block-column" style="flex-basis:40%"><!-- wp:paragraph --><p>Right</p><!-- /wp:paragraph --></div><!-- /wp:column -->
</div><!-- /wp:columns -->
</div><!-- /wp:group -->
```

| Setting | Attribute JSON | Markup |
| --- | --- | --- |
| Palette text color | `"textColor":"contrast"` | `class="has-contrast-color has-text-color"` |
| Palette background | `"backgroundColor":"base"` | `class="has-base-background-color has-background"` |
| Custom color | `"style":{"color":{"text":"#1a1a1a"}}` | `class="has-text-color" style="color:#1a1a1a"` |
| Font size preset | `"fontSize":"large"` | `class="has-large-font-size"` |
| Text alignment | 7.x: `"style":{"typography":{"textAlign":"center"}}`; 6.x: paragraph `"align"`, heading `"textAlign"` | `class="has-text-align-center"` |

Text alignment moved between versions, so when it matters copy the shape from an editor-saved block on that site.
