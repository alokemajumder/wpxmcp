---
name: gutenberg
title: Writing Gutenberg block markup
description: How to author valid block-editor content so WordPress does not flag it as invalid, including the delimiter rules and the common blocks.
keywords: gutenberg, block, blocks, block editor, wp:paragraph, block markup, invalid content, page, post, editor
---

## The rule that matters

Block content is HTML with structured comment delimiters. WordPress parses the comments, then **validates the HTML between them against what the block would render**. A mismatch produces the yellow "This block contains unexpected or invalid content" warning.

```html
<!-- wp:paragraph -->
<p>Body text.</p>
<!-- /wp:paragraph -->
```

Three things break validation more than anything else:

1. **Missing the closing delimiter.** Every non-void block needs `<!-- /wp:name -->`.
2. **Wrong wrapper element or class.** `core/paragraph` must be a bare `<p>`. A heading must be `<h2>` when `"level":2` — and level 2 is the default, so it is *omitted* from the attributes.
3. **Attributes that disagree with the markup.** If you write `{"align":"center"}` you must also emit `class="has-text-align-center"`.

When in doubt, create the block once in the editor, read it back with `get_content` (which returns raw stored markup), and copy the exact shape.

## Blocks you will actually use

```html
<!-- wp:heading -->
<h2 class="wp-block-heading">A level-2 heading</h2>
<!-- /wp:heading -->

<!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">A level-3 heading</h3>
<!-- /wp:heading -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item --><li>One</li><!-- /wp:list-item --><!-- wp:list-item --><li>Two</li><!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:image {"id":42,"sizeSlug":"large","linkDestination":"none"} -->
<figure class="wp-block-image size-large"><img src="https://example.com/wp-content/uploads/2026/01/x.jpg" alt="Describe the image" class="wp-image-42"/></figure>
<!-- /wp:image -->

<!-- wp:quote -->
<blockquote class="wp-block-quote"><!-- wp:paragraph --><p>Quoted text.</p><!-- /wp:paragraph --><cite>Attribution</cite></blockquote>
<!-- /wp:quote -->

<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="/contact/">Get in touch</a></div><!-- /wp:button --></div>
<!-- /wp:buttons -->

<!-- wp:separator -->
<hr class="wp-block-separator has-alpha-channel-opacity"/>
<!-- /wp:separator -->

<!-- wp:spacer {"height":"48px"} -->
<div style="height:48px" aria-hidden="true" class="wp-block-spacer"></div>
<!-- /wp:spacer -->
```

Void blocks — `separator`, `spacer`, `html` when empty — still need their closing delimiter unless written self-closing as `<!-- wp:separator /-->`.

## Layout: columns and groups

```html
<!-- wp:group {"layout":{"type":"constrained"}} -->
<div class="wp-block-group">
  <!-- wp:columns -->
  <div class="wp-block-columns">
    <!-- wp:column {"width":"60%"} -->
    <div class="wp-block-column" style="flex-basis:60%">
      <!-- wp:paragraph --><p>Left.</p><!-- /wp:paragraph -->
    </div>
    <!-- /wp:column -->
    <!-- wp:column {"width":"40%"} -->
    <div class="wp-block-column" style="flex-basis:40%">
      <!-- wp:paragraph --><p>Right.</p><!-- /wp:paragraph -->
    </div>
    <!-- /wp:column -->
  </div>
  <!-- /wp:columns -->
</div>
<!-- /wp:group -->
```

Nesting must be exact: `columns` contains only `column` children, and each `column` wraps its own blocks.

## Working with existing content

- **Read before you edit.** `get_content` returns the raw markup including delimiters. Editing what you *think* is there fails.
- **Use `edits`, not `content`.** `update_content` with `edits: [{find, replace}]` changes one paragraph without risking the rest of the document. A find that matches nothing fails loudly rather than silently writing nothing.
- **Match the delimiters in your `find`.** Searching for `<p>Old text</p>` works; searching for `Old text` may match inside an attribute.

## Third-party blocks

Run `list_block_types` to see exactly what is registered and which attributes each block accepts. Do not guess a plugin's block name or attribute shape — they change between versions.

## When it is not Gutenberg

If the post has `_elementor_data`, `_et_pb_use_builder`, `_fl_builder_data`, `_bricks_page_content_2` or similar meta, the content is owned by a page builder and the `post_content` you see is generated output. Editing it does nothing useful. Load the `page-builders` skill.
