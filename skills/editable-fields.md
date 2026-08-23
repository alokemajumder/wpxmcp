---
name: editable-fields
title: Registering editable fields
description: How to wire up custom fields and site options so a human can keep editing the site after you build it.
keywords: fields, custom fields, acf, meta box, options, settings, repeater, editable, cms, client
---

## Why

A theme that only an agent can edit is a liability. As you build, register the fields the client will actually need to change — hero headline, phone number, opening hours, a gallery — so they can edit them in wp-admin without touching code or breaking the layout.

## Register a group

```jsonc
register_fields: {
  group_key: "homepage_hero",
  title: "Hero section",
  context: "post_meta",
  post_types: ["page"],
  fields: [
    { key: "hero_heading",  label: "Heading",    type: "text",     required: true },
    { key: "hero_subtext",  label: "Sub-heading", type: "textarea" },
    { key: "hero_image",    label: "Background",  type: "image",   description: "1600×900 or larger." },
    { key: "hero_cta_text", label: "Button text", type: "text",    default: "Get started" },
    { key: "hero_cta_url",  label: "Button link", type: "url" }
  ]
}
```

Use `context: "options"` (and no `post_types`) for site-wide values such as a phone number or social links.

## The thirteen types

`text`, `textarea`, `wysiwyg`, `number`, `email`, `url`, `date`, `select`, `checkbox`, `radio`, `color`, `image`, `gallery`, `repeater`.

- `select` / `radio` / `checkbox` need `choices: [{value, label}]`.
- `image` and `gallery` store attachment IDs — resolve them with `wp_get_attachment_image()`.
- `repeater` takes `sub_fields` and stores an array of rows.

## Read them in a template

```php
<?php
$heading = get_post_meta( get_the_ID(), 'hero_heading', true );
$image   = (int) get_post_meta( get_the_ID(), 'hero_image', true );
?>
<section class="bg-surface-alt py-20">
  <?php if ( $image ) : ?>
    <?php echo wp_get_attachment_image( $image, 'full', false, array( 'class' => 'w-full rounded-theme object-cover' ) ); ?>
  <?php endif; ?>
  <h1 class="text-4xl font-bold"><?php echo esc_html( $heading ?: get_the_title() ); ?></h1>
</section>
```

Always fall back to something sensible when a field is empty — a half-configured site should still render.

For an options group, use `get_option( 'field_key' )` instead of `get_post_meta()`.

## Rules

1. **Store as standard post meta and options.** The registration data lives with this tooling, but the values are ordinary WordPress data — remove the plugin and the content survives.
2. **Never require a field to make the page render.** Templates must handle empty values.
3. **Check `list_field_groups` before registering.** Extend an existing group rather than creating a near-duplicate.
4. **Fields are exposed to REST automatically**, so `get_content` and `update_content` can read and write them through `meta` once registered.
