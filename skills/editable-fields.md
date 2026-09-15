---
name: editable-fields
title: Registering editable custom fields
description: Use when adding custom fields, meta boxes or a site-wide settings page so a person can keep editing values (hero text, phone number, gallery) in wp-admin after the build.
keywords: custom fields, fields, meta box, metabox, acf, advanced custom fields, repeater, options page, site options, editable, client can edit, cms fields, post meta, register fields, field group
---

## When this applies

Building or extending a theme whose content must stay editable without code, or exposing existing post meta in wp-admin and REST. Needs the companion plugin.

## Rules

1. `list_field_groups` first; extend an existing group (re-register it with the same `group_key` and the full field list) instead of creating a near-duplicate.
2. Keys are lowercase with underscores, unique per site, and never start with `wpxmcp_`. An options-context key cannot be a protected core option.
3. Templates must render when a field is empty: always fall back.
4. If ACF (or Meta Box, Pods) already manages these fields, keep using that plugin's fields rather than registering parallel ones with the same keys.
5. `delete_field_group` removes only the registration; values stay in post meta or options.

## Procedure

1. `list_field_groups`.
2. `register_fields` with `group_key`, `title`, `context: "post_meta"`, `post_types: ["page"]` and `fields` (or `context: "options"` with no `post_types` for site-wide values, which get a settings page under Settings):

```jsonc
fields: [
  { "key": "hero_heading",  "label": "Heading",     "type": "text", "required": true },
  { "key": "hero_image",    "label": "Background",  "type": "image", "description": "1600×900 or larger" },
  { "key": "hero_cta_text", "label": "Button text", "type": "text", "default": "Get started" },
  { "key": "hero_cta_url",  "label": "Button link", "type": "url" },
  { "key": "plan", "label": "Plan", "type": "select", "choices": [{ "value": "pro", "label": "Pro" }] },
  { "key": "faq", "label": "FAQ", "type": "repeater", "sub_fields": [
      { "key": "question", "label": "Question", "type": "text" },
      { "key": "answer",   "label": "Answer",   "type": "textarea" } ] }
]
```

3. Read the values in the template (classic theme, in a draft):

```php
$heading = get_post_meta( get_the_ID(), 'hero_heading', true );
$image   = (int) get_post_meta( get_the_ID(), 'hero_image', true );
if ( $image ) {
	echo wp_get_attachment_image( $image, 'full', false, array( 'class' => 'w-full object-cover' ) );
}
echo '<h1>' . esc_html( $heading ?: get_the_title() ) . '</h1>';
// Options context: get_option( 'phone_number', '' )
```

4. Fill initial values: `update_content` with `id`, `type` and `meta: {"hero_heading": "…"}` (registered keys are REST-writable), or `set_option` with `name` and `value` for options fields.

## Verify

- `get_content` with `id` and `include_meta: true` shows the keys under `meta`.
- `get_page_html` with `url` and `mode: "text"` shows the value on the page.
- The `admin_url` returned for an options group opens the settings screen; tell the owner where the meta box appears.

## Report back

List each field (label, key, type, where it appears) and where the owner edits it in wp-admin. Note that removing the group later keeps the saved values.

## Reference: field types

`text`, `textarea`, `wysiwyg`, `number` (`min`, `max`), `email`, `url`, `date`, `select`, `checkbox`, `radio` (these three need `choices`), `color`, `image` (attachment id), `gallery` (array of attachment ids), `repeater` (array of rows; `sub_fields` required, no nested repeaters). Fourteen in total.
