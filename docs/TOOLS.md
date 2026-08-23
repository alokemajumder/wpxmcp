# Tool reference

117 tools. Every content, taxonomy, media, user, comment, plugin, theme, appearance and admin tool accepts an optional **`site_id`**; with one site configured it can be omitted.

Tools marked 🔌 require the [companion plugin](COMPANION_PLUGIN.md) — 24 of the 117. The other 93 work against a stock WordPress install with nothing added. Four of those 93 (`site_info`, `get_content_meta`, `list_roles`, `discover_abilities`) work without it but return more when it is present, and say so in their output.

Tools marked ⚠️ are destructive and require explicit confirmation.

---

## Playbooks (4)

Load these before doing substantive work — they encode what the API alone does not tell you.

| Tool | Purpose |
| --- | --- |
| `load_skill` | Load the playbook matching a task description, or one by name |
| `list_skills` | List every available playbook |
| `save_skill` | Save your own conventions so future sessions follow them |
| `delete_skill` | Remove a saved playbook |

Bundled playbooks: `everyday-tasks`, `site-setup`, `gutenberg`, `classic-theme`, `page-builders`, `seo-audit`, `editable-fields`, `design`, `troubleshooting`.

`everyday-tasks` is the one to reach for when a site owner describes an outcome rather than a mechanism — "put the new prices up", "clear the spam", "update my plugins". It covers confirming what they meant, drafting before publishing, and what to say before an irreversible step.

---

## Multi-site (4)

| Tool | Purpose |
| --- | --- |
| `list_sites` | Every configured site, with auth method and writability. Credentials are never returned |
| `get_site` | One site's configuration plus what the install reports about itself |
| `test_site` | Diagnose connectivity, authentication, capabilities and plugin presence |
| `get_audit_log` | The append-only record of every sensitive action taken |

---

## Content (9)

Handles posts, pages and **any** custom post type through one set of tools.

| Tool | Purpose |
| --- | --- |
| `discover_content_types` | Every registered type, its REST base, taxonomies and supports |
| `list_content` | List any type with filtering, search, ordering and pagination |
| `get_content` | One item by ID, including the raw stored body |
| `get_content_summary` | Minimal summary for audits — no body. Accepts an id or a URL |
| `get_content_by_slug` | Search a slug across every content type at once |
| `find_content_by_url` | Resolve any front-end URL to its content, and optionally update it in the same call |
| `create_content` | Create anything. **Defaults to draft** |
| `update_content` | Update anything, wholesale or with targeted `edits` |
| `delete_content` ⚠️ | Trash by default; permanent needs `force` **and** `confirm` |

### Targeted edits

```jsonc
update_content: {
  id: 42,
  edits: [
    { "find": "<p>Old price: $10</p>", "replace": "<p>New price: $12</p>" }
  ]
}
```

Changes one paragraph without re-sending the document. A `find` that matches nothing **fails loudly**; a `find` that matches more than once is rejected as ambiguous unless you pass `all: true`.

---

## Taxonomies (8)

| Tool | Purpose |
| --- | --- |
| `discover_taxonomies` | Every taxonomy, its REST base and which types it applies to |
| `list_terms` | List terms with search, hierarchy filtering and pagination |
| `get_term` | One term by ID |
| `create_term` | Create a term in any taxonomy |
| `update_term` | Update name, slug, description, parent or meta |
| `delete_term` ⚠️ | Previews what is affected; requires `confirm` |
| `assign_terms_to_content` | Assign by ID or name (unknown names are created); replace, add or remove |
| `get_content_terms` | Every term on an item, grouped by taxonomy and fully resolved |

---

## Media (7)

| Tool | Purpose |
| --- | --- |
| `list_media` | List with search and type filtering; `missing_alt_text` for accessibility sweeps |
| `get_media` | One item with dimensions, sizes and attachment |
| `create_media` | Upload from `file_path`, `url`, or `base64_data` |
| `update_media` | Change title, alt text, caption, description or attachment |
| `edit_media` | Legacy alias of `update_media` |
| `delete_media` ⚠️ | Removes the file from disk; requires `confirm` |
| `search_stock_photos` | Search Unsplash or Pexels, with the required attribution |

### Upload workflows

**A local screenshot** (local stdio server only — the path is read on the machine running the server):

```jsonc
create_media: {
  "file_path": "~/Desktop/Screenshot 2026-08-23 at 2.29.04 PM.png",
  "title": "Dashboard overview",
  "alt_text": "The analytics dashboard showing traffic for August"
}
```

**From a remote URL** — downloaded by the server, then uploaded to WordPress with its full image pipeline:

```jsonc
create_media: {
  "url": "https://images.example.com/hero.jpg",
  "alt_text": "A red bicycle against a brick wall",
  "set_as_featured_for": 42
}
```

**Stock photo, end to end:** `search_stock_photos` → pass the result's `download_url` and `attribution` to `create_media`.

---

## Users (6)

| Tool | Purpose |
| --- | --- |
| `list_users` | List with search, role filtering and pagination |
| `get_user` | One user by ID, or `"me"` |
| `create_user` | Create a user with a chosen role |
| `update_user` | Update profile, email, password or roles |
| `delete_user` ⚠️ | Permanent; previews their content and needs `reassign_to` |
| `list_roles` | Registered roles and their notable capabilities |

---

## Comments (6)

| Tool | Purpose |
| --- | --- |
| `list_comments` | Filter by post, status, author and date |
| `get_comment` | One comment with its full text |
| `create_comment` | Post a comment or a threaded reply |
| `update_comment` | Edit text, author details or moderation status |
| `delete_comment` ⚠️ | Trash by default |
| `moderate_comments` | Approve, hold, spam or trash many at once |

---

## Plugins (9)

| Tool | Purpose |
| --- | --- |
| `list_plugins` | Everything installed, with activation state and updates |
| `get_plugin` | One plugin's details |
| `activate_plugin` | Activate |
| `deactivate_plugin` | Deactivate |
| `install_plugin` | Install from WordPress.org, optionally activating |
| `create_plugin` | The REST API's own name for install |
| `delete_plugin` ⚠️ | Removes files; requires `confirm` |
| `search_plugins` | Search the .org repository with ratings, installs and last-updated |
| `get_plugin_info` | Full repository detail, including the changelog |

---

## Themes and design (15)

| Tool | Purpose |
| --- | --- |
| `list_themes` | Installed themes, active state, block-theme status |
| `get_theme` | One theme's details and declared supports |
| `activate_theme` ⚠️ | Switch the live theme; requires `confirm` |
| `install_theme` 🔌 | Install from WordPress.org |
| `create_draft_theme` 🔌 | Clone a theme into an isolated draft |
| `create_classic_theme` 🔌 | Scaffold a complete classic PHP + Tailwind theme |
| `list_theme_files` 🔌 | The file tree, with sizes |
| `read_theme_file` 🔌 | Read a file |
| `write_theme_file` 🔌 | Write a file; refuses live themes; PHP is linted first |
| `edit_theme_file` 🔌 | Targeted find/replace inside a file |
| `delete_theme_file` 🔌 ⚠️ | Delete a file from a draft |
| `get_preview_url` 🔌 | A private tokenised URL rendering the draft |
| `publish_draft_theme` 🔌 ⚠️ | Go live, backing up the previous theme |
| `delete_draft_theme` 🔌 ⚠️ | Discard a draft |
| `list_draft_themes` 🔌 | Existing drafts and their origins |

### The theme workflow

```
create_draft_theme  →  write/edit files  →  get_preview_url  →  publish_draft_theme
       ↑                                                              ↓
   live site untouched throughout                          previous theme backed up
```

`create_classic_theme` writes a complete starter: `header.php`, `footer.php`, `index.php`, `single.php`, `page.php`, `archive.php`, `search.php`, `404.php`, `comments.php`, `searchform.php`, `sidebar.php`, `template-parts/`, `inc/`, and a `theme.css` holding every design token. Tailwind is wired to those tokens in `functions.php`, so restyling means editing one file.

---

## Appearance (23)

**Menus (9)** — `list_menus`, `get_menu`, `create_menu`, `update_menu`, `delete_menu` ⚠️, `add_menu_item`, `update_menu_item`, `delete_menu_item`, `reorder_menu_items`

`get_menu` renders the hierarchy as an indented tree rather than a flat list with parent ids.

**Widgets (5)** — `list_sidebars`, `list_widgets`, `create_widget`, `update_widget`, `delete_widget` ⚠️

**Block themes (7)** — `list_templates`, `get_template`, `update_template`, `get_global_styles`, `update_global_styles`, `list_block_types`, `list_reusable_blocks`

**Customizer (2)** 🔌 — `get_theme_mods`, `set_theme_mod`

---

## Site configuration and intelligence (11)

| Tool | Purpose |
| --- | --- |
| `get_site_settings` | Title, tagline, timezone, formats, front page, comment policy |
| `update_site_settings` | Change them, with before/after reporting and warnings |
| `site_info` | Versions, PHP, active theme, plugins, database size, health, updates |
| `get_page_html` | The rendered HTML a visitor receives. Modes: `html`, `text`, `head`, `summary` |
| `search_site` | Search every searchable type at once |
| `list_revisions` | Stored revisions of an item |
| `restore_revision` | Roll back to an earlier version (itself reversible) |
| `get_content_meta` 🔌 | Read custom fields, including keys `show_in_rest` hides |
| `set_content_meta` 🔌 | Write any meta key, including unregistered ones |
| `rest_api` | Call any REST endpoint — the escape hatch for plugin routes |
| `discover_rest_routes` | What the site actually registers. Use before `rest_api` |

`get_page_html` with `mode: "summary"` reports title, meta description, canonical, OG tags, heading structure, h1 count, and alt-text coverage — an SEO snapshot in one call.

---

## Power tools (12)

**WP-CLI (2)** 🔌 — `list_cli_commands`, `run_wp_cli`

50+ commands emulated in PHP. No binary, no SSH, no shell. Default-deny allowlist; `search-replace` always dry-runs before it will write.

**SQL (1)** 🔌 — `execute_sql_query`

SELECT-only with an enforced row limit. Mutations need `allow_mutation: true`, a `confirm_token` from the preview, **and** `WPXMCP_ALLOW_SQL_WRITES` in `wp-config.php`. Stacked statements are always refused.

**Abilities API (3)** — `discover_abilities`, `get_ability_info`, `run_ability`

The right way to write data a plugin owns: its validation, hooks and cache invalidation all run.

**Snippets (1)** 🔌 — `code_snippet`

PHP, CSS and JS without touching theme files. Always created **disabled**; a human enables them in wp-admin.

**Editable fields (3)** 🔌 — `register_fields`, `list_field_groups`, `delete_field_group`

Thirteen field types rendering as native meta boxes or a settings page, auto-exposed to REST, stored as ordinary post meta and options.

**Options (2)** 🔌 — `get_options`, `set_option`

---

## Bulk and audit (3)

| Tool | Purpose |
| --- | --- |
| `bulk_update_content` | Change many items at once — always previews first |
| `audit_content` | Missing SEO fields, thin content, duplicate titles, missing alt text, h1 problems |
| `audit_media` | Images without alt text, and attachments nothing references |

`bulk_update_content` returns a per-item plan plus a single-use `confirm_token` bound to those exact arguments. Change any argument and the token stops matching.
